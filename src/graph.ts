import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { investigate } from "./agent/investigate.js";
import { triage } from "./agent/triage.js";
import type { Finding, Problem } from "./agent/types.js";
import type { Config } from "./config.js";
import type { K8sClients } from "./k8s/client.js";
import type { LlmClient, LlmUsage } from "./llm/model.js";
import { checkOllama, type OllamaStatus } from "./llm/ollama.js";
import { compareWithPrevious, type PreviousReport } from "./report/compare.js";
import { buildJsonReport, type JsonReport } from "./report/json.js";
import { renderMarkdownReport, type ReportInput } from "./report/markdown.js";
import { detectIssues } from "./scan/detect.js";
import { scanCluster } from "./scan/scan.js";
import type { ClusterOverview, Issue } from "./scan/types.js";
import { createK8sTools } from "./tools/k8s-tools.js";

/**
 * Graph state. Each node returns a partial update that LangGraph merges in.
 * Without a reducer, a key simply keeps the last value written to it.
 */
export const HealthCheckState = Annotation.Root({
  overview: Annotation<ClusterOverview>(),
  issues: Annotation<Issue[]>(),
  ollama: Annotation<OllamaStatus>(),
  problems: Annotation<Problem[]>(),
  findings: Annotation<Finding[]>(),
  /** Tokens used by triage, if the LLM client reports them. */
  triageUsage: Annotation<LlmUsage | undefined>(),
  /** Why the LLM steps were skipped, if they were. */
  llmSkipped: Annotation<string | undefined>(),
  // Note: state keys and node names share a namespace, so this cannot be "report".
  markdown: Annotation<string>(),
  json: Annotation<JsonReport>(),
});

export type HealthCheckStateType = typeof HealthCheckState.State;

export interface GraphDeps {
  config: Config;
  k8s: K8sClients;
  namespace?: string;
  /** Omit to run without the LLM (rule-based report only). */
  llm?: LlmClient;
  /** A previous report to compare with (`--compare`), or why it could not be loaded. */
  previous?: { report?: PreviousReport; note?: string };
  log?: (message: string) => void;
}

function tokensLog(usage: LlmUsage | undefined): string {
  if (!usage || usage.calls === 0) return "";
  return `, ${usage.promptTokens} prompt + ${usage.outputTokens} output tokens, largest prompt ${usage.peakPromptTokens}`;
}

/**
 * Flow:
 *
 *   START ─┬─> scan ─────┬─> triage ─┬─> investigate ─> report ─> END
 *          └─> checkLlm ─┘           └──────────────────> ┘
 *
 * `scan` and `checkLlm` run in parallel; `triage` waits for both. When the LLM is
 * unavailable or there is nothing to investigate, triage returns no problems and
 * the graph goes straight to `report` (rule-based report).
 */
export function buildGraph(deps: GraphDeps) {
  const log = deps.log ?? (() => {});

  async function scan(): Promise<Partial<HealthCheckStateType>> {
    log(`scan: listing cluster resources (${deps.namespace ? `namespace ${deps.namespace}` : "all namespaces"})`);
    const now = new Date();
    const overview = await scanCluster(deps.k8s, {
      namespace: deps.namespace,
      eventWindowMinutes: deps.config.eventWindowMinutes,
      now,
    });
    const issues = detectIssues(overview, {
      restartThreshold: deps.config.restartThreshold,
      now,
      windowMinutes: deps.config.eventWindowMinutes,
    });
    log(
      `scan: ${overview.nodes.length} nodes, ${overview.pods.length} pods, ` +
        `${overview.deployments.length} deployments, ${overview.warningEvents.length} warning events, ` +
        `${issues.length} issues`,
    );
    return { overview, issues };
  }

  async function checkLlm(): Promise<Partial<HealthCheckStateType>> {
    const ollama = await checkOllama(deps.config.ollamaUrl, deps.config.model);
    log(
      `checkLlm: ${ollama.reachable ? "reachable" : "unreachable"}` +
        (ollama.reachable ? `, model ${ollama.modelAvailable ? "available" : "missing"}` : ""),
    );
    return { ollama };
  }

  async function triageNode(state: HealthCheckStateType): Promise<Partial<HealthCheckStateType>> {
    const skip = (llmSkipped: string) => {
      log(`triage: skipped (${llmSkipped})`);
      return { problems: [], findings: [], llmSkipped };
    };
    if (!deps.llm) return skip("disabled with --no-llm");
    if (!state.ollama.reachable) return skip(state.ollama.error ?? "Ollama unreachable");
    if (!state.ollama.modelAvailable) return skip(`model ${deps.config.model} is not pulled`);
    if (state.issues.length === 0) return skip("no issues found");

    const started = Date.now();
    deps.llm.takeUsage?.();
    const problems = await triage(deps.llm, state.overview, state.issues, deps.config.maxProblems, log);
    const triageUsage = deps.llm.takeUsage?.();
    log(`triage: ${problems.length} problem(s) to investigate (${Date.now() - started}ms${tokensLog(triageUsage)})`);
    for (const p of problems) {
      log(`  - ${p.primary.id}${p.related.length > 0 ? ` (+${p.related.length} related)` : ""}`);
    }
    return { problems, triageUsage, llmSkipped: undefined };
  }

  async function investigateNode(state: HealthCheckStateType): Promise<Partial<HealthCheckStateType>> {
    const tools = createK8sTools(deps.k8s, {
      maxChars: deps.config.toolOutputMaxChars,
      windowMinutes: deps.config.eventWindowMinutes,
    });
    const findings: Finding[] = [];
    // Sequential on purpose: a local GPU serves one request at a time anyway,
    // and sequential logs are easier to follow.
    for (const [index, problem] of state.problems.entries()) {
      log(`investigate [${index + 1}/${state.problems.length}] ${problem.primary.title}`);
      const started = Date.now();
      const finding = await investigate(problem, {
        llm: deps.llm!,
        tools,
        maxSteps: deps.config.maxStepsPerProblem,
        log,
      });
      log(
        finding.error
          ? `  failed: ${finding.error}`
          : `  done: ${finding.toolCalls} tool call(s), confidence ${finding.confidence} (${Date.now() - started}ms${tokensLog(finding.usage)})`,
      );
      findings.push(finding);
    }
    return { findings };
  }

  function report(state: HealthCheckStateType): Partial<HealthCheckStateType> {
    log("report: rendering markdown and JSON");
    const compared = deps.previous?.report
      ? compareWithPrevious(state.overview, state.issues, deps.previous.report)
      : { note: deps.previous?.note };
    if (compared.note) log(`report: ${compared.note}`);
    const input: ReportInput = {
      overview: state.overview,
      issues: state.issues,
      ollama: state.ollama,
      findings: state.findings,
      triageUsage: state.triageUsage,
      numCtx: deps.config.numCtx,
      llmSkipped: state.llmSkipped,
      comparison: compared.comparison,
      comparisonNote: compared.note,
    };
    return { markdown: renderMarkdownReport(input), json: buildJsonReport(input) };
  }

  return new StateGraph(HealthCheckState)
    .addNode("scan", scan)
    .addNode("checkLlm", checkLlm)
    .addNode("triage", triageNode)
    .addNode("investigate", investigateNode)
    .addNode("report", report)
    .addEdge(START, "scan")
    .addEdge(START, "checkLlm")
    .addEdge(["scan", "checkLlm"], "triage")
    .addConditionalEdges("triage", (s) => (s.problems.length > 0 ? "investigate" : "report"), ["investigate", "report"])
    .addEdge("investigate", "report")
    .addEdge("report", END)
    .compile();
}
