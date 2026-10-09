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

export interface ReportInput {
  overview: ClusterOverview;
  issues: Issue[];
  ollama?: OllamaStatus;
}

export function renderMarkdownReport({ overview, issues, ollama }: ReportInput): string {
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
    `| Issues | ${count("critical")} critical, ${count("warning")} warning, ${count("info")} info |`,
    "",
    "## Issues",
    "",
  ];

  if (issues.length === 0) {
    out.push("No issues detected.", "");
  } else {
    for (const severity of ["critical", "warning", "info"] as const) {
      const group = issues.filter((i) => i.severity === severity);
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
  if (ollama) {
    if (!ollama.reachable) out.push(`- LLM: ${ollama.error}`);
    else if (!ollama.modelAvailable)
      out.push(`- LLM: Ollama reachable, but model \`${ollama.model}\` is not pulled (\`ollama pull ${ollama.model}\`)`);
    else out.push(`- LLM: \`${ollama.model}\` available at ${ollama.url}`);
  }
  out.push(
    "- Findings are rule-based (milestone 1). Suggestions are never applied automatically.",
    "",
  );
  return out.join("\n");
}
