import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRawPath, RawPathNotAllowedError } from "../src/k8s/raw.js";
import {
  etcdQuotaFromArgs,
  etcdStorageFromMetrics,
  parseHealthChecks,
  parseMetrics,
  parseMinorVersion,
} from "../src/scan/cluster.js";
import { controlPlaneIssues, nodeCapacityIssues, webhookIssues } from "../src/scan/cluster-rules.js";
import type { ControlPlaneSummary, NodeSummary, WebhookSummary } from "../src/scan/types.js";

// Captured from a real kind cluster (Kubernetes v1.37).
const READYZ_OK = readFileSync(new URL("./fixtures/readyz-ok.txt", import.meta.url), "utf8");
const METRICS = readFileSync(new URL("./fixtures/apiserver-metrics.txt", import.meta.url), "utf8");
const NOW = new Date("2026-10-09T12:00:00Z");

describe("raw path guard", () => {
  it("allows only the health, version and metrics endpoints", () => {
    expect(checkRawPath("/readyz?verbose")).toBe("/readyz?verbose");
    expect(checkRawPath("/version")).toBe("/version");
    for (const bad of ["/api/v1/secrets", "/readyz/../api/v1/secrets", "https://evil.example/readyz", "/metricsX", "/"]) {
      expect(() => checkRawPath(bad)).toThrow(RawPathNotAllowedError);
    }
  });
});

describe("parsers", () => {
  it("parses a healthy /readyz?verbose", () => {
    const checks = parseHealthChecks(READYZ_OK);
    expect(checks.length).toBeGreaterThan(30);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toContain("etcd");
  });

  it("parses failing checks and their reason", () => {
    const checks = parseHealthChecks("[+]ping ok\n[-]etcd failed: reason withheld\n[-]informer-sync failed\nreadyz check failed\n");
    expect(checks).toEqual([
      { name: "ping", ok: true, reason: undefined },
      { name: "etcd", ok: false, reason: "reason withheld" },
      { name: "informer-sync", ok: false, reason: undefined },
    ]);
  });

  it("parses only the requested metrics, with labels and exponent values", () => {
    const samples = parseMetrics(METRICS, ["apiserver_storage_size_bytes", "go_goroutines"]);
    expect(samples).toEqual([
      { name: "apiserver_storage_size_bytes", labels: { storage_cluster_id: "etcd-0" }, value: 3923968 },
      { name: "go_goroutines", labels: {}, value: 2621 },
    ]);
  });

  it("extracts etcd size and object counts (current and older metric names)", () => {
    const storage = etcdStorageFromMetrics(METRICS);
    expect(storage.dbSizeBytes).toBe(3923968);
    expect(storage.objectCounts[0]).toEqual({ resource: "configmaps", count: 14 });

    const older = etcdStorageFromMetrics(
      'etcd_db_total_size_in_bytes{endpoint="https://10.0.0.1:2379"} 1.5e+09\napiserver_storage_objects{resource="events"} 120000\napiserver_storage_objects{resource="pods"} -1\n',
    );
    expect(older.dbSizeBytes).toBe(1.5e9);
    expect(older.objectCounts).toEqual([{ resource: "events", count: 120000 }]);
  });

  it("reads the etcd quota flag and versions", () => {
    expect(etcdQuotaFromArgs(["etcd", "--data-dir=/var/lib/etcd", "--quota-backend-bytes=8589934592"])).toBe(8589934592);
    expect(etcdQuotaFromArgs(["etcd"])).toBeUndefined();
    expect(parseMinorVersion("v1.30.4-eks-a737599")).toEqual({ major: 1, minor: 30 });
    expect(parseMinorVersion("garbage")).toBeUndefined();
  });
});

describe("control plane rules", () => {
  const healthy: ControlPlaneSummary = {
    serverVersion: "v1.37.0",
    readyz: parseHealthChecks(READYZ_OK),
    certificate: { subject: "CN=kube-apiserver", issuer: "CN=kubernetes", notAfter: "2027-10-09T10:49:51.000Z" },
    etcd: { dbSizeBytes: 3923968, quotaBytes: 2 * 1024 ** 3, quotaSource: "default", objectCounts: [] },
    notVisible: [],
  };

  it("finds nothing on a healthy control plane", () => {
    expect(controlPlaneIssues(healthy, NOW)).toEqual([]);
  });

  it("separates etcd failures from other readiness failures", () => {
    const issues = controlPlaneIssues(
      { ...healthy, readyz: parseHealthChecks("[-]etcd failed: reason withheld\n[-]informer-sync failed\n[+]ping ok") },
      NOW,
    );
    expect(issues.map((i) => [i.category, i.severity])).toEqual([
      ["etcd-unhealthy", "critical"],
      ["apiserver-not-ready", "critical"],
    ]);
  });

  it("grades certificate expiry", () => {
    const expiring = (days: number) =>
      controlPlaneIssues({ ...healthy, certificate: { ...healthy.certificate!, notAfter: new Date(NOW.getTime() + days * 86_400_000).toISOString() } }, NOW);
    expect(expiring(60)).toEqual([]);
    expect(expiring(20)[0]?.severity).toBe("warning");
    expect(expiring(3)[0]?.severity).toBe("critical");
    expect(expiring(-1)[0]?.title).toBe("API server certificate has expired");
  });

  it("grades etcd size against the quota and says when the quota is assumed", () => {
    const withSize = (bytes: number) => controlPlaneIssues({ ...healthy, etcd: { ...healthy.etcd!, dbSizeBytes: bytes } }, NOW);
    expect(withSize(1.0 * 1024 ** 3)).toEqual([]);
    const warn = withSize(1.5 * 1024 ** 3)[0];
    expect(warn?.severity).toBe("warning");
    expect(warn?.title).toBe("etcd database is at 75% of its quota");
    expect(warn?.evidence[0]).toContain("etcd default");
    expect(withSize(1.9 * 1024 ** 3)[0]?.severity).toBe("critical");
  });

  it("warns about very large object counts", () => {
    const issues = controlPlaneIssues(
      { ...healthy, etcd: { ...healthy.etcd!, objectCounts: [{ resource: "events", count: 250_000 }, { resource: "pods", count: 40 }] } },
      NOW,
    );
    expect(issues.map((i) => i.id)).toEqual(["controlplane/etcd:objects-events"]);
  });
});

describe("node capacity rules", () => {
  const node: NodeSummary = {
    name: "worker-1",
    ready: true,
    roles: ["worker"],
    kubeletVersion: "v1.37.0",
    pressures: [],
    unschedulable: false,
    allocatable: { cpu: "4", memory: "8Gi", pods: "110" },
    heartbeat: new Date(NOW.getTime() - 5_000).toISOString(),
    requested: { cpu: 1, memory: 2 * 1024 ** 3, pods: 10 },
  };

  it("finds nothing on a healthy node", () => {
    expect(nodeCapacityIssues(node, NOW, "v1.37.0")).toEqual([]);
  });

  it("flags a stale kubelet heartbeat", () => {
    const [issue] = nodeCapacityIssues({ ...node, heartbeat: new Date(NOW.getTime() - 300_000).toISOString() }, NOW, "v1.37.0");
    expect(issue?.category).toBe("node-heartbeat");
    expect(issue?.title).toContain("300s");
  });

  it("flags nodes whose requests are nearly at allocatable", () => {
    const [issue] = nodeCapacityIssues({ ...node, requested: { cpu: 3.8, memory: 2 * 1024 ** 3, pods: 105 } }, NOW, "v1.37.0");
    expect(issue?.category).toBe("node-capacity");
    expect(issue?.title).toBe("Node worker-1 is nearly full (cpu 95%, pods 95% requested)");
    expect(issue?.evidence[0]).toBe("cpu: 3.8 requested of 4 allocatable");
  });

  it("flags unsupported version skew in both directions", () => {
    expect(nodeCapacityIssues({ ...node, kubeletVersion: "v1.34.2" }, NOW, "v1.37.0")).toEqual([]); // 3 behind: supported
    expect(nodeCapacityIssues({ ...node, kubeletVersion: "v1.33.0" }, NOW, "v1.37.0")[0]?.title).toContain("4 minor versions behind");
    expect(nodeCapacityIssues({ ...node, kubeletVersion: "v1.38.0" }, NOW, "v1.37.0")[0]?.title).toContain("newer than the API server");
  });
});

describe("webhook rules", () => {
  const webhook: WebhookSummary = {
    kind: "Validating",
    configName: "policy-engine",
    name: "validate.policy.example.com",
    failurePolicy: "Fail",
    service: { namespace: "policy", name: "policy-webhook" },
    status: "no-ready-endpoints",
    detail: "Service policy/policy-webhook has no ready endpoints",
  };

  it("is critical when an unreachable webhook fails closed", () => {
    const [issue] = webhookIssues(webhook);
    expect(issue?.severity).toBe("critical");
    expect(issue?.title).toContain("blocks the requests it matches");
    expect(issue?.resource).toEqual({ kind: "ValidatingWebhookConfiguration", name: "policy-engine" });
  });

  it("is a warning when it fails open, and silent when healthy or external", () => {
    expect(webhookIssues({ ...webhook, failurePolicy: "Ignore" })[0]?.severity).toBe("warning");
    expect(webhookIssues({ ...webhook, status: "ok" })).toEqual([]);
    expect(webhookIssues({ ...webhook, status: "external" })).toEqual([]);
  });
});
