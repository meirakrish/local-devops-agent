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

/** A note on one suggested-fix step (see agent/fix-check.ts). */
export interface FixFlag {
  /** 0-based index into `suggestedFix`. */
  step: number;
  /** unverified: a concrete value not found in the cluster data. */
  kind: "unverified" | "destructive" | "changes-cluster";
  /** The value or command the flag is about, e.g. "nginx:1.25.9" or "kubectl delete". */
  value: string;
  message: string;
}

/** Result of investigating one problem. */
export interface Finding {
  problem: Problem;
  summary: string;
  rootCause: string;
  evidence: string[];
  suggestedFix: string[];
  /** Computed from the evidence (agent/confidence.ts); the model's rating is only an upper bound. */
  confidence: Confidence;
  /** Why `confidence` has its value, e.g. "evidence not found in tool output; the model said high". */
  confidenceReason?: string;
  /** The model's own rating. */
  modelConfidence?: Confidence;
  /** Notes on suggested-fix steps: invented values, destructive commands. */
  fixFlags?: FixFlag[];
  /** Tool calls that ran (repeats of an earlier call are not run and not counted). */
  toolCalls: number;
  /** Calls the model repeated with identical arguments; they were answered without running. */
  repeatedCalls?: number;
  /** Tokens used by this investigation, if the LLM client reports them. */
  usage?: LlmUsage;
  /** Set when the investigation failed; the report falls back to rule-based info. */
  error?: string;
}
