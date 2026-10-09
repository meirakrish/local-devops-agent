import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { LlmClient } from "../llm/model.js";
import { compareSeverity } from "../scan/rules.js";
import type { ClusterOverview, Issue, Severity } from "../scan/types.js";
import type { Problem } from "./types.js";

const SYSTEM_PROMPT = `You are a Kubernetes SRE triaging the results of a cluster health check.
You get a list of issues found by rule-based checks. Choose the distinct problems worth investigating.

Rules:
- Merge issues that share one root cause into a single problem. Example: a Deployment with 0 ready
  replicas and the crashing pods of that Deployment are ONE problem; use the pod issue as primary
  because pods have logs and events.
- Several pods of the same Deployment failing the same way are ONE problem.
- Prefer critical issues, then warnings. Skip info issues unless nothing else is wrong.
- Use only issue ids from the list, exactly as written.`;

export function formatIssuesForPrompt(overview: ClusterOverview, issues: Issue[]): string {
  const lines = [
    `Cluster: ${overview.nodes.length} nodes, ${overview.pods.length} pods, ${overview.deployments.length} deployments.`,
    "Issues:",
    ...issues.map((i) => `- id=${i.id} severity=${i.severity} :: ${i.title} :: ${i.evidence[0] ?? ""}`.slice(0, 400)),
  ];
  return lines.join("\n");
}

function worstSeverity(issues: Issue[]): Severity {
  return issues.map((i) => i.severity).sort(compareSeverity)[0] ?? "info";
}

/**
 * Control-plane failures cascade (slow etcd -> API server errors -> scheduler and
 * controller-manager lose leader election and restart), so all control-plane health
 * issues form one problem. Done in code because the model grouped them only sometimes.
 */
const CONTROL_PLANE_CATEGORIES = new Set([
  "etcd-unhealthy",
  "apiserver-not-ready",
  "controlplane-pod-down",
  "controlplane-restart",
  "controlplane-probe-failures",
]);

/**
 * Lower is a better starting point. Within a control-plane incident, follow the
 * dependencies upward: etcd, then the API server, then the rest. Otherwise prefer pods,
 * which have logs and events.
 */
function primaryRank(i: Issue): number {
  const notPod = i.resource.kind === "Pod" ? 0 : 1;
  if (CONTROL_PLANE_CATEGORIES.has(i.category)) {
    const name = i.resource.name;
    if (name === "etcd" || name.startsWith("etcd-")) return 0 + notPod;
    if (name === "kube-apiserver" || name.startsWith("kube-apiserver-")) return 2 + notPod;
    return 4 + notPod;
  }
  return 10 + notPod;
}

/** Builds a Problem, picking the primary issue by primaryRank (ties keep the given order). */
function makeProblem(chosen: Issue, others: Issue[], reason: string): Problem {
  const all = [chosen, ...others];
  const primary = all.reduce((best, i) => (primaryRank(i) < primaryRank(best) ? i : best));
  const related = all.filter((i) => i !== primary);
  return { primary, related, reason, severity: worstSeverity(all) };
}

/** "web-7db8d69f68-4f2n7" belongs to Deployment "web" (ReplicaSet hash + pod suffix). */
function deploymentOfPod(podName: string): string | undefined {
  const m = /^(.+)-[a-z0-9]{6,10}-[a-z0-9]{5}$/.exec(podName);
  return m?.[1];
}

/** Issues with the same key belong to the same workload (a Deployment and its pods). */
export function groupKey(i: Issue): string {
  if (CONTROL_PLANE_CATEGORIES.has(i.category)) return "control-plane";
  if (i.resource.kind === "Pod") {
    return `${i.resource.namespace}/${deploymentOfPod(i.resource.name) ?? i.resource.name}`;
  }
  if (i.resource.kind === "Deployment") return `${i.resource.namespace}/${i.resource.name}`;
  return `${i.resource.kind}/${i.resource.name}`;
}

/**
 * Deterministic triage used when the LLM is unavailable or returns nothing usable:
 * groups each Deployment issue with the pod issues of that Deployment, and keeps one
 * problem per group, most severe first.
 */
export function fallbackTriage(issues: Issue[], maxProblems: number): Problem[] {
  const candidates = issues.filter((i) => i.severity !== "info");
  const used = new Set<string>();
  const problems: Problem[] = [];

  for (const issue of [...candidates].sort((a, b) => compareSeverity(a.severity, b.severity))) {
    if (used.has(issue.id)) continue;
    const group = candidates.filter((i) => !used.has(i.id) && groupKey(i) === groupKey(issue));
    group.forEach((i) => used.add(i.id));
    problems.push(makeProblem(issue, group.filter((i) => i !== issue), "fallback: rule-based grouping"));
    if (problems.length >= maxProblems) break;
  }
  return problems;
}

/**
 * Turns the LLM's picks into Problems. The schema already limits ids to real ones;
 * this also drops duplicates and issues used twice, merges issues of the same
 * workload, and stops at the limit.
 */
export function buildProblems(
  picks: { issueId: string; relatedIssueIds?: string[]; reason?: string }[],
  issues: Issue[],
  maxProblems: number,
): Problem[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const used = new Set<string>();
  const problems: Problem[] = [];
  for (const pick of picks) {
    const primary = byId.get(pick.issueId);
    if (!primary || used.has(primary.id)) continue;
    used.add(primary.id);
    const related = (pick.relatedIssueIds ?? [])
      .map((id) => byId.get(id))
      .filter((i): i is Issue => i !== undefined && !used.has(i.id) && i !== primary);
    // Also absorb issues of the same workload, in case the model did not merge them.
    for (const i of issues) {
      if (!used.has(i.id) && i !== primary && !related.includes(i) && groupKey(i) === groupKey(primary)) {
        related.push(i);
      }
    }
    related.forEach((i) => used.add(i.id));
    problems.push(makeProblem(primary, related, pick.reason ?? ""));
    if (problems.length >= maxProblems) break;
  }
  return problems.sort((a, b) => compareSeverity(a.severity, b.severity));
}

export async function triage(
  llm: LlmClient,
  overview: ClusterOverview,
  issues: Issue[],
  maxProblems: number,
  log: (msg: string) => void = () => {},
): Promise<Problem[]> {
  if (issues.length === 0) return [];
  const ids = issues.map((i) => i.id) as [string, ...string[]];
  // z.enum becomes a JSON-schema enum, so Ollama can only generate real issue ids.
  const IssueId = z.enum(ids);
  const schema = z.object({
    problems: z
      .array(
        z.object({
          issueId: IssueId.describe("Primary issue id"),
          relatedIssueIds: z.array(IssueId).describe("Other issue ids with the same root cause"),
          reason: z.string().describe("One short sentence: why investigate this"),
        }),
      )
      .describe(`At most ${maxProblems} problems, most important first`),
  });

  try {
    const result = await llm.structured(
      schema,
      [
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(`${formatIssuesForPrompt(overview, issues)}\n\nChoose at most ${maxProblems} problems.`),
      ],
      "triage",
    );
    const problems = buildProblems(result.problems, issues, maxProblems);
    if (problems.length > 0) return problems;
    log("triage: LLM returned no usable problems, using fallback");
  } catch (err) {
    log(`triage: LLM failed (${err instanceof Error ? err.message : String(err)}), using fallback`);
  }
  return fallbackTriage(issues, maxProblems);
}
