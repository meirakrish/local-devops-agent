import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { buildGraph } from "./graph.js";
import { createK8sClients } from "./k8s/client.js";
import { createOllamaLlm } from "./llm/model.js";
import { loadPreviousReport } from "./report/compare.js";
import { overallStatus } from "./report/markdown.js";

/** Exit codes: 0 = healthy or warnings only, 2 = critical issues, 1 = the check itself failed. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CRITICAL = 2;

const HELP = `Usage: pnpm check [options]

Runs a read-only health check of the current Kubernetes cluster.

Options:
  -n, --namespace <name>  Only check this namespace (nodes are always checked)
  -f, --format <format>   Report format on stdout: markdown (default) or json
  -o, --output <file>     Also save the report to <file>: JSON if it ends in .json,
                          markdown otherwise. Can be given more than once
  -c, --compare <file>    Mark issues as new, escalated or resolved compared with a
                          previous JSON report (read before --output writes)
  -v, --verbose           Log each step and tool call to stderr
      --no-llm            Skip LLM triage/investigation (rule-based report only)
  -h, --help              Show this help

Exit codes: 0 healthy/warnings, 2 critical issues found, 1 error`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm passes a literal "--" through when running `pnpm check -- --flag`.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      namespace: { type: "string", short: "n" },
      format: { type: "string", short: "f", default: "markdown" },
      output: { type: "string", short: "o", multiple: true },
      compare: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v", default: false },
      "no-llm": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return EXIT_OK;
  }

  if (values.format !== "markdown" && values.format !== "json") {
    throw new Error(`--format must be "markdown" or "json", not "${values.format}"`);
  }

  const config = loadConfig();
  const log = values.verbose
    ? (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
    : undefined;

  const k8s = createK8sClients(config.kubeconfigPath);
  log?.(`using kube context "${k8s.context}", model "${config.model}" at ${config.ollamaUrl}`);

  const llm = values["no-llm"] ? undefined : createOllamaLlm(config);
  // Read before running: --compare and --output may name the same file.
  const previous = values.compare ? await loadPreviousReport(resolve(values.compare)) : undefined;

  const graph = buildGraph({ config, k8s, namespace: values.namespace, llm, log, previous });
  const result = await graph.invoke({});
  const json = `${JSON.stringify(result.json, null, 2)}\n`;

  console.log(values.format === "json" ? json.trimEnd() : result.markdown);

  for (const output of values.output ?? []) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, path.endsWith(".json") ? json : result.markdown, "utf8");
    console.error(`Report saved to ${path}`);
  }

  return overallStatus(result.issues) === "CRITICAL" ? EXIT_CRITICAL : EXIT_OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`Health check failed: ${errorMessage(err)}`);
    process.exitCode = EXIT_ERROR;
  },
);
