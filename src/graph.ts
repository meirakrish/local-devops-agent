import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Config } from "./config.js";
import type { K8sClients } from "./k8s/client.js";
import { checkOllama, type OllamaStatus } from "./llm/ollama.js";
import { renderMarkdownReport } from "./report/markdown.js";
import { detectIssues } from "./scan/rules.js";
import { scanCluster } from "./scan/scan.js";
import type { ClusterOverview, Issue } from "./scan/types.js";

/**
 * Graph state. Each node returns a partial update that LangGraph merges in.
 * Without a reducer, a key simply keeps the last value written to it.
 */
export const HealthCheckState = Annotation.Root({
  overview: Annotation<ClusterOverview>(),
  issues: Annotation<Issue[]>(),
  ollama: Annotation<OllamaStatus>(),
  // Note: state keys and node names share a namespace, so this cannot be "report".
  markdown: Annotation<string>(),
});

export type HealthCheckStateType = typeof HealthCheckState.State;

export interface GraphDeps {
  config: Config;
  k8s: K8sClients;
  namespace?: string;
  log?: (message: string) => void;
}

/**
 * Milestone 1 flow:
 *
 *   START ─┬─> scan ─────┬─> report ─> END
 *          └─> checkLlm ─┘
 *
 * `scan` and `checkLlm` run in parallel; `report` waits for both.
 * Milestone 2 inserts `triage` and `investigate` between scan and report.
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
    const issues = detectIssues(overview, { restartThreshold: deps.config.restartThreshold, now });
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

  function report(state: HealthCheckStateType): Partial<HealthCheckStateType> {
    log("report: rendering markdown");
    return {
      markdown: renderMarkdownReport({
        overview: state.overview,
        issues: state.issues,
        ollama: state.ollama,
      }),
    };
  }

  return new StateGraph(HealthCheckState)
    .addNode("scan", scan)
    .addNode("checkLlm", checkLlm)
    .addNode("report", report)
    .addEdge(START, "scan")
    .addEdge(START, "checkLlm")
    .addEdge(["scan", "checkLlm"], "report")
    .addEdge("report", END)
    .compile();
}
