import type { LlmUsage } from "../llm/model.js";
import type { Issue, Severity } from "../scan/types.js";

/** A problem chosen by triage: one primary issue plus issues sharing its root cause. */
export interface Problem {
  primary: Issue;
  related: Issue[];
  /** Why triage picked it (from the LLM, or "fallback"). */
  reason: string;
  severity: Severity;
}

export type Confidence = "low" | "medium" | "high";

/** Result of investigating one problem. */
export interface Finding {
  problem: Problem;
  summary: string;
  rootCause: string;
  evidence: string[];
  suggestedFix: string[];
  confidence: Confidence;
  toolCalls: number;
  /** Tokens used by this investigation, if the LLM client reports them. */
  usage?: LlmUsage;
  /** Set when the investigation failed; the report falls back to rule-based info. */
  error?: string;
}
