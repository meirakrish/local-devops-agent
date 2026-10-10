import { readFile } from "node:fs/promises";
import { z } from "zod";
import { errorMessage } from "../errors.js";
import { compareSeverity } from "../scan/severity.js";
import type { ClusterOverview, Issue, Severity } from "../scan/types.js";

/**
 * Compares this run's issues with a previous JSON report, so a scheduled run can say what
 * is new, what got worse and what was resolved instead of repeating every issue.
 */

export type IssueChange = "new" | "escalated" | "ongoing";

/** An issue as stored in a previous JSON report. */
export interface PreviousIssue {
  key: string;
  id: string;
  severity: Severity;
  title: string;
}

export interface PreviousReport {
  context: string;
  namespace: string | null;
  scannedAt: string;
  issues: PreviousIssue[];
}

export interface Comparison {
  previousScannedAt: string;
  /** Change per current issue id. */
  changes: Record<string, IssueChange>;
  /** Issues of the previous run that are gone now. */
  resolved: PreviousIssue[];
}

/** Pods and ReplicaSets get new names when they are recreated; their workload does not. */
const RECREATED_KINDS = new Set(["Pod", "ReplicaSet"]);

/**
 * Identity of an issue across runs. Usually its id, but a crashlooping pod that is replaced
 * by a new crashlooping pod is the same problem, so pod and ReplicaSet issues of a workload
 * are keyed by the workload and the kind of failure.
 */
export function issueKey(issue: Issue): string {
  if (issue.workload && RECREATED_KINDS.has(issue.resource.kind)) {
    return `${issue.resource.kind.toLowerCase()}@${issue.workload}:${issue.category}`;
  }
  return issue.id;
}

const PreviousReportSchema = z.object({
  schemaVersion: z.literal(1),
  context: z.string(),
  namespace: z.string().nullable(),
  scannedAt: z.string(),
  issues: z.array(
    z.object({
      key: z.string(),
      id: z.string(),
      severity: z.enum(["critical", "warning", "info"]),
      title: z.string(),
    }),
  ),
});

/**
 * Reads a previous JSON report. A missing file is normal on the first scheduled run, and a
 * bad one should not stop the health check, so both return a note instead of throwing.
 */
export async function loadPreviousReport(path: string): Promise<{ report?: PreviousReport; note?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { note: `no previous report at ${path} yet; changes are shown from the next run` };
    }
    return { note: `could not read previous report ${path}: ${errorMessage(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { note: `previous report ${path} is not JSON; save it with \`--output <file>.json\`` };
  }
  const parsed = PreviousReportSchema.safeParse(json);
  if (!parsed.success) return { note: `previous report ${path} is not a JSON report from this tool` };
  return { report: parsed.data };
}

/**
 * Compares the current issues with a previous report of the same cluster and scope.
 * Reports of another cluster or namespace are not comparable and return a note instead.
 */
export function compareWithPrevious(
  overview: ClusterOverview,
  issues: Issue[],
  previous: PreviousReport,
): { comparison?: Comparison; note?: string } {
  if (previous.context !== overview.context) {
    return { note: `not compared: the previous report is of context "${previous.context}"` };
  }
  const namespace = overview.namespaceFilter ?? null;
  if (previous.namespace !== namespace) {
    const scope = (ns: string | null) => (ns ? `namespace "${ns}"` : "all namespaces");
    return {
      note: `not compared: the previous report covered ${scope(previous.namespace)}, this one ${scope(namespace)}`,
    };
  }

  // Several issues can share a key (pods of one workload); keep the worst severity.
  const before = new Map<string, PreviousIssue>();
  for (const p of previous.issues) {
    const seen = before.get(p.key);
    if (!seen || compareSeverity(p.severity, seen.severity) < 0) before.set(p.key, p);
  }

  const changes: Record<string, IssueChange> = {};
  const currentKeys = new Set<string>();
  for (const issue of issues) {
    const key = issueKey(issue);
    currentKeys.add(key);
    const old = before.get(key);
    changes[issue.id] = !old ? "new" : compareSeverity(issue.severity, old.severity) < 0 ? "escalated" : "ongoing";
  }
  const resolved = [...before.values()].filter((p) => !currentKeys.has(p.key));
  return { comparison: { previousScannedAt: previous.scannedAt, changes, resolved } };
}

/** Counts of each kind of change, for summaries. */
export function changeCounts(c: Comparison): { new: number; escalated: number; ongoing: number; resolved: number } {
  const values = Object.values(c.changes);
  return {
    new: values.filter((v) => v === "new").length,
    escalated: values.filter((v) => v === "escalated").length,
    ongoing: values.filter((v) => v === "ongoing").length,
    resolved: c.resolved.length,
  };
}
