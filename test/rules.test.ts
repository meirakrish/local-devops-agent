import type { V1ContainerStatus, V1Deployment, V1Node, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { detectIssues, deploymentIssues, nodeIssues, podIssues } from "../src/scan/rules.js";
import { summarizeDeployment, summarizeNode, summarizePod } from "../src/scan/summarize.js";
import type { ClusterOverview } from "../src/scan/types.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const OPTS = { restartThreshold: 5, now: NOW };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function pod(
  status: V1Pod["status"],
  { createdMinutesAgo = 60, name = "web-1" }: { createdMinutesAgo?: number; name?: string } = {},
): V1Pod {
  return {
    metadata: { name, namespace: "shop", creationTimestamp: minutesAgo(createdMinutesAgo) },
    spec: { containers: [{ name: "app" }] },
    status,
  };
}

function container(partial: Partial<V1ContainerStatus>): V1ContainerStatus {
  return { name: "app", image: "app:1", imageID: "", ready: false, restartCount: 0, ...partial };
}

const issuesFor = (p: V1Pod) => podIssues(summarizePod(p), OPTS);

describe("pod rules", () => {
  it("flags CrashLoopBackOff as critical and includes the last exit reason", () => {
    const [issue, ...rest] = issuesFor(
      pod({
        phase: "Running",
        containerStatuses: [
          container({
            restartCount: 12,
            state: { waiting: { reason: "CrashLoopBackOff" } },
            lastState: { terminated: { reason: "Error", exitCode: 1 } },
          }),
        ],
      }),
    );
    expect(rest).toHaveLength(0);
    expect(issue?.severity).toBe("critical");
    expect(issue?.category).toBe("crashloop");
    expect(issue?.evidence[0]).toContain("last exit: Error, code 1");
    // No separate high-restarts finding when it is already a crashloop.
    expect(issue?.evidence).toHaveLength(1);
  });

  it("flags image pull errors", () => {
    const [issue] = issuesFor(
      pod({
        phase: "Pending",
        containerStatuses: [
          container({ state: { waiting: { reason: "ImagePullBackOff", message: "not found" } } }),
        ],
      }),
    );
    expect(issue?.category).toBe("image-pull");
    expect(issue?.severity).toBe("critical");
  });

  it("flags OOMKilled from the previous container state", () => {
    const [issue] = issuesFor(
      pod({
        phase: "Running",
        containerStatuses: [
          container({
            ready: true,
            restartCount: 2,
            state: { running: {} },
            lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
          }),
        ],
      }),
    );
    expect(issue?.category).toBe("oom");
    expect(issue?.severity).toBe("critical");
  });

  it("flags unschedulable pods with the scheduler message", () => {
    const [issue] = issuesFor(
      pod({
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/2 nodes are available: 2 Insufficient memory.",
          },
        ],
      }),
    );
    expect(issue?.category).toBe("unschedulable");
    expect(issue?.evidence[0]).toContain("Insufficient memory");
  });

  it("ignores young Pending pods but flags old ones", () => {
    expect(issuesFor(pod({ phase: "Pending" }, { createdMinutesAgo: 1 }))).toEqual([]);
    expect(issuesFor(pod({ phase: "Pending" }, { createdMinutesAgo: 30 }))[0]?.category).toBe("pending");
  });

  it("flags high restart counts as a warning", () => {
    const [issue] = issuesFor(
      pod({
        phase: "Running",
        containerStatuses: [container({ ready: true, restartCount: 7, state: { running: {} } })],
      }),
    );
    expect(issue?.category).toBe("high-restarts");
    expect(issue?.severity).toBe("warning");
  });

  it("flags running pods that stay not ready", () => {
    const [issue] = issuesFor(
      pod({
        phase: "Running",
        containerStatuses: [container({ ready: false, state: { running: {} } })],
      }),
    );
    expect(issue?.category).toBe("not-ready");
  });

  it("ignores healthy and completed pods", () => {
    expect(
      issuesFor(
        pod({ phase: "Running", containerStatuses: [container({ ready: true, state: { running: {} } })] }),
      ),
    ).toEqual([]);
    expect(issuesFor(pod({ phase: "Succeeded" }))).toEqual([]);
  });
});

describe("node rules", () => {
  const node = (conditions: { type: string; status: string }[], unschedulable = false): V1Node => ({
    metadata: { name: "n1", labels: { "node-role.kubernetes.io/control-plane": "" } },
    spec: { unschedulable },
    status: { conditions },
  });

  it("flags NotReady nodes and pressure conditions", () => {
    const issues = nodeIssues(
      summarizeNode(node([{ type: "Ready", status: "False" }, { type: "MemoryPressure", status: "True" }])),
    );
    expect(issues.map((i) => [i.category, i.severity])).toEqual([
      ["node-not-ready", "critical"],
      ["node-pressure", "warning"],
    ]);
  });

  it("reports cordoned nodes as info and extracts roles", () => {
    const summary = summarizeNode(node([{ type: "Ready", status: "True" }], true));
    expect(summary.roles).toEqual(["control-plane"]);
    expect(nodeIssues(summary).map((i) => i.severity)).toEqual(["info"]);
  });
});

describe("deployment rules", () => {
  const deployment = (replicas: number, ready: number, progressingReason?: string): V1Deployment => ({
    metadata: { name: "api", namespace: "shop" },
    spec: { replicas, selector: {}, template: {} },
    status: {
      readyReplicas: ready,
      conditions: progressingReason
        ? [{ type: "Progressing", status: "False", reason: progressingReason }]
        : [],
    },
  });

  it("is critical when no replicas are ready, warning when some are", () => {
    expect(deploymentIssues(summarizeDeployment(deployment(3, 0)))[0]?.severity).toBe("critical");
    expect(deploymentIssues(summarizeDeployment(deployment(3, 2)))[0]?.severity).toBe("warning");
    expect(deploymentIssues(summarizeDeployment(deployment(3, 3)))).toEqual([]);
  });

  it("ignores deployments scaled to zero", () => {
    expect(deploymentIssues(summarizeDeployment(deployment(0, 0)))).toEqual([]);
  });

  it("flags stuck rollouts", () => {
    const issues = deploymentIssues(summarizeDeployment(deployment(2, 2, "ProgressDeadlineExceeded")));
    expect(issues.map((i) => i.category)).toEqual(["rollout-stuck"]);
  });
});

describe("detectIssues", () => {
  it("sorts critical issues first", () => {
    const overview: ClusterOverview = {
      context: "test",
      scannedAt: NOW.toISOString(),
      namespaces: [],
      nodes: [],
      pods: [
        summarizePod(pod({ phase: "Pending" }, { name: "a-old-pending", createdMinutesAgo: 30 })),
        summarizePod(
          pod(
            { phase: "Running", containerStatuses: [container({ state: { waiting: { reason: "CrashLoopBackOff" } } })] },
            { name: "z-crash" },
          ),
        ),
      ],
      deployments: [],
      warningEvents: [],
      errors: [],
    };
    expect(detectIssues(overview, OPTS).map((i) => i.severity)).toEqual(["critical", "warning"]);
  });
});
