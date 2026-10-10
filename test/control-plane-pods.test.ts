import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "../src/report/markdown.js";
import { summarizeControlPlanePods } from "../src/scan/collect-cluster.js";
import { controlPlanePodIssues } from "../src/scan/cluster-rules.js";
import { detectIssues } from "../src/scan/detect.js";
import { summarizePod } from "../src/scan/summarize.js";
import type { ClusterOverview, ControlPlanePod } from "../src/scan/types.js";

// Shaped like the incident seen on the kind demo cluster: the API server's probes failed
// with HTTP 500, then the scheduler lost leader election and restarted with exit code 1.
const NOW = new Date("2026-10-09T13:05:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function cpPod(component: string, status: V1Pod["status"]): V1Pod {
  return {
    metadata: {
      name: `${component}-cp-1`,
      namespace: "kube-system",
      labels: { component, tier: "control-plane" },
    },
    spec: { nodeName: "cp-1", containers: [{ name: component }] },
    status,
  };
}

const running = (restartCount = 0, lastTerminated?: { reason: string; exitCode: number; finishedAt: Date }) => ({
  phase: "Running",
  containerStatuses: [
    {
      name: "c",
      image: "i",
      imageID: "",
      ready: true,
      restartCount,
      state: { running: { startedAt: ago(10) } },
      lastState: lastTerminated ? { terminated: lastTerminated } : {},
    },
  ],
});

function unhealthy(pod: string, message: string, count: number, minutesAgo: number): CoreV1Event {
  return {
    metadata: { namespace: "kube-system" },
    involvedObject: { kind: "Pod", name: pod, namespace: "kube-system" },
    reason: "Unhealthy",
    type: "Warning",
    message,
    count,
    lastTimestamp: ago(minutesAgo),
  };
}

describe("summarizeControlPlanePods", () => {
  it("collects restarts and probe failures within the window", () => {
    const pods = summarizeControlPlanePods(
      [
        cpPod("kube-apiserver", running()),
        cpPod("kube-scheduler", running(2, { reason: "Error", exitCode: 1, finishedAt: ago(16) })),
      ],
      [
        unhealthy("kube-apiserver-cp-1", "Readiness probe failed: HTTP probe failed with statuscode: 500", 35, 16),
        unhealthy("kube-apiserver-cp-1", "Liveness probe failed: HTTP probe failed with statuscode: 500", 13, 16),
        unhealthy("kube-apiserver-cp-1", "Liveness probe failed: old", 99, 600), // outside the window
      ],
      NOW,
      60,
    );
    expect(pods.map((p) => p.component)).toEqual(["kube-apiserver", "kube-scheduler"]);
    expect(pods[0]?.probeFailures).toMatchObject({ count: 48, kinds: ["Readiness", "Liveness"] });
    expect(pods[1]?.lastRestart).toEqual({ finishedAt: ago(16).toISOString(), reason: "Error", exitCode: 1 });
    expect(pods[1]?.probeFailures).toBeUndefined();
  });
});

describe("controlPlanePodIssues", () => {
  const base: ControlPlanePod = {
    name: "kube-scheduler-cp-1",
    component: "kube-scheduler",
    nodeName: "cp-1",
    phase: "Running",
    ready: true,
    restarts: 0,
  };

  it("finds nothing for a healthy component", () => {
    expect(controlPlanePodIssues([base], NOW, 60)).toEqual([]);
  });

  it("warns about a restart within the window, with a component-specific hint", () => {
    const [issue] = controlPlanePodIssues(
      [{ ...base, restarts: 2, lastRestart: { finishedAt: ago(16).toISOString(), reason: "Error", exitCode: 1 } }],
      NOW,
      60,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe("Control-plane component kube-scheduler restarted 16 min ago");
    expect(issue?.evidence[0]).toBe("last restart 16 min ago (Error, exit code 1); 2 restart(s) in total");
    expect(issue?.hint).toContain("leaderelection lost");
    // Pointing at the pod lets the LLM use describe/logs on it.
    expect(issue?.resource).toEqual({ kind: "Pod", namespace: "kube-system", name: "kube-scheduler-cp-1" });
  });

  it("ignores restarts older than the window", () => {
    const old = { ...base, restarts: 5, lastRestart: { finishedAt: ago(600).toISOString(), reason: "Error", exitCode: 1 } };
    expect(controlPlanePodIssues([old], NOW, 60)).toEqual([]);
  });

  it("warns about repeated probe failures but ignores a single blip", () => {
    const probes = (count: number) => ({
      ...base,
      component: "kube-apiserver",
      name: "kube-apiserver-cp-1",
      probeFailures: { count, lastSeen: ago(5).toISOString(), kinds: ["Readiness"], lastMessage: "Readiness probe failed: HTTP probe failed with statuscode: 500" },
    });
    expect(controlPlanePodIssues([probes(1)], NOW, 60)).toEqual([]);
    const [issue] = controlPlanePodIssues([probes(48)], NOW, 60);
    expect(issue?.category).toBe("controlplane-probe-failures");
    expect(issue?.hint).toContain("etcd");
  });

  it("is critical while the component is down", () => {
    const [issue] = controlPlanePodIssues([{ ...base, ready: false, stateReason: "CrashLoopBackOff" }], NOW, 60);
    expect(issue?.severity).toBe("critical");
    expect(issue?.title).toBe("Control-plane component kube-scheduler is not ready (CrashLoopBackOff)");
  });
});

describe("control-plane pods in detectIssues and the report", () => {
  const crashing = cpPod("kube-scheduler", {
    phase: "Running",
    containerStatuses: [
      {
        name: "c",
        image: "i",
        imageID: "",
        ready: false,
        restartCount: 6,
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: ago(1) } },
      },
    ],
  });
  const overview: ClusterOverview = {
    context: "test",
    scannedAt: NOW.toISOString(),
    namespaces: [],
    nodes: [],
    pods: [summarizePod({ ...crashing, metadata: { ...crashing.metadata, creationTimestamp: ago(120) } })],
    deployments: [],
    workloads: [],
    services: [],
    dns: {},
    podCreateFailures: [],
    warningEvents: [],
    controlPlane: { pods: summarizeControlPlanePods([crashing], [], NOW, 60), notVisible: [] },
    webhooks: [],
    errors: [],
  };

  it("reports a crashing control-plane pod once, from the control-plane rule", () => {
    const issues = detectIssues(overview, { restartThreshold: 5, now: NOW });
    expect(issues.map((i) => i.category)).toEqual(["controlplane-pod-down"]);
    expect(issues[0]?.evidence[0]).toContain("CrashLoopBackOff");
  });

  it("shows a summary row, or 'not visible' on managed clusters", () => {
    const issues = detectIssues(overview, { restartThreshold: 5, now: NOW });
    expect(renderMarkdownReport({ overview, issues })).toContain("| Control-plane pods | 0/1 ready |");
    const managed = { ...overview, controlPlane: { notVisible: ["control-plane pods: none found in kube-system (managed control plane?)"] } };
    expect(renderMarkdownReport({ overview: managed, issues: [] })).toContain("| Control-plane pods | not visible |");
  });
});
