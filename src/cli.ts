import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FAIL_ON, type FailOn, parseContexts, pathForContext, shouldFail } from "./cli-support.js";
import { type Config, loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { buildGraph } from "./graph.js";
import { createK8sClients } from "./k8s/client.js";
import { createOllamaLlm, type LlmClient } from "./llm/model.js";
import { loadPreviousReport } from "./report/compare.js";
import type { JsonReport } from "./report/json.js";

/** Exit codes: 0 = healthy or warnings only, 2 = critical issues, 1 = the check itself failed. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CRITICAL = 2;

const HELP = `Usage: pnpm check [options]

Runs a read-only health check of the current Kubernetes cluster.

Options:
  -n, --namespace <name>  Only check this namespace (nodes are always checked)
      --context <names>   Check these kube contexts instead of the current one,
                          comma-separated or repeated, one after another
  -f, --format <format>   Report format on stdout: markdown (default) or json
  -o, --output <file>     Also save the report to <file>: JSON if it ends in .json,
                          markdown otherwise. Can be given more than once. With
                          several contexts, include {context} in the name
  -c, --compare <file>    Mark issues as new, escalated or resolved compared with a
                          previous JSON report (read before --output writes).
                          With several contexts, include {context} in the name
      --fail-on <when>    Exit with code 2 on any critical issue ("critical", the
                          default) or only on critical issues that are new or
                          escalated since the --compare report ("new")
  -v, --verbose           Log each step and tool call to stderr
      --no-llm            Skip LLM triage/investigation (rule-based report only)
  -h, --help              Show this help

Exit codes: 0 healthy/warnings, 2 critical issues found (see --fail-on), 1 error.
With several contexts: 2 if any context fails by --fail-on, else 1 if any context
could not be checked, else 0.`;

interface Options {
  config: Config;
  namespace?: string;
  outputs: string[];
  compare?: string;
  llm?: LlmClient;
  log?: (message: string) => void;
  multipleContexts: boolean;
}

interface ContextResult {
  context: string;
  markdown: string;
  json: JsonReport;
}

/** Runs the health check for one context and saves its output files. */
async function checkContext(context: string | undefined, opts: Options): Promise<ContextResult> {
  const k8s = createK8sClients(opts.config.kubeconfigPath, context);
  opts.log?.(`using kube context "${k8s.context}", model "${opts.config.model}" at ${opts.config.ollamaUrl}`);
  const path = (template: string) => resolve(pathForContext(template, k8s.context, opts.multipleContexts));

  // Read before running: --compare and --output may name the same file.
  const previous = opts.compare ? await loadPreviousReport(path(opts.compare)) : undefined;
  const graph = buildGraph({
    config: opts.config,
    k8s,
    namespace: opts.namespace,
    llm: opts.llm,
    log: opts.log,
    previous,
  });
  const result = await graph.invoke({});
  const json = `${JSON.stringify(result.json, null, 2)}\n`;

  for (const output of opts.outputs) {
    const file = path(output);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, file.endsWith(".json") ? json : result.markdown, "utf8");
    console.error(`Report saved to ${file}`);
  }
  return { context: k8s.context, markdown: result.markdown, json: result.json };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm passes a literal "--" through when running `pnpm check -- --flag`.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      namespace: { type: "string", short: "n" },
      context: { type: "string", multiple: true },
      format: { type: "string", short: "f", default: "markdown" },
      output: { type: "string", short: "o", multiple: true },
      compare: { type: "string", short: "c" },
      "fail-on": { type: "string", default: "critical" },
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
  const failOn = values["fail-on"] as FailOn;
  if (!FAIL_ON.includes(failOn)) {
    throw new Error(`--fail-on must be ${FAIL_ON.map((f) => `"${f}"`).join(" or ")}, not "${values["fail-on"]}"`);
  }
  if (failOn === "new" && !values.compare) {
    throw new Error("--fail-on new needs --compare <previous report>.json to know what is new");
  }

  const config = loadConfig();
  const contexts = parseContexts(values.context);
  const multipleContexts = contexts.length > 1;
  // Fail fast on a missing {context} placeholder, before spending minutes on the first cluster.
  for (const template of [...(values.output ?? []), ...(values.compare ? [values.compare] : [])]) {
    pathForContext(template, contexts[0] ?? "", multipleContexts);
  }

  const opts: Options = {
    config,
    namespace: values.namespace,
    outputs: values.output ?? [],
    compare: values.compare,
    llm: values["no-llm"] ? undefined : createOllamaLlm(config),
    log: values.verbose
      ? (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
      : undefined,
    multipleContexts,
  };

  // One context (or the current one): unchanged behaviour, a failure is the whole run's error.
  if (!multipleContexts) {
    const result = await checkContext(contexts[0], opts);
    console.log(values.format === "json" ? JSON.stringify(result.json, null, 2) : result.markdown);
    return exitFor(result.json, failOn) ? EXIT_CRITICAL : EXIT_OK;
  }

  // Several contexts run one after another (a local GPU serves one LLM request at a time).
  // A context that cannot be checked is reported and does not stop the others; its output
  // files are left alone, so the next --compare still has the last good report.
  const results: (ContextResult | { context: string; error: string })[] = [];
  for (const context of contexts) {
    try {
      results.push(await checkContext(context, opts));
    } catch (err) {
      console.error(`Health check of context "${context}" failed: ${errorMessage(err)}`);
      results.push({ context, error: errorMessage(err) });
    }
  }

  if (values.format === "json") {
    const reports = results.map((r) => ("json" in r ? r.json : { context: r.context, error: r.error }));
    console.log(JSON.stringify(reports, null, 2));
  } else {
    const reports = results.map((r) =>
      "markdown" in r
        ? r.markdown
        : `# Kubernetes Health Report\n\n**Status: ERROR**  \nContext: \`${r.context}\`\n\nThe check could not run: ${r.error}\n`,
    );
    console.log(reports.join("\n---\n\n"));
  }

  if (results.some((r) => "json" in r && exitFor(r.json, failOn))) return EXIT_CRITICAL;
  return results.some((r) => "error" in r) ? EXIT_ERROR : EXIT_OK;
}

/** shouldFail, plus a note when --fail-on new had nothing to compare with. */
function exitFor(report: JsonReport, failOn: FailOn): boolean {
  if (failOn === "new" && !report.comparison) {
    console.error(
      `--fail-on new: context "${report.context}" has no previous report to compare with, so every critical issue counts as new`,
    );
  }
  return shouldFail(report, failOn);
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
