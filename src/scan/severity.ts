import type { Severity } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Sort comparator: critical first, then warning, then info. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** The most severe of `severities`; "info" when empty. */
export function worstSeverity(severities: Severity[]): Severity {
  return [...severities].sort(compareSeverity)[0] ?? "info";
}
