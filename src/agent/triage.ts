import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { errorMessage } from "../errors.js";
import type { LlmClient } from "../llm/model.js";
import { compareSeverity, worstSeverity } from "../scan/severity.js";
import type { ClusterOverview, Issue } from "../scan/types.js";
import type { Problem } from "./types.js";

const SYSTEM_PROMPT = `You are a Kubernetes SRE triaging the results of a cluster health check.
You get a list of issues found by rule-based checks. Choose the distinct problems worth investigating.

Rules:
- Merge issues that share one root cause into a single problem. Example: a Deployment with 0 ready
  replicas and the crashing pods of that Deployment are ONE problem; use the pod issue as primary
  because pods have logs and events.
- Several pods of the same Deployment failing the same way are ONE problem.
- A Service without ready endpoints and the failing pods it selects are ONE problem; use the pod issue as primary.
- An unavailable APIService and namespaces stuck Terminating because of API discovery are ONE problem; use the APIService as primary.
- Prefer critical issues, then warnings. Skip info issues unless nothing else is wrong.
- Use only issue ids from the list, exactly as written.`;

/** One line per issue (id, severity, title, first evidence), kept short for the model. */
export function formatIssuesForPrompt(overview: ClusterOverview, issues: Issue[]): string {
  const lines = [
    `Cluster: ${overview.nodes.length} nodes, ${overview.pods.length} pods, ${overview.deployments.length} deployments.`,
    "Issues:",
    ...issues.map((i) => `- id=${i.id} severity=${i.severity} :: ${i.title} :: ${i.evidence[0] ?? ""}`.slice(0, 400)),
  ];
  return lines.join("\n");
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
  "leader-election-stale",
]);

/**
 * An unavailable aggregated API (APIService) blocks API discovery, which stops namespace
 * deletion, so namespaces stuck on discovery form one problem with the broken APIServices.
 */
const AGGREGATED_API_CATEGORIES = new Set(["apiservice-unavailable", "namespace-terminating-api"]);

/**
 * Lower is a better starting point. Within a control-plane incident, follow the
 * dependencies upward: etcd, then the API server, then the rest. Otherwise prefer pods,
 * which have logs and events.
 */
function primaryRank(i: Issue): number {
  // A controller that cannot create pods has no pods to look at; its events explain why.
  const notPod = i.resource.kind === "Pod" || i.category === "pod-create-failed" ? 0 : 1;
  if (CONTROL_PLANE_CATEGORIES.has(i.category)) {
    const name = i.resource.name;
    if (name === "etcd" || name.startsWith("etcd-")) return 0 + notPod;
    if (name === "kube-apiserver" || name.startsWith("kube-apiserver-")) return 2 + notPod;
    return 4 + notPod;
  }
  // The APIService is the cause; the stuck namespaces are the symptom.
  if (i.category === "apiservice-unavailable") return 6;
  return 10 + notPod;
}

/** Builds a Problem, picking the primary issue by primaryRank (ties keep the given order). */
function makeProblem(chosen: Issue, others: Issue[], reason: string): Problem {
  const all = [chosen, ...others];
  const primary = all.reduce((best, i) => (primaryRank(i) < primaryRank(best) ? i : best));
  const related = all.filter((i) => i !== primary);
  return { primary, related, reason, severity: worstSeverity(all.map((i) => i.severity)) };
}

/**
 * Issues with the same key belong to the same workload: a Deployment, StatefulSet or
 * DaemonSet, its pods, a Service in front of them, and failures to create its pods.
 * The rules set `workload` from the pods' owners; anything else stands alone.
 */
export function groupKey(i: Issue): string {
  if (CONTROL_PLANE_CATEGORIES.has(i.category)) return "control-plane";
  if (AGGREGATED_API_CATEGORIES.has(i.category)) return "aggregated-api";
  if (i.workload) return i.workload;
  return `${i.resource.kind}/${i.resource.namespace ?? ""}/${i.resource.name}`;
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
    problems.push(
      makeProblem(
        issue,
        group.filter((i) => i !== issue),
        "fallback: rule-based grouping",
      ),
    );
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
    // Issues of two different workloads do not share a root cause the model can see; in
    // testing it merged unrelated broken Deployments into an OOM problem, which split them
    // from their own pods and storage issues. Those stay available for their own problem.
    const otherWorkload = (i: Issue) =>
      i.workload !== undefined && primary.workload !== undefined && i.workload !== primary.workload;
    const related = (pick.relatedIssueIds ?? [])
      .map((id) => byId.get(id))
      .filter((i): i is Issue => i !== undefined && !used.has(i.id) && i !== primary && !otherWorkload(i));
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

/**
 * Adds critical issues the LLM left out, while there is room under the limit. With many
 * issues, the model sometimes returns fewer problems than allowed and skips critical ones
 * (in testing: an OOM-killed pod and an unreachable webhook). Warnings stay its choice.
 */
export function addMissedCritical(problems: Problem[], issues: Issue[], maxProblems: number): Problem[] {
  const room = maxProblems - problems.length;
  if (room <= 0) return problems;
  const used = new Set(problems.flatMap((p) => [p.primary, ...p.related].map((i) => i.id)));
  const unused = issues.filter((i) => !used.has(i.id));
  // Critical groups come first in the fallback, so taking `room` of them keeps the most severe.
  const missed = fallbackTriage(unused, room)
    .filter((p) => p.severity === "critical")
    .map((p) => ({ ...p, reason: "added: critical issue not chosen by the LLM" }));
  return [...problems, ...missed].sort((a, b) => compareSeverity(a.severity, b.severity));
}

/**
 * Asks the LLM which problems to investigate, then fixes up its answer in code (merging,
 * adding missed critical issues). Falls back to rule-based grouping if the LLM fails.
 */
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
    if (problems.length > 0) {
      const completed = addMissedCritical(problems, issues, maxProblems);
      if (completed.length > problems.length)
        log(`triage: added ${completed.length - problems.length} critical problem(s) the LLM left out`);
      return completed;
    }
    log("triage: LLM returned no usable problems, using fallback");
  } catch (err) {
    log(`triage: LLM failed (${errorMessage(err)}), using fallback`);
  }
  return fallbackTriage(issues, maxProblems);
}
