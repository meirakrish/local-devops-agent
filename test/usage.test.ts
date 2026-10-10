import { describe, expect, it } from "vitest";
import type { Finding } from "../src/agent/types.js";
import { type LlmUsage, UsageMeter } from "../src/llm/model.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import type { ClusterOverview, Issue } from "../src/scan/types.js";

const overview: ClusterOverview = {
  context: "kind-demo",
  scannedAt: "2026-01-01T12:00:00.000Z",
  namespaces: [],
  nodes: [],
  pods: [],
  deployments: [],
  workloads: [],
  services: [],
  dns: {},
  podCreateFailures: [],
  warningEvents: [],
  controlPlane: { notVisible: [] },
  webhooks: [],
  errors: [],
};

const crash: Issue = {
  id: "pod/default/web:crashloop",
  severity: "critical",
  category: "crashloop",
  resource: { kind: "Pod", namespace: "default", name: "web" },
  title: "Pod default/web: crashloop",
  evidence: ["container app is in CrashLoopBackOff"],
};

const usage = (u: Partial<LlmUsage>): LlmUsage => ({
  calls: 3,
  promptTokens: 9000,
  outputTokens: 400,
  peakPromptTokens: 4000,
  ...u,
});

function finding(u: LlmUsage): Finding {
  return {
    problem: { primary: crash, related: [], reason: "", severity: "critical" },
    summary: "web crashes on start",
    rootCause: "DATABASE_URL is not set",
    evidence: [],
    suggestedFix: [],
    confidence: "high",
    toolCalls: 2,
    usage: u,
  };
}

describe("UsageMeter", () => {
  it("adds up calls, keeps the largest prompt and resets on take", () => {
    const meter = new UsageMeter();
    meter.record({ input_tokens: 1000, output_tokens: 20, total_tokens: 1020 });
    meter.record({ input_tokens: 2500, output_tokens: 30, total_tokens: 2530 });
    meter.record(undefined); // a response without usage still counts as a call
    expect(meter.take()).toEqual({ calls: 3, promptTokens: 3500, outputTokens: 50, peakPromptTokens: 2500 });
    expect(meter.take()).toEqual({ calls: 0, promptTokens: 0, outputTokens: 0, peakPromptTokens: 0 });
  });
});

describe("report: token usage", () => {
  it("shows tokens per finding and the run total in scan notes", () => {
    const md = renderMarkdownReport({
      overview,
      issues: [crash],
      findings: [finding(usage({}))],
      triageUsage: usage({ calls: 1, promptTokens: 1200, outputTokens: 80, peakPromptTokens: 1200 }),
      numCtx: 16384,
    });
    expect(md).toContain(
      "_Confidence: high · 2 tool call(s) · 9,000 prompt + 400 output tokens in 3 LLM call(s), largest prompt 4,000 of 16,384_",
    );
    expect(md).toContain(
      "- LLM usage: 10,200 prompt + 480 output tokens in 4 LLM call(s), largest prompt 4,000 of 16,384",
    );
    expect(md).not.toContain("Context limit");
  });

  it("warns when a prompt nears NUM_CTX, in a finding or in triage", () => {
    const md = renderMarkdownReport({
      overview,
      issues: [crash],
      findings: [finding(usage({ peakPromptTokens: 14000 }))],
      triageUsage: usage({ calls: 1, peakPromptTokens: 13500 }),
      numCtx: 16384,
    });
    expect(md).toContain("**Context limit:** the largest prompt used 85% of `NUM_CTX`");
    expect(md).toContain("- Context limit in triage: the largest prompt used 82% of `NUM_CTX`");
  });

  it("leaves usage out when the LLM client does not report it", () => {
    const { usage: _, ...noUsage } = finding(usage({}));
    const md = renderMarkdownReport({ overview, issues: [crash], findings: [noUsage] });
    expect(md).toContain("_Confidence: high · 2 tool call(s)_");
    expect(md).not.toContain("LLM usage");
  });
});
