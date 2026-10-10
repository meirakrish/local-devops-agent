import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { overallStatus, renderMarkdownReport } from "../src/report/markdown.js";
import { recentEvents } from "../src/scan/scan.js";
import type { ClusterOverview, Issue } from "../src/scan/types.js";

const overview: ClusterOverview = {
  context: "kind-demo",
  scannedAt: "2026-01-01T12:00:00.000Z",
  namespaces: ["default"],
  nodes: [{ name: "n1", ready: true, roles: ["worker"], pressures: [], unschedulable: false, allocatable: {} }],
  pods: [],
  deployments: [],
  workloads: [],
  services: [],
  dns: {},
  podCreateFailures: [],
  warningEvents: [{ involvedKind: "Node", involvedName: "n1", reason: "Rebooted", message: "a | b", count: 1 }],
  controlPlane: { notVisible: [] },
  webhooks: [],
  errors: ["list nodes: forbidden (check RBAC permissions)"],
};

const crash: Issue = {
  id: "pod/default/web:crashloop",
  severity: "critical",
  category: "crashloop",
  resource: { kind: "Pod", namespace: "default", name: "web" },
  title: "Pod default/web: crashloop",
  evidence: ["container app is in CrashLoopBackOff"],
  hint: "Read the previous logs.",
};

describe("report", () => {
  it("derives overall status from the worst severity", () => {
    expect(overallStatus([])).toBe("HEALTHY");
    expect(overallStatus([{ ...crash, severity: "warning" }])).toBe("DEGRADED");
    expect(overallStatus([crash])).toBe("CRITICAL");
  });

  it("renders issues, events, scan errors and escapes table pipes", () => {
    const md = renderMarkdownReport({ overview, issues: [crash] });
    expect(md).toContain("**Status: CRITICAL**");
    expect(md).toContain("### Critical (1)");
    expect(md).toContain("_Suggested next step:_ Read the previous logs.");
    expect(md).toContain("| Node n1 |"); // cluster-scoped: no namespace prefix
    expect(md).toContain("a \\| b");
    expect(md).toContain("Scan error: list nodes: forbidden");
  });
});

describe("report: workload, service and DNS rows", () => {
  it("counts healthy workloads, Services without endpoints and DNS endpoints", () => {
    const svc = {
      namespace: "shop",
      name: "web",
      type: "ClusterIP",
      selector: { app: "web" },
      readyEndpoints: 0,
      notReadyEndpoints: 1,
      pods: [],
      podLabelValues: {},
    };
    const md = renderMarkdownReport({
      overview: {
        ...overview,
        workloads: [
          { kind: "DaemonSet", namespace: "kube-system", name: "kube-proxy", desired: 2, ready: 1, updated: 2 },
        ],
        services: [svc, { ...svc, name: "api", readyEndpoints: 2, notReadyEndpoints: 0 }],
        dns: {
          service: { ...svc, namespace: "kube-system", name: "kube-dns", readyEndpoints: 2, notReadyEndpoints: 0 },
        },
      },
      issues: [],
    });
    expect(md).toContain("| DaemonSets and StatefulSets fully ready | 0/1 |");
    expect(md).toContain("| Services without ready endpoints | 1 of 2 |");
    expect(md).toContain("| Cluster DNS | 2/2 endpoints ready |");
  });

  it("says when cluster DNS could not be checked", () => {
    const md = renderMarkdownReport({
      overview: { ...overview, dns: { notVisible: "no Service kube-system/kube-dns" } },
      issues: [],
    });
    expect(md).toContain("| Cluster DNS | not visible |");
    expect(md).toContain("- Not checked: cluster DNS: no Service kube-system/kube-dns");
  });
});

describe("report: cluster-level rows", () => {
  it("shows control-plane, etcd, certificate and webhook rows", () => {
    const md = renderMarkdownReport({
      overview: {
        ...overview,
        controlPlane: {
          serverVersion: "v1.37.0",
          readyz: [
            { name: "ping", ok: true },
            { name: "etcd", ok: false, reason: "reason withheld" },
          ],
          certificate: { subject: "CN=kube-apiserver", issuer: "CN=kubernetes", notAfter: "2026-01-31T12:00:00.000Z" },
          etcd: { dbSizeBytes: 1.5 * 1024 ** 3, quotaBytes: 2 * 1024 ** 3, quotaSource: "default", objectCounts: [] },
          notVisible: [],
        },
        webhooks: [
          { kind: "Validating", configName: "p", name: "w", failurePolicy: "Fail", status: "no-ready-endpoints" },
          { kind: "Mutating", configName: "q", name: "v", failurePolicy: "Fail", status: "ok" },
        ],
      },
      issues: [],
    });
    expect(md).toContain("| API server health checks | 1/2 passing (failing: etcd) |");
    expect(md).toContain("| etcd database | 1.5 GiB of 2.0 GiB quota (75%), default quota assumed |");
    expect(md).toContain("| API server certificate | expires in 30 days (2026-01-31) |");
    expect(md).toContain("| Admission webhooks | 2, 1 unreachable |");
  });

  it("says what could not be checked instead of implying it is healthy", () => {
    const md = renderMarkdownReport({
      overview: { ...overview, controlPlane: { notVisible: ["etcd size and object counts: /metrics forbidden"] } },
      issues: [],
    });
    expect(md).toContain("| API server health checks | not visible |");
    expect(md).toContain("| etcd database | not visible |");
    expect(md).toContain("- Not checked: etcd size and object counts: /metrics forbidden");
  });
});

describe("recentEvents", () => {
  it("drops events outside the window and sorts newest first", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const result = recentEvents(
      [
        { reason: "old", count: 1, lastSeen: "2026-01-01T10:00:00.000Z" },
        { reason: "mid", count: 1, lastSeen: "2026-01-01T11:30:00.000Z" },
        { reason: "new", count: 1, lastSeen: "2026-01-01T11:59:00.000Z" },
      ],
      now,
      60,
      10,
    );
    expect(result.map((e) => e.reason)).toEqual(["new", "mid"]);
  });
});

describe("config", () => {
  it("applies defaults and treats empty values as unset", () => {
    const c = loadConfig({ OLLAMA_URL: "http://ollama:11434/", KUBECONFIG: "", MAX_STEPS_PER_PROBLEM: "" });
    expect(c.ollamaUrl).toBe("http://ollama:11434");
    expect(c.kubeconfigPath).toBeUndefined();
    expect(c.maxStepsPerProblem).toBe(6);
    expect(c.model).toBe("qwen2.5:7b-instruct");
  });

  it("rejects invalid values with a readable error", () => {
    expect(() => loadConfig({ MAX_STEPS_PER_PROBLEM: "abc" })).toThrow(/MAX_STEPS_PER_PROBLEM/);
  });
});
