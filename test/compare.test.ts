import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/agent/types.js";
import { compareWithPrevious, issueKey, loadPreviousReport, type PreviousReport } from "../src/report/compare.js";
import { buildJsonReport } from "../src/report/json.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import type { ClusterOverview, Issue } from "../src/scan/types.js";

const overview: ClusterOverview = {
  context: "kind-demo",
  scannedAt: "2026-01-01T13:00:00.000Z",
  namespaces: ["shop"],
  nodes: [{ name: "n1", ready: true, roles: ["worker"], pressures: [], unschedulable: false, allocatable: {} }],
  pods: [],
  deployments: [],
  workloads: [],
  services: [],
  dns: {},
  podCreateFailures: [],
  warningEvents: [],
  controlPlane: { notVisible: ["etcd size: forbidden"] },
  webhooks: [],
  errors: [],
};

function issue(id: string, kind: string, name: string, severity: Issue["severity"], workload?: string): Issue {
  return {
    id,
    severity,
    category: id.split(":")[1]!,
    resource: { kind, namespace: "shop", name },
    title: `${kind} ${name}: ${id.split(":")[1]}`,
    evidence: ["evidence"],
    ...(workload ? { workload } : {}),
  };
}

const webPod = issue("pod/shop/web-7db8d69f68-aaaaa:crashloop", "Pod", "web-7db8d69f68-aaaaa", "critical", "shop/web");
const webPodReplaced = issue(
  "pod/shop/web-7db8d69f68-zzzzz:crashloop",
  "Pod",
  "web-7db8d69f68-zzzzz",
  "critical",
  "shop/web",
);
const apiDeploy = issue("deployment/shop/api:unavailable", "Deployment", "api", "warning", "shop/api");
const node = issue("node/n1:pressure", "Node", "n1", "warning");

const previousOf = (issues: Issue[], extra: Partial<PreviousReport> = {}): PreviousReport => ({
  context: "kind-demo",
  namespace: null,
  scannedAt: "2026-01-01T12:00:00.000Z",
  issues: issues.map((i) => ({ key: issueKey(i), id: i.id, severity: i.severity, title: i.title })),
  ...extra,
});

describe("issue keys", () => {
  it("keys pod issues by workload and failure, so a replaced pod is the same issue", () => {
    expect(issueKey(webPod)).toBe("pod@shop/web:crashloop");
    expect(issueKey(webPodReplaced)).toBe(issueKey(webPod));
  });

  it("uses the id for everything else, and for pods without a workload", () => {
    expect(issueKey(apiDeploy)).toBe(apiDeploy.id);
    const bare = issue("pod/shop/standalone:crashloop", "Pod", "standalone", "critical");
    expect(issueKey(bare)).toBe(bare.id);
  });
});

describe("comparing with a previous report", () => {
  it("marks new, escalated, ongoing and resolved issues", () => {
    const before = previousOf([webPod, { ...apiDeploy }, node]);
    const now = [
      webPodReplaced,
      { ...apiDeploy, severity: "critical" as const },
      issue("node/n1:cordoned", "Node", "n1", "info"),
    ];
    const { comparison, note } = compareWithPrevious(overview, now, before);
    expect(note).toBeUndefined();
    expect(comparison?.changes).toEqual({
      [webPodReplaced.id]: "ongoing",
      [apiDeploy.id]: "escalated",
      "node/n1:cordoned": "new",
    });
    expect(comparison?.resolved.map((r) => r.id)).toEqual([node.id]);
    expect(comparison?.previousScannedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("does not call an issue escalated when another issue with its key was already critical", () => {
    const warningPod = { ...webPod, id: "pod/shop/web-7db8d69f68-bbbbb:crashloop", severity: "warning" as const };
    const { comparison } = compareWithPrevious(overview, [webPodReplaced], previousOf([warningPod, webPod]));
    expect(comparison?.changes[webPodReplaced.id]).toBe("ongoing");
  });

  it("refuses to compare reports of another cluster or scope", () => {
    expect(compareWithPrevious(overview, [], previousOf([], { context: "prod" })).note).toBe(
      'not compared: the previous report is of context "prod"',
    );
    expect(compareWithPrevious(overview, [], previousOf([], { namespace: "shop" })).note).toBe(
      'not compared: the previous report covered namespace "shop", this one all namespaces',
    );
  });
});

describe("loading a previous report", () => {
  async function file(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "compare-test-"));
    const path = join(dir, "previous.json");
    await writeFile(path, content);
    return path;
  }

  it("returns a note, not an error, for a missing, non-JSON or foreign file", async () => {
    expect((await loadPreviousReport("/nonexistent/latest.json")).note).toMatch(/^no previous report at .* yet/);
    expect((await loadPreviousReport(await file("# Kubernetes Health Report"))).note).toMatch(/is not JSON/);
    expect((await loadPreviousReport(await file('{"hello": 1}'))).note).toMatch(/is not a JSON report from this tool/);
  });

  it("round-trips: a JSON report reads back as a previous report with the same keys", async () => {
    const json = buildJsonReport({ overview, issues: [webPod, apiDeploy] });
    const { report, note } = await loadPreviousReport(await file(JSON.stringify(json)));
    expect(note).toBeUndefined();
    expect(report?.issues.map((i) => i.key)).toEqual(["pod@shop/web:crashloop", apiDeploy.id]);
    const { comparison } = compareWithPrevious(overview, [webPodReplaced, apiDeploy], report!);
    expect(Object.values(comparison!.changes)).toEqual(["ongoing", "ongoing"]);
    expect(comparison?.resolved).toEqual([]);
  });
});

describe("JSON report", () => {
  const finding: Finding = {
    problem: { primary: webPod, related: [apiDeploy], reason: "", severity: "critical" },
    summary: "web crashes",
    rootCause: "DATABASE_URL is not set",
    evidence: ["FATAL: DATABASE_URL is not set"],
    suggestedFix: ["Set DATABASE_URL"],
    confidence: "high",
    toolCalls: 3,
  };

  it("has status, counts, summary, issues with keys, findings and notes", () => {
    const json = buildJsonReport({ overview, issues: [webPod, apiDeploy], findings: [finding], llmSkipped: undefined });
    expect(json).toMatchObject({
      schemaVersion: 1,
      context: "kind-demo",
      namespace: null,
      status: "CRITICAL",
      counts: { critical: 1, warning: 1, info: 0 },
      summary: { nodes: { ready: 1, total: 1 }, clusterDns: null, etcd: null },
      comparison: null,
      notes: { scanErrors: [], notChecked: ["etcd size: forbidden"], llm: {} },
    });
    expect(json.issues[0]).toMatchObject({ id: webPod.id, key: "pod@shop/web:crashloop" });
    expect(json.issues[0]).not.toHaveProperty("change");
    expect(json.findings).toEqual([
      {
        primaryIssueId: webPod.id,
        relatedIssueIds: [apiDeploy.id],
        severity: "critical",
        summary: "web crashes",
        rootCause: "DATABASE_URL is not set",
        confidence: "high",
        evidence: ["FATAL: DATABASE_URL is not set"],
        suggestedFix: ["Set DATABASE_URL"],
        toolCalls: 3,
      },
    ]);
  });

  it("includes changes when compared", () => {
    const { comparison } = compareWithPrevious(overview, [webPod, apiDeploy], previousOf([apiDeploy, node]));
    const json = buildJsonReport({ overview, issues: [webPod, apiDeploy], comparison });
    expect(json.issues.map((i) => i.change)).toEqual(["new", "ongoing"]);
    expect(json.comparison).toMatchObject({ new: 1, escalated: 0, ongoing: 1, resolved: [{ id: node.id }] });
  });
});

describe("markdown report with changes", () => {
  it("lists new, escalated and resolved issues and tags them", () => {
    const escalated = { ...apiDeploy, severity: "critical" as const };
    const { comparison } = compareWithPrevious(overview, [webPod, escalated], previousOf([apiDeploy, node]));
    const md = renderMarkdownReport({ overview, issues: [webPod, escalated], comparison });
    expect(md).toContain("| Since last run | 1 new, 1 escalated, 1 resolved, 0 ongoing |");
    expect(md).toContain("## Changes since last run");
    expect(md).toContain(`- **NEW** [CRITICAL] ${webPod.title}`);
    expect(md).toContain(`- **ESCALATED** [CRITICAL] ${apiDeploy.title}`);
    expect(md).toContain(`- **RESOLVED** [WARNING] ${node.title}`);
    expect(md).toContain(`#### [NEW] ${webPod.title}`);
  });

  it("says when nothing changed, and explains a skipped comparison", () => {
    const { comparison } = compareWithPrevious(overview, [webPod], previousOf([webPod]));
    expect(renderMarkdownReport({ overview, issues: [webPod], comparison })).toContain(
      "No changes: 1 ongoing issue(s).",
    );
    const md = renderMarkdownReport({ overview, issues: [], comparisonNote: "no previous report at x.json yet" });
    expect(md).not.toContain("## Changes since last run");
    expect(md).toContain("- Changes since last run: no previous report at x.json yet.");
  });
});
