import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createK8sClients } from "../../src/k8s/client.js";
import { detectIssues } from "../../src/scan/detect.js";
import { scanCluster } from "../../src/scan/scan.js";
import type { ClusterOverview, Issue } from "../../src/scan/types.js";

/**
 * Runs the real scan and rules against the kind demo cluster (no LLM, so results are
 * deterministic). Start the cluster first with `pnpm demo:up`, which waits until every
 * workload has reached its broken state.
 */
const KUBECONFIG = resolve(process.env["DEMO_KUBECONFIG"] ?? ".demo/kubeconfig");
const NAMESPACE = "agent-test";

let overview: ClusterOverview;
let issues: Issue[];

/** Issues for the pods of one demo deployment (pod names start with "<deployment>-"). */
const podIssuesOf = (deployment: string) =>
  issues.filter((i) => i.resource.kind === "Pod" && i.resource.name.startsWith(`${deployment}-`));

beforeAll(async () => {
  if (!existsSync(KUBECONFIG)) {
    throw new Error(`No demo kubeconfig at ${KUBECONFIG}. Start the demo cluster with: pnpm demo:up`);
  }
  const now = new Date();
  overview = await scanCluster(createK8sClients(KUBECONFIG), {
    namespace: NAMESPACE,
    eventWindowMinutes: 60,
    now,
  });
  issues = detectIssues(overview, { restartThreshold: 5, now, windowMinutes: 60 });
});

describe("demo cluster scan", () => {
  it("scans both nodes and the demo namespace without errors", () => {
    expect(overview.context).toBe("kind-devops-agent-demo");
    expect(overview.errors).toEqual([]);
    expect(overview.nodes).toHaveLength(2);
    expect(overview.nodes.every((n) => n.ready)).toBe(true);
    expect(overview.deployments.map((d) => d.name).sort()).toEqual([
      "batch",
      "cache",
      "frontend",
      "metrics-agent",
      "payments",
      "web",
    ]);
  });

  it("detects the crashloop in web", () => {
    expect(podIssuesOf("web").map((i) => i.category)).toContain("crashloop");
  });

  it("detects the bad image in payments", () => {
    expect(podIssuesOf("payments").map((i) => i.category)).toEqual(["image-pull"]);
  });

  it("detects the OOM kill in cache", () => {
    expect(podIssuesOf("cache").map((i) => i.category)).toEqual(["oom"]);
  });

  it("detects the unschedulable batch pod and explains that no node can fit it", () => {
    const [issue] = podIssuesOf("batch");
    expect(issue?.category).toBe("unschedulable");
    expect(issue?.evidence.join("\n")).toMatch(/No node can ever fit this pod: requests cpu=1000/);
  });

  it("reports no issues for the healthy frontend", () => {
    expect(issues.filter((i) => i.resource.name.startsWith("frontend"))).toEqual([]);
  });

  it("marks the broken deployments as critical", () => {
    const unavailable = issues
      .filter((i) => i.resource.kind === "Deployment" && i.category === "replicas-unavailable")
      .map((i) => i.resource.name)
      .sort();
    expect(unavailable).toEqual(["batch", "cache", "metrics-agent", "payments", "web"]);
  });

  it("explains that metrics-agent's pods are rejected by Pod Security", () => {
    const failed = issues.find((i) => i.category === "pod-create-failed");
    expect(failed?.resource.kind).toBe("ReplicaSet");
    expect(failed?.resource.name).toMatch(/^metrics-agent-/);
    expect(failed?.title).toContain("rejected by Pod Security admission");
    expect(failed?.workload).toBe(`${NAMESPACE}/metrics-agent`);
  });

  it("flags the web Service with no ready endpoints and ties it to the web Deployment", () => {
    const svc = issues.find((i) => i.id === `service/${NAMESPACE}/web:no-ready-endpoints`);
    expect(svc?.severity).toBe("critical");
    expect(svc?.workload).toBe(`${NAMESPACE}/web`);
  });

  it("flags the storefront selector typo and shows the real label values", () => {
    const svc = issues.find((i) => i.id === `service/${NAMESPACE}/storefront:no-pods`);
    expect(svc?.severity).toBe("warning");
    expect(svc?.evidence[1]).toContain("frontend");
  });

  it("does not flag the webhook's Service twice (the webhook rule covers it)", () => {
    expect(issues.filter((i) => i.resource.kind === "Service" && i.resource.name === "policy-webhook")).toEqual([]);
  });
});

describe("demo cluster: cluster-level checks", () => {
  it("reads the control plane: readiness checks, etcd size and API server certificate", () => {
    const cp = overview.controlPlane;
    expect(cp.notVisible).toEqual([]);
    expect(cp.serverVersion).toMatch(/^v1\.\d+/);
    expect(cp.readyz?.find((c) => c.name === "etcd")?.ok).toBe(true);
    expect(cp.etcd?.dbSizeBytes).toBeGreaterThan(0);
    expect(cp.etcd?.quotaSource).toBe("default");
    expect(Date.parse(cp.certificate?.notAfter ?? "")).toBeGreaterThan(Date.now());
  });

  it("reports no control-plane, etcd or node-capacity issues on the healthy kind cluster", () => {
    const clusterLevel = issues.filter((i) => i.resource.kind === "ControlPlane" || i.resource.kind === "Node");
    expect(clusterLevel).toEqual([]);
    expect(overview.nodes.every((n) => n.heartbeat !== undefined && n.requested !== undefined)).toBe(true);
  });

  it("finds the four control-plane components and sees that they are running", () => {
    const pods = overview.controlPlane.pods ?? [];
    expect(pods.map((p) => p.component)).toEqual([
      "etcd",
      "kube-apiserver",
      "kube-controller-manager",
      "kube-scheduler",
    ]);
    expect(pods.every((p) => p.ready)).toBe(true);
    // Restarts and probe failures depend on the cluster's recent history, so they are
    // covered by unit tests rather than asserted here.
    expect(issues.filter((i) => i.category === "controlplane-pod-down")).toEqual([]);
  });

  it("checks cluster DNS even with --namespace and finds it healthy", () => {
    expect(overview.dns.service?.name).toBe("kube-dns");
    expect(overview.dns.service?.readyEndpoints).toBeGreaterThan(0);
    expect(issues.filter((i) => i.category.startsWith("dns-"))).toEqual([]);
  });

  it("flags the demo webhook whose service has no endpoints as critical", () => {
    const webhook = issues.find((i) => i.category === "webhook-unavailable");
    expect(webhook?.severity).toBe("critical");
    expect(webhook?.resource).toEqual({ kind: "ValidatingWebhookConfiguration", name: "agent-demo-policy" });
    expect(webhook?.evidence[0]).toContain("no ready endpoints");
  });
});

describe("CLI against the demo cluster", () => {
  it("exits with code 2 (critical issues) and prints the report", () => {
    const result = spawnSync("pnpm", ["-s", "check", "--namespace", NAMESPACE, "--no-llm"], {
      env: { ...process.env, KUBECONFIG },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("**Status: CRITICAL**");
    expect(result.stdout).toContain("Context: `kind-devops-agent-demo`");
  });

  it("prints JSON and, run twice with --compare, reports every issue as ongoing", () => {
    const latest = join(mkdtempSync(join(tmpdir(), "e2e-compare-")), "latest.json");
    const run = () =>
      spawnSync(
        "pnpm",
        [
          "-s",
          "check",
          "--namespace",
          NAMESPACE,
          "--no-llm",
          "--format",
          "json",
          "--compare",
          latest,
          "--output",
          latest,
        ],
        { env: { ...process.env, KUBECONFIG }, encoding: "utf8" },
      );
    const first = JSON.parse(run().stdout);
    expect(first.status).toBe("CRITICAL");
    expect(first.comparison).toBeNull();
    expect(first.notes.comparison).toMatch(/^no previous report/);

    const second = JSON.parse(run().stdout);
    expect(second.comparison.previousScannedAt).toBe(first.scannedAt);
    expect(second.comparison.new).toBe(0);
    expect(second.comparison.ongoing).toBe(second.issues.length);
  });
});
