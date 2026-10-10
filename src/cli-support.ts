import type { JsonReport } from "./report/json.js";

/** Pure helpers for the CLI: context lists, per-context file names and the exit decision. */

export const FAIL_ON = ["critical", "new"] as const;
export type FailOn = (typeof FAIL_ON)[number];

/** `--context a,b --context c` -> ["a", "b", "c"], without duplicates or empty entries. */
export function parseContexts(values: string[] | undefined): string[] {
  const names = (values ?? []).flatMap((v) => v.split(",")).map((v) => v.trim());
  return [...new Set(names.filter(Boolean))];
}

export const CONTEXT_PLACEHOLDER = "{context}";

/**
 * A context name usable in a file name. EKS contexts look like
 * "arn:aws:eks:eu-west-1:123456789012:cluster/prod", so ":" and "/" must go.
 */
export function safeFileName(context: string): string {
  return context.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Replaces "{context}" in a --output or --compare path. With several contexts the
 * placeholder is required, or every context would overwrite (or compare with) one file.
 */
export function pathForContext(template: string, context: string, multipleContexts: boolean): string {
  if (template.includes(CONTEXT_PLACEHOLDER)) return template.replaceAll(CONTEXT_PLACEHOLDER, safeFileName(context));
  if (multipleContexts) {
    throw new Error(
      `with several contexts, "${template}" must contain ${CONTEXT_PLACEHOLDER}, e.g. reports/${CONTEXT_PLACEHOLDER}.json`,
    );
  }
  return template;
}

/**
 * Whether a report should fail the run (exit code 2).
 * - "critical": any critical issue.
 * - "new": only critical issues that are new or escalated since the compared report. When
 *   there was nothing to compare with (first run, other context), every critical issue
 *   counts as new, so a real outage is never hidden.
 */
export function shouldFail(report: JsonReport, failOn: FailOn): boolean {
  const critical = report.issues.filter((i) => i.severity === "critical");
  if (failOn === "critical" || !report.comparison) return critical.length > 0;
  return critical.some((i) => i.change === "new" || i.change === "escalated");
}
