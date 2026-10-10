import type { V1PersistentVolumeClaim, V1Pod, V1StorageClass } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { detectIssues } from "../src/scan/detect.js";
import { storageEvents } from "../src/scan/scan.js";
import { podVolumeIssues, pvcIssues } from "../src/scan/storage-rules.js";
import { summarizePod, summarizePvc } from "../src/scan/summarize.js";
import type { ClusterOverview, EventSummary, PodSummary, PvcSummary } from "../src/scan/types.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const classes: V1StorageClass[] = [
  {
    metadata: { name: "standard", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
    provisioner: "rancher.io/local-path",
    volumeBindingMode: "WaitForFirstConsumer",
  },
  { metadata: { name: "fast" }, provisioner: "ebs.csi.aws.com", volumeBindingMode: "Immediate" },
];

const rawPvc = (storageClassName?: string, phase = "Pending"): V1PersistentVolumeClaim => ({
  metadata: { name: "data", namespace: "shop", creationTimestamp: new Date(minutesAgo(30)) },
  spec: { storageClassName, resources: { requests: { storage: "1Gi" } } },
  status: { phase },
});

function pvc(opts: Partial<PvcSummary> = {}): PvcSummary {
  return {
    namespace: "shop",
    name: "data",
    phase: "Pending",
    storageClass: "fast",
    createdAt: minutesAgo(30),
    requested: "1Gi",
    waitForFirstConsumer: false,
    ...opts,
  };
}

function pod(name: string, opts: Partial<PodSummary> = {}): PodSummary {
  return {
    namespace: "shop",
    name,
    phase: "Pending",
    workload: "db",
    createdAt: minutesAgo(30),
    readyContainers: 0,
    totalContainers: 1,
    restarts: 0,
    containers: [{ name: "db", init: false, ready: false, restarts: 0, state: "waiting", reason: "ContainerCreating" }],
    requests: {},
    claims: ["data"],
    ...opts,
  };
}

const event = (kind: string, name: string, reason: string, message: string, ago = 2): EventSummary => ({
  namespace: "shop",
  involvedKind: kind,
  involvedName: name,
  reason,
  message,
  count: 4,
  lastSeen: minutesAgo(ago),
});

describe("summarizePvc", () => {
  it("resolves the default class and its binding mode", () => {
    expect(summarizePvc(rawPvc(undefined), classes)).toMatchObject({ waitForFirstConsumer: true });
    expect(summarizePvc(rawPvc("fast"), classes)).toMatchObject({ waitForFirstConsumer: false });
    // The DefaultStorageClass admission plugin usually fills in the default's name.
    expect(summarizePvc(rawPvc("standard"), classes)).toMatchObject({
      storageClass: "standard",
      waitForFirstConsumer: true,
      requested: "1Gi",
    });
  });

  it("says when the requested StorageClass does not exist", () => {
    expect(summarizePvc(rawPvc("does-not-exist"), classes).storageClassProblem).toBe(
      'StorageClass "does-not-exist" does not exist (existing: standard, fast)',
    );
  });

  it("says when no class is named and none is default, or static binding has no volume", () => {
    expect(summarizePvc(rawPvc(undefined), [classes[1]!]).storageClassProblem).toBe(
      "no storageClassName and no default StorageClass",
    );
    expect(summarizePvc(rawPvc(""), classes).storageClassProblem).toContain("no dynamic provisioning");
  });

  it("does not guess when StorageClasses are not visible, and skips bound claims", () => {
    expect(summarizePvc(rawPvc("does-not-exist"), undefined).storageClassProblem).toBeUndefined();
    expect(summarizePvc(rawPvc("does-not-exist", "Bound"), classes).storageClassProblem).toBeUndefined();
  });

  it("records the claims a pod mounts", () => {
    const p: V1Pod = {
      metadata: { name: "db-0", namespace: "shop" },
      spec: {
        containers: [{ name: "db" }],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "data-db-0" } },
          { name: "tmp", emptyDir: {} },
        ],
      },
    };
    expect(summarizePod(p).claims).toEqual(["data-db-0"]);
  });
});

describe("PVC rules", () => {
  it("flags a claim with a missing StorageClass as critical when a pod waits for it, tied to that pod's workload", () => {
    const missing = pvc({ storageClass: "nope", storageClassProblem: 'StorageClass "nope" does not exist' });
    const [issue] = pvcIssues(missing, [pod("db-0")], [], NOW);
    expect(issue).toMatchObject({
      id: "pvc/shop/data:pending",
      severity: "critical",
      category: "pvc-pending",
      resource: { kind: "PersistentVolumeClaim", namespace: "shop", name: "data" },
      title: 'PersistentVolumeClaim shop/data is not bound: StorageClass "nope" does not exist',
      workload: "shop/db",
    });
    expect(issue?.evidence).toEqual([
      "Pending for 30 min (storageClass nope, requests 1Gi)",
      'StorageClass "nope" does not exist',
      "used by pod(s) db-0, which cannot start without it",
    ]);
    expect(issue?.hint).toContain("Create the missing StorageClass");
  });

  it("is a warning when no pod uses the claim, and quotes ProvisioningFailed", () => {
    const failure = event("PersistentVolumeClaim", "data", "ProvisioningFailed", "failed to provision volume: quota");
    const [issue] = pvcIssues(pvc(), [], [failure], NOW);
    expect(issue?.severity).toBe("warning");
    expect(issue?.workload).toBeUndefined();
    expect(issue?.evidence).toContain("ProvisioningFailed x4, last 2 min ago: failed to provision volume: quota");
    expect(issue?.hint).toContain("ProvisioningFailed");
  });

  it("skips young claims, bound claims and unused WaitForFirstConsumer claims", () => {
    expect(pvcIssues(pvc({ createdAt: minutesAgo(1) }), [pod("db-0")], [], NOW)).toEqual([]);
    expect(pvcIssues(pvc({ phase: "Bound" }), [pod("db-0")], [], NOW)).toEqual([]);
    expect(pvcIssues(pvc({ waitForFirstConsumer: true }), [], [], NOW)).toEqual([]);
    // ...but a WaitForFirstConsumer claim a pod already uses should have bound.
    expect(pvcIssues(pvc({ waitForFirstConsumer: true }), [pod("db-0")], [], NOW)).toHaveLength(1);
    // Finished pods do not count as users.
    expect(pvcIssues(pvc({ waitForFirstConsumer: true }), [pod("db-0", { phase: "Succeeded" })], [], NOW)).toEqual([]);
  });

  it("flags a Lost claim as critical", () => {
    const [issue] = pvcIssues(pvc({ phase: "Lost", volumeName: "pv-1" }), [pod("db-0")], [], NOW);
    expect(issue).toMatchObject({ id: "pvc/shop/data:lost", severity: "critical", workload: "shop/db" });
    expect(issue?.evidence[0]).toContain("pv-1 no longer exists");
  });
});

describe("pod volume rules", () => {
  const mountFailed = event(
    "Pod",
    "db-0",
    "FailedMount",
    'MountVolume.SetUp failed for volume "config" : configmap "db-config" not found',
  );

  it("explains a pod stuck in ContainerCreating with its FailedMount event", () => {
    const [issue] = podVolumeIssues(pod("db-0"), [mountFailed], NOW);
    expect(issue).toMatchObject({
      id: "pod/shop/db-0:volume-mount-failed",
      severity: "critical",
      category: "volume-mount-failed",
      title: "Pod shop/db-0 cannot start: a volume cannot be mounted",
      workload: "shop/db",
    });
    expect(issue?.evidence[0]).toBe(
      'FailedMount x4, last 2 min ago: MountVolume.SetUp failed for volume "config" : configmap "db-config" not found',
    );
    expect(issue?.hint).toContain("ConfigMap or Secret");
  });

  it("shows the newest event of each reason and recognizes Multi-Attach", () => {
    const events = [
      event("Pod", "db-0", "FailedMount", "older", 9),
      event("Pod", "db-0", "FailedAttachVolume", 'Multi-Attach error for volume "pvc-1"', 1),
      event("Pod", "db-0", "FailedMount", "Unable to attach or mount volumes: timed out", 3),
    ];
    const [issue] = podVolumeIssues(pod("db-0"), events, NOW);
    expect(issue?.title).toContain("cannot be attached");
    expect(issue?.evidence).toEqual([
      'FailedAttachVolume x4, last 1 min ago: Multi-Attach error for volume "pvc-1"',
      "FailedMount x4, last 3 min ago: Unable to attach or mount volumes: timed out",
      "PersistentVolumeClaims: data",
    ]);
    expect(issue?.hint).toContain("attached to another node");
  });

  it("ignores running pods (the mount eventually worked), young pods and other pods' events", () => {
    expect(podVolumeIssues(pod("db-0", { phase: "Running" }), [mountFailed], NOW)).toEqual([]);
    expect(podVolumeIssues(pod("db-0", { createdAt: minutesAgo(1) }), [mountFailed], NOW)).toEqual([]);
    expect(podVolumeIssues(pod("db-1"), [mountFailed], NOW)).toEqual([]);
  });

  it("collects storage events within the window, uncapped", () => {
    const events = [
      mountFailed,
      event("Pod", "x", "BackOff", "restarting"),
      event("PersistentVolumeClaim", "data", "ProvisioningFailed", "old", 120),
    ];
    expect(storageEvents(events, NOW, 60).map((e) => e.reason)).toEqual(["FailedMount"]);
  });

  it("replaces the generic Pending issue with the volume explanation and groups it with the PVC", () => {
    const base: ClusterOverview = {
      context: "test",
      scannedAt: NOW.toISOString(),
      namespaces: ["shop"],
      nodes: [],
      pods: [pod("db-0")],
      deployments: [],
      workloads: [],
      services: [],
      dns: {},
      warningEvents: [],
      podCreateFailures: [],
      controlPlane: { notVisible: [] },
      webhooks: [],
      jobs: [],
      cronJobs: [],
      persistentVolumeClaims: [pvc({ storageClassProblem: 'StorageClass "fast" does not exist' })],
      storageEvents: [],
      apiHealth: { notVisible: [] },
      errors: [],
    };
    const opts = { restartThreshold: 5, now: NOW, windowMinutes: 60 };
    // Without mount events, the pod gets the generic rule's issue.
    expect(detectIssues(base, opts).map((i) => i.category)).toEqual(["pvc-pending", "pending"]);
    const issues = detectIssues({ ...base, storageEvents: [mountFailed] }, opts);
    expect(issues.map((i) => [i.category, i.workload])).toEqual([
      ["volume-mount-failed", "shop/db"],
      ["pvc-pending", "shop/db"],
    ]);
  });
});
