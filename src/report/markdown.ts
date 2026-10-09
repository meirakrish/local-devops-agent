import type { Finding } from "../agent/types.js";
import type { OllamaStatus } from "../llm/ollama.js";
import type { ClusterOverview, Issue, Severity } from "../scan/types.js";

export type OverallStatus = "HEALTHY" | "DEGRADED" | "CRITICAL";

export function overallStatus(issues: Issue[]): OverallStatus {
  if (issues.some((i) => i.severity === "critical")) return "CRITICAL";
  if (issues.some((i) => i.severity === "warning")) return "DEGRADED";
  return "HEALTHY";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function cell(text: string | undefined, max = 120): string {
  return truncate(text ?? "", max).replace(/\|/g, "\\|");
}

const SECTION_TITLES: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

function renderIssue(issue: Issue): string {
  const lines = [`#### ${issue.title}`, ""];
  for (const e of issue.evidence) lines.push(`- ${truncate(e, 300)}`);
  if (issue.hint) lines.push("", `_Suggested next step:_ ${issue.hint}`);
  return lines.join("\n");
}

function controlPlaneRows(overview: ClusterOverview, now: Date): string[] {
  const cp = overview.controlPlane;
  const rows: string[] = [];
  if (cp.readyz) {
    const failing = cp.readyz.filter((c) => !c.ok);
    rows.push(`| API server health checks | ${cp.readyz.length - failing.length}/${cp.readyz.length} passing${failing.length > 0 ? ` (failing: ${cell(failing.map((c) => c.name).join(", "), 80)})` : ""} |`);
  } else {
    rows.push("| API server health checks | not visible |");
  }
  if (cp.etcd?.dbSizeBytes !== undefined) {
    const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${(b / 1024 ** 2).toFixed(1)} MiB`);
    const ratio = Math.round((cp.etcd.dbSizeBytes / cp.etcd.quotaBytes) * 100);
    rows.push(`| etcd database | ${size(cp.etcd.dbSizeBytes)} of ${size(cp.etcd.quotaBytes)} quota (${ratio}%)${cp.etcd.quotaSource === "default" ? ", default quota assumed" : ""} |`);
  } else {
    rows.push("| etcd database | not visible |");
  }
  if (cp.certificate) {
    const days = Math.floor((Date.parse(cp.certificate.notAfter) - now.getTime()) / 86_400_000);
    rows.push(`| API server certificate | ${days < 0 ? "expired" : `expires in ${days} days`} (${cp.certificate.notAfter.slice(0, 10)}) |`);
  }
  const unreachable = overview.webhooks.filter((w) => w.status === "service-missing" || w.status === "no-ready-endpoints");
  rows.push(`| Admission webhooks | ${overview.webhooks.length}${unreachable.length > 0 ? `, ${unreachable.length} unreachable` : ""} |`);
  return rows;
}

function resourceName(i: Issue): string {
  return `${i.resource.kind} ${i.resource.namespace ? `${i.resource.namespace}/` : ""}${i.resource.name}`;
}

function renderFinding(f: Finding, index: number): string {
  const { problem } = f;
  const affected = [problem.primary, ...problem.related].map(resourceName);
  const lines = [
    `### ${index}. [${problem.severity.toUpperCase()}] ${f.error ? problem.primary.title : truncate(f.summary, 160)}`,
    "",
    `**Affected:** ${[...new Set(affected)].join(", ")}`,
    "",
  ];
  if (f.error) {
    lines.push(`_LLM investigation failed: ${truncate(f.error, 200)}. Rule-based evidence:_`, "");
    for (const e of problem.primary.evidence) lines.push(`- ${truncate(e, 300)}`);
    if (problem.primary.hint) lines.push("", `_Suggested next step:_ ${problem.primary.hint}`);
    return lines.join("\n");
  }
  lines.push(`**Root cause:** ${f.rootCause}`, "");
  if (f.evidence.length > 0) {
    lines.push("**Evidence:**", "", ...f.evidence.map((e) => `- ${truncate(e, 300)}`), "");
  }
  if (f.suggestedFix.length > 0) {
    lines.push("**Suggested fix** (not applied):", "", ...f.suggestedFix.map((s, i) => `${i + 1}. ${s}`), "");
  }
  lines.push(`_Confidence: ${f.confidence} · ${f.toolCalls} tool call(s)_`);
  return lines.join("\n");
}

export interface ReportInput {
  overview: ClusterOverview;
  issues: Issue[];
  ollama?: OllamaStatus;
  findings?: Finding[];
  /** Why the LLM steps did not run, if they did not. */
  llmSkipped?: string;
}

export function renderMarkdownReport({
  overview,
  issues,
  ollama,
  findings = [],
  llmSkipped,
}: ReportInput): string {
  const status = overallStatus(issues);
  const count = (s: Severity) => issues.filter((i) => i.severity === s).length;
  const readyNodes = overview.nodes.filter((n) => n.ready).length;
  const runningPods = overview.pods.filter((p) => p.phase === "Running").length;
  const healthyDeployments = overview.deployments.filter((d) => d.ready >= d.desired).length;

  const out: string[] = [
    "# Kubernetes Health Report",
    "",
    `**Status: ${status}**  `,
    `Context: \`${overview.context}\`  `,
    `Scope: ${overview.namespaceFilter ? `namespace \`${overview.namespaceFilter}\`` : "all namespaces"}  `,
    `Scanned at: ${overview.scannedAt}`,
    "",
    "## Summary",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Nodes ready | ${readyNodes}/${overview.nodes.length} |`,
    `| Pods running | ${runningPods}/${overview.pods.length} |`,
    `| Deployments fully ready | ${healthyDeployments}/${overview.deployments.length} |`,
    `| Warning events (recent) | ${overview.warningEvents.length} |`,
    ...controlPlaneRows(overview, new Date(overview.scannedAt)),
    `| Issues | ${count("critical")} critical, ${count("warning")} warning, ${count("info")} info |`,
    `| Investigated by LLM | ${findings.length > 0 ? `${findings.length} problem(s)` : "none"} |`,
    "",
  ];

  if (findings.length > 0) {
    out.push("## Investigated problems", "");
    findings.forEach((f, i) => out.push(renderFinding(f, i + 1), ""));
  }

  // Issues already covered by an investigated problem are not repeated.
  const covered = new Set(findings.flatMap((f) => [f.problem.primary, ...f.problem.related].map((i) => i.id)));
  const remaining = issues.filter((i) => !covered.has(i.id));
  out.push(findings.length > 0 ? "## Other issues (rule-based)" : "## Issues", "");

  if (issues.length === 0) {
    out.push("No issues detected.", "");
  } else if (remaining.length === 0) {
    out.push("None; all issues are covered above.", "");
  } else {
    for (const severity of ["critical", "warning", "info"] as const) {
      const group = remaining.filter((i) => i.severity === severity);
      if (group.length === 0) continue;
      out.push(`### ${SECTION_TITLES[severity]} (${group.length})`, "");
      for (const issue of group) out.push(renderIssue(issue), "");
    }
  }

  if (overview.warningEvents.length > 0) {
    out.push(
      "## Recent warning events",
      "",
      "| Last seen | Object | Reason | Count | Message |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const e of overview.warningEvents.slice(0, 15)) {
      const obj = `${e.involvedKind ?? "?"} ${e.namespace ? `${e.namespace}/` : ""}${e.involvedName ?? "?"}`;
      out.push(
        `| ${cell(e.lastSeen?.replace("T", " ").slice(0, 19))} | ${cell(obj, 60)} | ${cell(e.reason, 30)} | ${e.count} | ${cell(e.message)} |`,
      );
    }
    out.push("");
  }

  out.push("## Scan notes", "");
  for (const err of overview.errors) out.push(`- Scan error: ${err}`);
  for (const note of overview.controlPlane.notVisible) out.push(`- Not checked: ${note}`);
  if (ollama) {
    if (!ollama.reachable) out.push(`- LLM: ${ollama.error}`);
    else if (!ollama.modelAvailable)
      out.push(`- LLM: Ollama reachable, but model \`${ollama.model}\` is not pulled (\`ollama pull ${ollama.model}\`)`);
    else out.push(`- LLM: \`${ollama.model}\` at ${ollama.url}`);
  }
  if (llmSkipped) out.push(`- LLM investigation skipped: ${llmSkipped}.`);
  out.push(
    "- Issues are detected by rules; root causes in \"Investigated problems\" come from the local LLM and may be wrong.",
    "- Suggested fixes are never applied automatically.",
    "",
  );
  return out.join("\n");
}
