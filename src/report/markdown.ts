import type { Finding, FixFlag } from "../agent/types.js";
import { addUsage, emptyUsage, type LlmUsage } from "../llm/model.js";
import type { OllamaStatus } from "../llm/ollama.js";
import { formatBytes } from "../scan/quantity.js";
import type { ClusterOverview, Issue, Severity } from "../scan/types.js";
import { changeCounts, type Comparison, type IssueChange } from "./compare.js";

export type OverallStatus = "HEALTHY" | "DEGRADED" | "CRITICAL";

/** Overall status from rule severities only (the LLM cannot change it); sets the exit code. */
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

/** "[NEW] " or "[ESCALATED] " in front of a heading; nothing for ongoing issues. */
function changeTag(change: IssueChange | undefined): string {
  return change === "new" || change === "escalated" ? `[${change.toUpperCase()}] ` : "";
}

function renderIssue(issue: Issue, change?: IssueChange): string {
  const lines = [`#### ${changeTag(change)}${issue.title}`, ""];
  for (const e of issue.evidence) lines.push(`- ${truncate(e, 300)}`);
  if (issue.hint) lines.push("", `_Suggested next step:_ ${issue.hint}`);
  return lines.join("\n");
}

function controlPlaneRows(overview: ClusterOverview, issues: Issue[], now: Date): string[] {
  const cp = overview.controlPlane;
  const rows: string[] = [];
  if (cp.pods) {
    const ready = cp.pods.filter((p) => p.ready).length;
    const recent = issues
      .filter((i) => i.category === "controlplane-restart" || i.category === "controlplane-probe-failures")
      .map((i) => cp.pods!.find((p) => p.name === i.resource.name)?.component ?? i.resource.name);
    rows.push(
      `| Control-plane pods | ${ready}/${cp.pods.length} ready${recent.length > 0 ? `; recently restarted or failing probes: ${recent.join(", ")}` : ""} |`,
    );
  } else {
    rows.push("| Control-plane pods | not visible |");
  }
  if (cp.readyz) {
    const failing = cp.readyz.filter((c) => !c.ok);
    rows.push(
      `| API server health checks | ${cp.readyz.length - failing.length}/${cp.readyz.length} passing${failing.length > 0 ? ` (failing: ${cell(failing.map((c) => c.name).join(", "), 80)})` : ""} |`,
    );
  } else {
    rows.push("| API server health checks | not visible |");
  }
  if (cp.etcd?.dbSizeBytes !== undefined) {
    const ratio = Math.round((cp.etcd.dbSizeBytes / cp.etcd.quotaBytes) * 100);
    rows.push(
      `| etcd database | ${formatBytes(cp.etcd.dbSizeBytes)} of ${formatBytes(cp.etcd.quotaBytes)} quota (${ratio}%)${cp.etcd.quotaSource === "default" ? ", default quota assumed" : ""} |`,
    );
  } else {
    rows.push("| etcd database | not visible |");
  }
  if (cp.leaderLeases) {
    const leases = cp.leaderLeases.map((l) => {
      const age = l.renewTime ? Math.round((now.getTime() - Date.parse(l.renewTime)) / 1000) : undefined;
      return `${l.component} renewed ${age !== undefined ? `${age}s ago` : "never"}`;
    });
    const missing = cp.notVisible.filter((n) => n.includes("leader election")).map((n) => n.split(" ")[0]);
    rows.push(
      `| Leader election | ${leases.join(", ")}${missing.length > 0 ? `; not visible: ${missing.join(", ")}` : ""} |`,
    );
  } else {
    rows.push("| Leader election | not visible |");
  }
  if (cp.certificate) {
    const days = Math.floor((Date.parse(cp.certificate.notAfter) - now.getTime()) / 86_400_000);
    rows.push(
      `| API server certificate | ${days < 0 ? "expired" : `expires in ${days} days`} (${cp.certificate.notAfter.slice(0, 10)}) |`,
    );
  }
  const unreachable = overview.webhooks.filter(
    (w) => w.status === "service-missing" || w.status === "no-ready-endpoints",
  );
  rows.push(
    `| Admission webhooks | ${overview.webhooks.length}${unreachable.length > 0 ? `, ${unreachable.length} unreachable` : ""} |`,
  );
  const apis = overview.apiHealth.apiServices;
  rows.push(
    apis
      ? `| Aggregated APIs | ${apis.length}${apis.some((a) => !a.available) ? `, ${apis.filter((a) => !a.available).length} unavailable` : ""} |`
      : "| Aggregated APIs | not visible |",
  );
  const terminating = overview.apiHealth.terminatingNamespaces;
  rows.push(
    `| Namespaces terminating | ${terminating ? terminating.map((n) => n.name).join(", ") || "none" : "not visible"} |`,
  );
  return rows;
}

function resourceName(i: Issue): string {
  return `${i.resource.kind} ${i.resource.namespace ? `${i.resource.namespace}/` : ""}${i.resource.name}`;
}

/** A prompt using this share of NUM_CTX is close to being truncated. */
const CONTEXT_WARNING_RATIO = 0.8;

const n = (v: number) => v.toLocaleString("en-US");

function tokens(usage: LlmUsage, numCtx: number | undefined): string {
  const peak = `largest prompt ${n(usage.peakPromptTokens)}${numCtx ? ` of ${n(numCtx)}` : ""}`;
  return `${n(usage.promptTokens)} prompt + ${n(usage.outputTokens)} output tokens in ${usage.calls} LLM call(s), ${peak}`;
}

/** Set when a prompt came close to not fitting in the context window. */
function contextWarning(usage: LlmUsage | undefined, numCtx: number | undefined): string | undefined {
  if (!usage || !numCtx || usage.peakPromptTokens < numCtx * CONTEXT_WARNING_RATIO) return undefined;
  return `the largest prompt used ${Math.round((usage.peakPromptTokens / numCtx) * 100)}% of \`NUM_CTX\`; a longer one would not fit. Consider raising \`NUM_CTX\` or lowering \`TOOL_OUTPUT_MAX_CHARS\`.`;
}

/** A problem is new or escalated if any of its issues is; "new" wins. */
function problemChange(f: Finding, comparison: Comparison | undefined): IssueChange | undefined {
  if (!comparison) return undefined;
  const changes = [f.problem.primary, ...f.problem.related].map((i) => comparison.changes[i.id]);
  return changes.includes("new") ? "new" : changes.includes("escalated") ? "escalated" : "ongoing";
}

const code = (value: string) => `\`${value.replace(/`/g, "")}\``;

/** Notes after a fix step, e.g. "_(unverified: `nginx:1.25.9` does not appear in the cluster data)_". */
export function fixStepNotes(flags: FixFlag[]): string {
  const notes: string[] = [];
  const unverified = flags.filter((f) => f.kind === "unverified").map((f) => code(f.value));
  if (unverified.length > 0) {
    const verb = unverified.length === 1 ? "does" : "do";
    notes.push(`_(unverified: ${unverified.join(", ")} ${verb} not appear in the cluster data)_`);
  }
  for (const f of flags.filter((x) => x.kind !== "unverified")) {
    notes.push(
      `_(${f.kind === "destructive" ? "destructive" : "changes the cluster"}: ${code(f.value)} ${f.message})_`,
    );
  }
  return notes.join(" ");
}

function renderFinding(f: Finding, index: number, numCtx: number | undefined, change?: IssueChange): string {
  const { problem } = f;
  const affected = [problem.primary, ...problem.related].map(resourceName);
  const lines = [
    `### ${index}. ${changeTag(change)}[${problem.severity.toUpperCase()}] ${f.error ? problem.primary.title : truncate(f.summary, 160)}`,
    "",
    `**Affected:** ${[...new Set(affected)].join(", ")}`,
    "",
  ];
  const warning = contextWarning(f.usage, numCtx);
  if (warning) lines.push(`**Context limit:** ${warning}`, "");
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
    const steps = f.suggestedFix.map((s, i) => {
      const notes = fixStepNotes((f.fixFlags ?? []).filter((flag) => flag.step === i));
      return `${i + 1}. ${s}${notes ? ` ${notes}` : ""}`;
    });
    lines.push("**Suggested fix** (not applied):", "", ...steps, "");
  }
  const usage = f.usage && f.usage.calls > 0 ? ` · ${tokens(f.usage, numCtx)}` : "";
  const reason = f.confidenceReason ? ` (${f.confidenceReason})` : "";
  const repeats = f.repeatedCalls ? ` · ${f.repeatedCalls} repeated call(s) not run` : "";
  lines.push(`_Confidence: ${f.confidence}${reason} · ${f.toolCalls} tool call(s)${repeats}${usage}_`);
  return lines.join("\n");
}

export interface ReportInput {
  overview: ClusterOverview;
  issues: Issue[];
  ollama?: OllamaStatus;
  findings?: Finding[];
  /** Tokens used by triage, if the LLM client reports them. */
  triageUsage?: LlmUsage;
  /** Ollama context window, to show how close prompts came to it. */
  numCtx?: number;
  /** Why the LLM steps did not run, if they did not. */
  llmSkipped?: string;
  /** Changes since a previous report (`--compare`). */
  comparison?: Comparison;
  /** Why no comparison is shown although one was asked for. */
  comparisonNote?: string;
}

function renderChanges(issues: Issue[], c: Comparison): string[] {
  const counts = changeCounts(c);
  const out = ["## Changes since last run", "", `Compared with the report from ${c.previousScannedAt}.`, ""];
  if (counts.new + counts.escalated + counts.resolved === 0) {
    out.push(`No changes: ${counts.ongoing} ongoing issue(s).`, "");
    return out;
  }
  for (const change of ["new", "escalated"] as const) {
    for (const i of issues.filter((x) => c.changes[x.id] === change)) {
      out.push(`- **${change.toUpperCase()}** [${i.severity.toUpperCase()}] ${i.title}`);
    }
  }
  for (const r of c.resolved) out.push(`- **RESOLVED** [${r.severity.toUpperCase()}] ${r.title}`);
  out.push("");
  return out;
}

/**
 * Renders the report: summary table, LLM findings, the remaining rule-based issues by
 * severity, recent warning events, and scan notes (what could not be checked, LLM status).
 */
export function renderMarkdownReport({
  overview,
  issues,
  ollama,
  findings = [],
  triageUsage,
  numCtx,
  llmSkipped,
  comparison,
  comparisonNote,
}: ReportInput): string {
  const status = overallStatus(issues);
  const count = (s: Severity) => issues.filter((i) => i.severity === s).length;
  const readyNodes = overview.nodes.filter((n) => n.ready).length;
  const runningPods = overview.pods.filter((p) => p.phase === "Running").length;
  const healthyDeployments = overview.deployments.filter((d) => d.ready >= d.desired).length;
  const healthyWorkloads = overview.workloads.filter((w) => w.ready >= w.desired).length;
  const servicesDown = overview.services.filter((s) => s.readyEndpoints === 0).length;
  const dns = overview.dns.service;

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
    `| DaemonSets and StatefulSets fully ready | ${healthyWorkloads}/${overview.workloads.length} |`,
    `| Services without ready endpoints | ${servicesDown} of ${overview.services.length} |`,
    `| Jobs failed | ${overview.jobs.filter((j) => j.failedCondition).length} of ${overview.jobs.length} (CronJobs: ${overview.cronJobs.length}${overview.cronJobs.some((c) => c.suspended) ? `, ${overview.cronJobs.filter((c) => c.suspended).length} suspended` : ""}) |`,
    `| PersistentVolumeClaims bound | ${overview.persistentVolumeClaims.filter((c) => c.phase === "Bound").length}/${overview.persistentVolumeClaims.length} |`,
    `| Cluster DNS | ${dns ? `${dns.readyEndpoints}/${dns.readyEndpoints + dns.notReadyEndpoints} endpoints ready` : "not visible"} |`,
    `| Warning events (recent) | ${overview.warningEvents.length} |`,
    ...controlPlaneRows(overview, issues, new Date(overview.scannedAt)),
    `| Issues | ${count("critical")} critical, ${count("warning")} warning, ${count("info")} info |`,
    `| Investigated by LLM | ${findings.length > 0 ? `${findings.length} problem(s)` : "none"} |`,
  ];
  if (comparison) {
    const n = changeCounts(comparison);
    out.push(
      `| Since last run | ${n.new} new, ${n.escalated} escalated, ${n.resolved} resolved, ${n.ongoing} ongoing |`,
    );
  }
  out.push("");
  if (comparison) out.push(...renderChanges(issues, comparison));

  if (findings.length > 0) {
    out.push("## Investigated problems", "");
    findings.forEach((f, i) => out.push(renderFinding(f, i + 1, numCtx, problemChange(f, comparison)), ""));
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
      for (const issue of group) out.push(renderIssue(issue, comparison?.changes[issue.id]), "");
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
  for (const note of overview.apiHealth.notVisible) out.push(`- Not checked: ${note}`);
  if (overview.dns.notVisible) out.push(`- Not checked: cluster DNS: ${overview.dns.notVisible}`);
  if (ollama) {
    if (!ollama.reachable) out.push(`- LLM: ${ollama.error}`);
    else if (!ollama.modelAvailable)
      out.push(
        `- LLM: Ollama reachable, but model \`${ollama.model}\` is not pulled (\`ollama pull ${ollama.model}\`)`,
      );
    else out.push(`- LLM: \`${ollama.model}\` at ${ollama.url}`);
  }
  const total = [triageUsage, ...findings.map((f) => f.usage)].reduce<LlmUsage>(
    (sum, u) => (u ? addUsage(sum, u) : sum),
    emptyUsage(),
  );
  if (total.calls > 0) out.push(`- LLM usage: ${tokens(total, numCtx)}`);
  const triageWarning = contextWarning(triageUsage, numCtx);
  if (triageWarning) out.push(`- Context limit in triage: ${triageWarning}`);
  if (llmSkipped) out.push(`- LLM investigation skipped: ${llmSkipped}.`);
  if (comparisonNote) out.push(`- Changes since last run: ${comparisonNote}.`);
  out.push(
    '- Issues are detected by rules; root causes in "Investigated problems" come from the local LLM and may be wrong.',
    "- Suggested fixes are never applied automatically.",
    "",
  );
  return out.join("\n");
}
