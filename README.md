# local-devops-agent

A local AI agent that runs a full, read-only health check on a Kubernetes cluster and
writes a report: what's wrong, the likely root cause, and suggested fixes.
Everything runs on your machine. The LLM is served by [Ollama](https://ollama.com),
so no cloud LLM APIs are used.

> **Status: milestone 2 of 4.** The scan, rule-based detection, LLM triage, tool-based
> investigation and report all work. A kind demo cluster and the final README come next
> (see [Roadmap](#roadmap)).

## Features

- **One command, no questions:** `pnpm check` scans the cluster and prints a report.
- **Read-only by construction:** write, delete and exec operations are blocked in code,
  not just by prompt instructions (see [Safety](#safety)).
- **Detects common failures:** CrashLoopBackOff, image pull errors, OOMKilled containers,
  unschedulable or stuck Pending pods, high restart counts, pods that never become ready,
  NotReady or pressured nodes, unavailable deployments and stuck rollouts.
- **Investigates like an SRE:** a local LLM groups related issues, then uses read-only
  tools (describe, logs, events, deployments) to find the root cause and suggest a fix.
- **Works without the LLM:** if Ollama is down (or with `--no-llm`), you still get the
  rule-based report.
- **CI/cron friendly:** exits non-zero when critical issues are found.
- **Fully local:** Kubernetes access comes from your kubeconfig, and the LLM is served by Ollama.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20+ | Tested with 22 LTS |
| pnpm | 10+ | `corepack enable` |
| kubectl access | any | A working kubeconfig (minikube, kind, or a real cluster) |
| Ollama | latest | Needed for LLM steps; the scan works without it |

### Installing Ollama (Linux / WSL)

The Ollama install script needs `zstd`, which a fresh Ubuntu does not include:

```bash
sudo apt-get install zstd
```

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

```bash
ollama pull qwen2.5:7b-instruct
```

The 7B model is about 4.7 GB and runs well on a GPU with 8 GB or more of VRAM. It also
runs on CPU, more slowly.

## Setup

```bash
pnpm install
```

```bash
cp .env.example .env
```

Then edit `.env` if the defaults don't fit:

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `MODEL` | `qwen2.5:7b-instruct` | Model used for triage and investigation |
| `KUBECONFIG` | _(empty)_ | Kubeconfig path; empty uses `$KUBECONFIG` or `~/.kube/config` |
| `MAX_STEPS_PER_PROBLEM` | `6` | Max tool calls per investigated problem |
| `MAX_PROBLEMS` | `5` | Max problems the LLM investigates per run |
| `NUM_CTX` | `16384` | Ollama context window in tokens (see below) |
| `TOOL_OUTPUT_MAX_CHARS` | `4000` | Tool outputs are truncated to this before reaching the LLM |
| `RESTART_THRESHOLD` | `5` | Containers restarting at least this often are flagged |
| `EVENT_WINDOW_MINUTES` | `60` | Only warning events newer than this are included |

Invalid values stop the run at startup with an error that names the variable.

`NUM_CTX` matters: Ollama's default context window is small, and longer prompts are
**silently truncated**, so the model loses the start of the conversation without any
error. 16384 tokens fits a 7B model in about 6 GB of VRAM.

## Usage

```bash
pnpm check
```

| Flag | Description |
| --- | --- |
| `-n, --namespace <name>` | Only check one namespace (nodes are always checked) |
| `-o, --output <file>` | Also save the report as markdown |
| `-v, --verbose` | Log each step and every tool call to stderr |
| `--no-llm` | Skip LLM triage and investigation (fast, rule-based report only) |
| `-h, --help` | Show help |

Examples:

```bash
pnpm check --namespace shop --verbose
```

```bash
pnpm check --output reports/latest.md
```

The report goes to **stdout** and logs go to **stderr**, so `pnpm -s check > report.md`
captures only the report.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Healthy, or warnings only |
| `2` | Critical issues found |
| `1` | The check itself failed (bad config, cluster unreachable, unknown namespace) |

## Architecture

```
 pnpm check (cli.ts)
      │
      ▼
 ┌──────────────────────────── LangGraph (graph.ts) ─────────────────────────────┐
 │                                                                               │
 │  START ─┬─► scan ──────┬─► triage ──┬─► investigate ──► report ──► END        │
 │         └─► checkLlm ──┘            │   (per problem)     ▲                   │
 │                                     └── LLM off / no issues ┘                  │
 └───────────────────────────────────────────────────────────────────────────────┘

 investigate, for each problem (agent/investigate.ts):

   START ─► agent ──(tool calls, budget left)──► tools ──(budget left)──► agent
              │                                    │
              └──(no tool calls)──► conclude ◄─────┴──(budget used up)
                                       │
                                      END   (root cause, evidence, fix, confidence)
```

| Step | LLM? | What it does |
| --- | --- | --- |
| **scan** | no | Lists nodes, namespaces, pods, deployments and recent warning events in parallel, summarizes them, and runs the rules. A failed call is recorded and the scan continues. |
| **checkLlm** | no | Checks that Ollama is reachable and the model is pulled (`GET /api/tags`). |
| **triage** | yes | Picks up to `MAX_PROBLEMS` problems and merges issues with one root cause (a Deployment and its crashing pods). |
| **investigate** | yes | For each problem, a tool-calling loop of at most `MAX_STEPS_PER_PROBLEM` calls, then a structured conclusion. |
| **report** | no | Investigated problems first, then the remaining rule-based issues, events and notes. |

### Design choices for a small local model

A 7B model is capable but easily derailed, so the code does what the prompt can't
guarantee:

- **The rules find the issues and the LLM explains them.** Detection is deterministic,
  and severity and the exit code come only from the rules. The LLM can't hide a
  critical issue.
- **IDs are constrained, not trusted.** Triage output uses a JSON-schema `enum` of the
  real issue IDs, and Ollama constrains generation to that schema, so the model can't
  invent or misspell an ID. Pods of the same Deployment are merged in code even if the
  model forgets to merge them.
- **Tools do the obvious thing for the model.** `k8s_get_logs` automatically includes
  the previous (crashed) run's logs for a restarted container. In testing, the model
  asked for the current run's logs, which are often empty.
- **Code does the arithmetic.** For an unschedulable pod, the rule compares its requests
  with the largest node ("requests cpu=64, largest node allocatable cpu=12") and passes
  that, plus the rule's hint, to the model. Before this, the model read the same
  numbers and suggested *raising* the CPU request.
- **Tolerant inputs, strict names.** `null` for an optional argument is treated as
  missing (small models do this often). A name like `agent-test/web` is rejected with a
  message explaining the mistake, and a wrong namespace returns the list of real ones.
- **Mistakes go back to the model as messages.** Invalid arguments, unknown tools,
  repeated calls and API errors become tool messages the model can react to. They never
  crash the run.
- **Bounded output and context.** Tool output is truncated (keeping the head and the
  tail, since errors are usually at the end), env var values are never shown, and
  `NUM_CTX` is set explicitly.
- **Graceful degradation.** Each LLM call is retried once (local GPUs occasionally fail
  a single request). If Ollama is down, the model isn't pulled, triage fails or
  one investigation fails, you still get the rule-based report for that part.

### Tools

All six are read-only and built on the guarded client:

| Tool | Returns |
| --- | --- |
| `k8s_list_nodes` | Ready status, pressure conditions, allocatable CPU/memory |
| `k8s_list_pods` | Phase, ready containers, restarts, waiting reason (optional namespace, problems-only filter) |
| `k8s_describe_pod` | Conditions, container states and last termination, image, resources, env var **names**, probes, recent events |
| `k8s_get_logs` | Last N lines of a container's logs; includes the previous run automatically after a restart |
| `k8s_list_events` | Warning events, filtered by namespace, object name and kind |
| `k8s_get_deployment` | Desired vs ready replicas, rollout conditions, images, and the status of its pods |

### Project layout

```
src/
  cli.ts                CLI entry point: flags, output file, exit codes
  config.ts             .env loading and validation (zod)
  graph.ts              Main LangGraph: scan, checkLlm, triage, investigate, report
  agent/triage.ts       LLM problem selection, plus a deterministic fallback
  agent/investigate.ts  Tool-calling loop (subgraph) and structured conclusion
  k8s/client.ts         Read-only Kubernetes client
  llm/model.ts          LlmClient interface and Ollama implementation
  llm/ollama.ts         Ollama connection check
  tools/k8s-tools.ts    The six read-only tools
  tools/truncate.ts     Output truncation
  scan/                 Overview collection, summaries, rules
  report/markdown.ts    Markdown report renderer
test/                   vitest unit tests (fake cluster and scripted fake LLM; no Ollama needed)
dev/test-workloads.yaml Deliberately broken workloads for manual testing
```

## Safety

The agent must never change the cluster. This is enforced in code, in two layers in
[`src/k8s/client.ts`](src/k8s/client.ts):

1. **Compile time:** the `ReadOnlyApi<T>` type exposes only `list*` and `read*` methods,
   so code that calls `deleteNamespacedPod` doesn't compile.
2. **Runtime:** the API objects are wrapped in a `Proxy` that throws
   `ReadOnlyViolationError` for any other method. That includes `create*`, `patch*`,
   `replace*`, `delete*` and `connect*` (exec, attach, port-forward). This also catches
   type casts and any tool name the LLM chooses.

On top of that, the investigate loop only runs tools from its own registry of six
read-only tools. If the model asks for any other tool, it gets an error message back and
nothing runs.

Suggested fixes in the report are only text. Nothing is ever applied.

For defense in depth, you can also run the agent with a kubeconfig bound to the built-in
`view` ClusterRole.

## Example report

A real run against the deliberately broken workloads in
[`dev/test-workloads.yaml`](dev/test-workloads.yaml) on a two-node minikube cluster, with
`qwen2.5:7b-instruct` on an RTX 3060. It took 67 seconds and exited with code 2. Two of
the four investigated problems are shown, and the event table is omitted:

```markdown
# Kubernetes Health Report

**Status: CRITICAL**
Context: `minikube`
Scope: namespace `agent-test`

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 3/5 |
| Deployments fully ready | 0/4 |
| Issues | 11 critical, 0 warning, 0 info |
| Investigated by LLM | 4 problem(s) |

## Investigated problems

### 1. [CRITICAL] Pod `batch-7684468b57-9xv2m` is unschedulable due to insufficient CPU resources.

**Affected:** Pod agent-test/batch-7684468b57-9xv2m, Deployment agent-test/batch

**Root cause:** Insufficient CPU: No node can ever fit this pod (requests cpu=64, largest node allocatable cpu=12).

**Evidence:**

- 0/2 nodes are available: 2 Insufficient cpu.
- PodScheduled=False (Unschedulable): 0/2 nodes are available: 2 Insufficient cpu.

**Suggested fix** (not applied):

1. Lower the CPU request in the pod's resource limits.
2. Add larger nodes to the cluster.

_Confidence: high · 3 tool call(s)_

### 3. [CRITICAL] Pods in the agent-test/web deployment are crashing due to the missing DATABASE_URL environment variable.

**Affected:** Pod agent-test/web-7db8d69f68-4f2n7, Pod agent-test/web-7db8d69f68-q5rls, Deployment agent-test/web

**Root cause:** The application is exiting with an error because the DATABASE_URL environment variable is not set.

**Evidence:**

- The logs show: `FATAL: DATABASE_URL is not set, cannot connect to database`.
- The deployment `web` has 0/2 replicas ready, indicating issues with the pods.

**Suggested fix** (not applied):

1. Set the `DATABASE_URL` environment variable in the deployment's container specification.
2. Apply the updated deployment configuration.

_Confidence: high · 3 tool call(s)_

## Other issues (rule-based)

None; all issues are covered above.
```

The `--verbose` log shows every tool call the agent made:

```
[10:36:13] triage: 4 problem(s) to investigate (11265ms)
[10:36:37] investigate [3/4] Pod agent-test/web-7db8d69f68-4f2n7: crashloop
[10:36:39]     → k8s_get_logs {"namespace":"agent-test","pod":"web-7db8d69f68-4f2n7","previous":true,"tailLines":50} (161 chars, 49ms)
[10:36:41]     → k8s_describe_pod {"name":"web-7db8d69f68-q5rls","namespace":"agent-test"} (2263 chars, 15ms)
[10:36:43]     → k8s_get_deployment {"name":"web","namespace":"agent-test"} (533 chars, 17ms)
[10:36:56]   done: 3 tool call(s), confidence high (18560ms)
```

**Known limitations of a 7B model:** suggested fixes can be generic or wrong (in another
run, it proposed replacing a missing image tag with another made-up tag), and the
self-reported confidence is almost always "high". Treat root causes as leads to verify.
Changing `MODEL` to a larger model improves this.

### Try it yourself

Deploy the broken workloads, which create the `agent-test` namespace:

```bash
kubectl apply -f dev/test-workloads.yaml
```

Wait a minute for them to start failing, then run:

```bash
pnpm check --namespace agent-test --verbose
```

Remove them with:

```bash
kubectl delete namespace agent-test
```

## Development

| Command | Description |
| --- | --- |
| `pnpm check` | Run the health check |
| `pnpm test` | Run unit tests (vitest) |
| `pnpm typecheck` | Type-check `src/` and `test/` |
| `pnpm build` | Compile `src/` to `dist/` |

The rules and summarizers are pure functions, and the tests feed them fake broken pods,
nodes and deployments. Read [`test/rules.test.ts`](test/rules.test.ts) to see what each
rule catches.

### Troubleshooting (WSL)

- **`corepack: /bin/sh^M: bad interpreter`:** the Windows Node install is ahead of the
  Linux one on your `PATH`. Install Node inside WSL (for example, with
  [nvm](https://github.com/nvm-sh/nvm)) and make sure its `bin` directory comes first.
- **`Ignored build scripts: esbuild`:** pnpm 10+ blocks dependency install scripts by
  default. This repo allows `esbuild` in `pnpm-workspace.yaml`. Run `pnpm install` again.

## Roadmap

- [x] **Milestone 1:** scaffold, Ollama connection, scan step, rule-based report
- [x] **Milestone 2:** LLM triage and investigation with read-only tools (`k8s_list_nodes`,
  `k8s_list_pods`, `k8s_describe_pod`, `k8s_get_logs`, `k8s_list_events`,
  `k8s_get_deployment`), a max-steps limit per problem, and truncation of large outputs
- [ ] **Milestone 3:** kind demo cluster with deliberately broken workloads (crashloop,
  bad image, OOM, unschedulable)
- [ ] **Milestone 4:** full README with architecture diagram and LLM-generated example report
