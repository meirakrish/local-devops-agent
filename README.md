# local-devops-agent

A local AI agent that runs a full, read-only health check on a Kubernetes cluster and
writes a report: what's wrong, the likely root cause, and suggested fixes.
Everything runs on your machine. The LLM is served by [Ollama](https://ollama.com),
so no cloud LLM APIs are used.

> **Status: milestone 1 of 4.** The cluster scan, rule-based issue detection, Ollama
> connection check and markdown report work today. LLM-driven triage and investigation
> come in milestone 2 (see [Roadmap](#roadmap)).

## Features

- **One command, no questions:** `pnpm check` scans the cluster and prints a report.
- **Read-only by construction:** write, delete and exec operations are blocked in code,
  not just by prompt instructions (see [Safety](#safety)).
- **Detects common failures:** CrashLoopBackOff, image pull errors, OOMKilled containers,
  unschedulable or stuck Pending pods, high restart counts, pods that never become ready,
  NotReady or pressured nodes, unavailable deployments and stuck rollouts.
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
| `MAX_STEPS_PER_PROBLEM` | `6` | Max tool calls per investigated problem (milestone 2) |
| `RESTART_THRESHOLD` | `5` | Containers restarting at least this often are flagged |
| `EVENT_WINDOW_MINUTES` | `60` | Only warning events newer than this are included |

Invalid values stop the run at startup with an error that names the variable.

## Usage

```bash
pnpm check
```

| Flag | Description |
| --- | --- |
| `-n, --namespace <name>` | Only check one namespace (nodes are always checked) |
| `-o, --output <file>` | Also save the report as markdown |
| `-v, --verbose` | Log each step to stderr |
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
                 ┌──────────────────────── LangGraph ────────────────────────┐
                 │                                                           │
 pnpm check ──►  │  START ─┬─► scan ──────┬─► report ─► END                  │
   (cli.ts)      │         └─► checkLlm ──┘                                  │
                 │                                                           │
                 └───────────────────────────────────────────────────────────┘
                        │                │              │
                        ▼                ▼              ▼
                 k8s/client.ts     llm/ollama.ts   report/markdown.ts
                 (read-only proxy) (GET /api/tags)
                        │
                        ▼
                 scan/scan.ts ──► scan/summarize.ts ──► scan/rules.ts
                 (parallel list    (raw objects →        (summaries →
                  calls)            compact summaries)    issues + severity)
```

- **scan** lists nodes, namespaces, pods, deployments and recent warning events in
  parallel. This step is plain code, not the LLM, so it runs the same way every time.
  If one call fails (for example, RBAC forbids listing nodes), the error is recorded in
  the report and the rest of the scan continues.
- **summarize** reduces large Kubernetes objects to the few fields that matter. This keeps
  the report readable and, from milestone 2, keeps the LLM's input small.
- **rules** turn summaries into issues with a severity (`critical` / `warning` / `info`)
  and a suggested next step. Each pod produces at most one issue, listing all of its
  symptoms. Young Pending pods get a grace period, so a pod that is still starting isn't
  flagged.
- **checkLlm** runs alongside the scan. It checks that Ollama is reachable and the model
  is pulled, without loading the model.
- **report** renders markdown, with issues grouped by severity.

### Project layout

```
src/
  cli.ts              CLI entry point: flags, output file, exit codes
  config.ts           .env loading and validation (zod)
  graph.ts            LangGraph state and nodes
  k8s/client.ts       Read-only Kubernetes client
  llm/ollama.ts       Ollama connection check
  scan/scan.ts        Cluster overview collection
  scan/summarize.ts   Raw objects → compact summaries
  scan/rules.ts       Rule-based issue detection
  scan/types.ts       Shared types
  report/markdown.ts  Markdown report renderer
test/                 vitest unit tests
```

## Safety

The agent must never change the cluster. This is enforced in code, in two layers in
[`src/k8s/client.ts`](src/k8s/client.ts):

1. **Compile time:** the `ReadOnlyApi<T>` type exposes only `list*` and `read*` methods,
   so code that calls `deleteNamespacedPod` doesn't compile.
2. **Runtime:** the API objects are wrapped in a `Proxy` that throws
   `ReadOnlyViolationError` for any other method. That includes `create*`, `patch*`,
   `replace*`, `delete*` and `connect*` (exec, attach, port-forward). This also catches
   type casts and, from milestone 2, any tool name the LLM chooses.

Suggested fixes in the report are only text. Nothing is ever applied.

For defense in depth, you can also run the agent with a kubeconfig bound to the built-in
`view` ClusterRole.

## Example report

From a healthy two-node minikube cluster (event table shortened):

```markdown
# Kubernetes Health Report

**Status: HEALTHY**
Context: `minikube`
Scope: all namespaces
Scanned at: 2026-10-09T09:49:43.160Z

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 14/15 |
| Deployments fully ready | 4/4 |
| Warning events (recent) | 11 |
| Issues | 0 critical, 0 warning, 0 info |

## Issues

No issues detected.

## Recent warning events

| Last seen | Object | Reason | Count | Message |
| --- | --- | --- | --- | --- |
| 2026-10-09 09:45:00 | Pod kube-system/kube-apiserver-minikube | Unhealthy | 13 | Readiness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 09:31:42 | Node minikube-m02 | Rebooted | 1 | Node minikube-m02 has been rebooted, boot id: … |

## Scan notes

- LLM: `qwen2.5:7b-instruct` available at http://localhost:11434
- Findings are rule-based (milestone 1). Suggestions are never applied automatically.
```

When something is broken, each issue looks like this:

```markdown
### Critical (1)

#### Pod shop/web-7d9f-x2k: crashloop

- container app is in CrashLoopBackOff (last exit: Error, code 1), 12 restarts

_Suggested next step:_ Read the previous container logs (`kubectl logs --previous`) to see why it exits.
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
- [ ] **Milestone 2:** LLM triage and investigation with read-only tools (`k8s_list_nodes`,
  `k8s_list_pods`, `k8s_describe_pod`, `k8s_get_logs`, `k8s_list_events`,
  `k8s_get_deployment`), a max-steps limit per problem, and truncation of large outputs
- [ ] **Milestone 3:** kind demo cluster with deliberately broken workloads (crashloop,
  bad image, OOM, unschedulable)
- [ ] **Milestone 4:** full README with architecture diagram and LLM-generated example report
