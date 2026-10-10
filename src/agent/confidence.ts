import { Corpus } from "./grounding.js";
import type { Confidence } from "./types.js";

/** How the tool-calling loop ended. */
export type StopReason = "model" | "step-limit" | "repeats";

export interface ConfidenceInput {
  /** What the model rated its own finding. Used only as an upper bound. */
  modelConfidence: Confidence;
  rootCause: string;
  evidence: string[];
  /** Outputs of the tool calls that returned data (the seed call included). */
  toolOutputs: string[];
  /** Titles and evidence of the problem's rule-based issues. */
  ruleText: string[];
  stopReason: StopReason;
}

export interface ConfidenceResult {
  confidence: Confidence;
  reason: string;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

/** A root cause sharing this much of its wording with the rule text adds nothing new. */
const RESTATES_RULE = 0.8;

/**
 * Confidence computed from the evidence, because the model rates almost everything "high".
 * Each check that fails caps the result; the model's rating is a further cap:
 *
 * - no tool call returned data, or no evidence point is found in tool output: low
 * - fewer than half of the evidence points are found in tool output: medium
 * - the root cause restates the rule's own title or evidence, and no evidence point
 *   found in tool output goes beyond the rule: medium
 * - the loop used the whole step budget, so the model never said it was done: medium
 *
 * Ending on repeated calls does not lower confidence: in the demo runs, a model that
 * repeats a call has usually seen everything it needs (a correct finding ended that way).
 *
 * "Found in tool output" is a word-overlap check (see Corpus.supports): a quoted or
 * closely paraphrased log line, event or condition passes; a number that never appeared
 * (a misread request, an invented percentage) fails.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const tools = new Corpus(input.toolOutputs);
  const rules = new Corpus(input.ruleText);
  const caps: { level: Confidence; reason: string }[] = [];

  const grounded = input.evidence.filter((e) => tools.supports(e));
  const n = input.evidence.length;
  const found = `${grounded.length} of ${n} evidence point(s) found in tool output`;
  if (tools.empty) caps.push({ level: "low", reason: "no tool call returned data" });
  if (n === 0) caps.push({ level: "low", reason: "no evidence given" });
  else if (grounded.length === 0) caps.push({ level: "low", reason: "evidence not found in tool output" });
  else if (grounded.length * 2 < n) caps.push({ level: "medium", reason: `only ${found}` });

  const restates = rules.coverage(input.rootCause) >= RESTATES_RULE;
  if (restates && !grounded.some((e) => !rules.supports(e))) {
    caps.push({ level: "medium", reason: "root cause only restates the rule's finding" });
  }
  if (input.stopReason === "step-limit") {
    caps.push({ level: "medium", reason: "step limit reached before the model finished" });
  }

  const confidence = caps.reduce((c, cap) => lower(c, cap.level), input.modelConfidence);
  const causes = caps.filter((c) => c.level === confidence).map((c) => c.reason);
  if (confidence !== input.modelConfidence) causes.push(`the model said ${input.modelConfidence}`);
  else if (causes.length === 0) {
    causes.push(confidence === "high" ? found : `the model's own rating; ${found}`);
  }
  return { confidence, reason: causes.join("; ") };
}
