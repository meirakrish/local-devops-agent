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
  warningEvents: [
    { involvedKind: "Node", involvedName: "n1", reason: "Rebooted", message: "a | b", count: 1 },
  ],
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
