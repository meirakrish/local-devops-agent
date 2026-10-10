import type { V1EndpointSlice, V1Pod, V1Service } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { detectIssues } from "../src/scan/detect.js";
import { podCreateFailures } from "../src/scan/scan.js";
import { podWorkload, summarizePod, summarizeService } from "../src/scan/summarize.js";
import type { ClusterOverview, EventSummary, ServiceSummary, WorkloadSummary } from "../src/scan/types.js";
import { dnsIssues, podCreateFailureIssues, serviceIssues, workloadIssues } from "../src/scan/workload-rules.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function pod(
  name: string,
  labels: Record<string, string>,
  ready: boolean,
  opts: { createdMinutesAgo?: number; rs?: string } = {},
): V1Pod {
  return {
    metadata: {
      name,
      namespace: "shop",
      labels,
      creationTimestamp: minutesAgo(opts.createdMinutesAgo ?? 60),
      ownerReferences: opts.rs
        ? [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: opts.rs, uid: "1", controller: true }]
        : undefined,
    },
    spec: { containers: [{ name: "app" }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          image: "app:1",
          imageID: "",
          ready,
          restartCount: ready ? 0 : 4,
          state: ready ? { running: {} } : { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
  };
}

const service = (name: string, selector: Record<string, string>, namespace = "shop"): V1Service => ({
  metadata: { name, namespace },
  spec: { selector, ports: [{ port: 80 }] },
});

const slice = (service: string, ready: boolean[], namespace = "shop"): V1EndpointSlice => ({
  addressType: "IPv4",
  metadata: { name: `${service}-abc`, namespace, labels: { "kubernetes.io/service-name": service } },
  endpoints: ready.map((r, i) => ({ addresses: [`10.0.0.${i}`], conditions: { ready: r } })),
});

const webPods = [
  pod("web-7db8d69f68-aaaaa", { app: "web", "pod-template-hash": "7db8d69f68" }, false, { rs: "web-7db8d69f68" }),
  pod("web-7db8d69f68-bbbbb", { app: "web", "pod-template-hash": "7db8d69f68" }, false, { rs: "web-7db8d69f68" }),
];

describe("pod workload", () => {
  it("maps a ReplicaSet pod to its Deployment using the pod-template-hash", () => {
    expect(podWorkload(webPods[0]!)).toBe("web");
    expect(summarizePod(webPods[0]!).workload).toBe("web");
  });

  it("uses the owner name for other controllers", () => {
    const p = pod("db-0", {}, true);
    p.metadata!.ownerReferences = [
      { apiVersion: "apps/v1", kind: "StatefulSet", name: "db", uid: "1", controller: true },
    ];
    expect(podWorkload(p)).toBe("db");
  });
});

describe("service rules", () => {
  it("skips Services without a selector", () => {
    expect(summarizeService(service("external", {}), [], [])).toBeUndefined();
  });

  it("flags a selector that matches no pods and shows the label values pods actually have", () => {
    const s = summarizeService(
      service("frontend", { app: "fronted" }),
      [],
      [pod("frontend-1", { app: "frontend" }, true), ...webPods],
    )!;
    const [issue, ...rest] = serviceIssues(s, NOW);
    expect(rest).toHaveLength(0);
    expect(issue?.severity).toBe("warning");
    expect(issue?.category).toBe("service-no-pods");
    expect(issue?.evidence).toEqual([
      "selector app=fronted matches no running pods in namespace shop",
      "label values on running pods in shop: app: frontend, web",
    ]);
  });

  it("is critical when pods match but none is ready, and ties the issue to their workload", () => {
    const s = summarizeService(service("web", { app: "web" }), [slice("web", [false, false])], webPods)!;
    expect(s.readyEndpoints).toBe(0);
    expect(s.notReadyEndpoints).toBe(2);
    const [issue] = serviceIssues(s, NOW);
    expect(issue?.severity).toBe("critical");
    expect(issue?.category).toBe("service-no-ready-endpoints");
    expect(issue?.workload).toBe("shop/web");
    expect(issue?.evidence[0]).toContain("web-7db8d69f68-aaaaa (CrashLoopBackOff)");
  });

  it("ignores healthy Services, endpoint slices of other Services, and pods that are still starting", () => {
    const healthy = summarizeService(
      service("web", { app: "web" }),
      [slice("web", [true, false]), slice("other", [false])],
      webPods,
    )!;
    expect(healthy.readyEndpoints).toBe(1);
    expect(healthy.notReadyEndpoints).toBe(1);
    expect(serviceIssues(healthy, NOW)).toEqual([]);

    const starting = summarizeService(
      service("web", { app: "web" }),
      [],
      [pod("web-1", { app: "web" }, false, { createdMinutesAgo: 1 })],
    )!;
    expect(serviceIssues(starting, NOW)).toEqual([]);
  });

  it("does not count Succeeded or Failed pods as selected", () => {
    const done = pod("job-1", { app: "web" }, false);
    done.status!.phase = "Succeeded";
    const s = summarizeService(service("web", { app: "web" }), [], [done])!;
    expect(s.pods).toEqual([]);
  });
});

describe("cluster DNS rule", () => {
  const dnsService = (ready: number, notReady: number, pods: ServiceSummary["pods"] = []): ServiceSummary => ({
    namespace: "kube-system",
    name: "kube-dns",
    type: "ClusterIP",
    selector: { "k8s-app": "kube-dns" },
    readyEndpoints: ready,
    notReadyEndpoints: notReady,
    pods,
    podLabelValues: {},
  });

  it("is critical when kube-dns has no ready endpoints", () => {
    const pods = [
      { name: "coredns-abc-1", ready: false, phase: "Running", reason: "CrashLoopBackOff", workload: "coredns" },
    ];
    const [issue] = dnsIssues({ service: dnsService(0, 2, pods) });
    expect(issue?.severity).toBe("critical");
    expect(issue?.category).toBe("dns-down");
    expect(issue?.title).toContain("Cluster DNS is down");
    expect(issue?.evidence[0]).toBe("DNS pods: coredns-abc-1 (CrashLoopBackOff)");
    expect(issue?.workload).toBe("kube-system/coredns");
  });

  it("warns when only some endpoints are ready, and is silent when all are", () => {
    expect(dnsIssues({ service: dnsService(1, 1) })[0]?.category).toBe("dns-degraded");
    expect(dnsIssues({ service: dnsService(2, 0) })).toEqual([]);
    expect(dnsIssues({ notVisible: "no Service kube-system/kube-dns" })).toEqual([]);
  });
});

describe("DaemonSet and StatefulSet rules", () => {
  const ds: WorkloadSummary = {
    kind: "DaemonSet",
    namespace: "kube-system",
    name: "kube-proxy",
    desired: 3,
    ready: 2,
    updated: 3,
  };

  it("warns when some DaemonSet pods are not ready and mentions networking in kube-system", () => {
    const [issue] = workloadIssues(ds);
    expect(issue?.id).toBe("daemonset/kube-system/kube-proxy:unavailable");
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe("DaemonSet kube-system/kube-proxy has 2/3 pods ready");
    expect(issue?.hint).toContain("lose networking");
    expect(issue?.workload).toBe("kube-system/kube-proxy");
  });

  it("is critical with no ready pods and shows a StatefulSet's rollout state", () => {
    const [issue] = workloadIssues({
      kind: "StatefulSet",
      namespace: "shop",
      name: "db",
      desired: 3,
      ready: 0,
      updated: 1,
      currentRevision: "db-6f9",
      updateRevision: "db-7a1",
    });
    expect(issue?.severity).toBe("critical");
    expect(issue?.evidence[1]).toBe("rollout in progress: 1/3 pods on revision db-7a1 (current db-6f9)");
  });

  it("ignores healthy and scaled-to-zero workloads", () => {
    expect(workloadIssues({ ...ds, ready: 3 })).toEqual([]);
    expect(workloadIssues({ ...ds, desired: 0, ready: 0 })).toEqual([]);
  });
});

describe("pod creation failures", () => {
  const event = (
    kind: string,
    name: string,
    message: string,
    lastSeen = minutesAgo(5).toISOString(),
    count = 3,
  ): EventSummary => ({
    namespace: "shop",
    involvedKind: kind,
    involvedName: name,
    reason: "FailedCreate",
    message,
    count,
    lastSeen,
  });

  it("explains the cause and ties a ReplicaSet to its Deployment", () => {
    const [issue] = podCreateFailureIssues([
      event(
        "ReplicaSet",
        "api-5f6d7c8b9",
        'Error creating: pods "api-5f6d7c8b9-x" is forbidden: exceeded quota: compute, requested: requests.cpu=2, used: requests.cpu=3, limited: requests.cpu=4',
      ),
    ]);
    expect(issue?.id).toBe("replicaset/shop/api-5f6d7c8b9:create-failed");
    expect(issue?.severity).toBe("critical");
    expect(issue?.title).toBe("ReplicaSet shop/api-5f6d7c8b9 cannot create pods: ResourceQuota exceeded");
    expect(issue?.workload).toBe("shop/api");
  });

  it("recognizes Pod Security, webhooks and missing service accounts", () => {
    const titles = podCreateFailureIssues([
      event("ReplicaSet", "a-5f6d7c8b9", 'pods "a" is forbidden: violates PodSecurity "baseline:latest": privileged'),
      event(
        "DaemonSet",
        "b",
        'Internal error occurred: failed calling webhook "x.example.com": no endpoints available',
      ),
      event("StatefulSet", "c", 'admission webhook "policy.example.com" denied the request: images must be signed'),
      event(
        "Job",
        "d",
        'pods "d-1" is forbidden: error looking up service account shop/backup: serviceaccount "backup" not found',
      ),
    ]).map((i) => i.title.split(": ").slice(1).join(": "));
    expect(titles).toEqual([
      "rejected by Pod Security admission",
      "admission webhook unreachable",
      "denied by an admission webhook",
      "ServiceAccount missing",
    ]);
  });

  it("makes one issue per controller, with the latest message and the total count", () => {
    const issues = podCreateFailureIssues([
      event("ReplicaSet", "api-5f6d7c8b9", "old message", minutesAgo(30).toISOString(), 2),
      event("ReplicaSet", "api-5f6d7c8b9", "exceeded quota: compute", minutesAgo(2).toISOString(), 5),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.evidence[0]).toMatch(/^FailedCreate x7, last at .*: exceeded quota: compute$/);
  });

  it("keeps only FailedCreate events of pod controllers within the window", () => {
    const kept = podCreateFailures(
      [
        event("ReplicaSet", "a-5f6d7c8b9", "x"),
        event("ReplicaSet", "b-5f6d7c8b9", "x", minutesAgo(120).toISOString()),
        { ...event("Pod", "c", "x"), reason: "FailedCreatePodSandBox" },
        { ...event("ReplicaSet", "d-5f6d7c8b9", "x"), reason: "BackOff" },
      ],
      NOW,
      60,
    );
    expect(kept.map((e) => e.involvedName)).toEqual(["a-5f6d7c8b9"]);
  });
});

describe("detectIssues with workloads, services and DNS", () => {
  const base: ClusterOverview = {
    context: "test",
    scannedAt: NOW.toISOString(),
    namespaces: ["shop"],
    nodes: [],
    pods: [],
    deployments: [],
    workloads: [],
    services: [],
    dns: {},
    warningEvents: [],
    podCreateFailures: [],
    controlPlane: { notVisible: [] },
    webhooks: [],
    errors: [],
  };
  const noPods = (namespace: string, name: string): ServiceSummary => ({
    namespace,
    name,
    type: "ClusterIP",
    selector: { app: name },
    readyEndpoints: 0,
    notReadyEndpoints: 0,
    pods: [],
    podLabelValues: { app: [] },
  });

  it("leaves Services behind a webhook or cluster DNS to their own rules", () => {
    const issues = detectIssues(
      {
        ...base,
        services: [noPods("shop", "policy"), noPods("kube-system", "kube-dns"), noPods("shop", "orphan")],
        dns: { service: noPods("kube-system", "kube-dns") },
        webhooks: [
          {
            kind: "Validating",
            configName: "p",
            name: "w",
            failurePolicy: "Fail",
            service: { namespace: "shop", name: "policy" },
            status: "no-ready-endpoints",
          },
        ],
      },
      { restartThreshold: 5, now: NOW, windowMinutes: 60 },
    );
    expect(issues.map((i) => i.id).sort()).toEqual([
      "service/kube-system/kube-dns:dns-down",
      "service/shop/orphan:no-pods",
      "webhook/p/w:unavailable",
    ]);
  });

  it("drops a FailedCreate issue once its Deployment is fully ready", () => {
    const failure: EventSummary = {
      namespace: "shop",
      involvedKind: "ReplicaSet",
      involvedName: "api-5f6d7c8b9",
      reason: "FailedCreate",
      message: "exceeded quota",
      count: 1,
      lastSeen: minutesAgo(5).toISOString(),
    };
    const deployment = (ready: number) => ({
      namespace: "shop",
      name: "api",
      desired: 2,
      ready,
      available: ready,
      updated: 2,
      conditions: [],
    });
    const run = (ready: number) =>
      detectIssues(
        { ...base, deployments: [deployment(ready)], podCreateFailures: [failure] },
        { restartThreshold: 5, now: NOW, windowMinutes: 60 },
      ).map((i) => i.category);
    expect(run(2)).toEqual([]);
    expect(run(0).sort()).toEqual(["pod-create-failed", "replicas-unavailable"]);
  });
});
