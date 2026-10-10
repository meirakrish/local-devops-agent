import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { LlmClient } from "../llm/model.js";
import type { Issue } from "../scan/types.js";
import type { Finding, Problem } from "./types.js";

const SYSTEM_PROMPT = `You are a Kubernetes SRE investigating one problem in a cluster.
Use the tools to gather evidence, then stop calling tools once you know the root cause.

Guidelines:
- Tools are read-only. You can never change the cluster; only suggest fixes.
- For a failing pod, start with k8s_describe_pod, then k8s_get_logs.
- For a Deployment, k8s_get_deployment shows its pods.
- Copy namespace and name exactly from "tool arguments" or from tool results. Never put
  "namespace/name" in one field, and never guess names.
- Do not repeat a tool call with the same arguments.
- Evidence computed by the rules (numbers, comparisons) is reliable; build on it.
- Be brief. You have a limited number of tool calls.`;

const CONCLUDE_PROMPT = `Stop investigating now. Based only on the evidence above, report:
- summary: one sentence describing the problem
- rootCause: the most likely root cause, specific (quote the key log line or event if there is one)
- evidence: 1-4 short facts from the tool results that support it
- suggestedFix: 1-3 concrete steps (commands or manifest changes); they will NOT be applied automatically
- confidence: high if logs or events state the cause directly, medium if inferred, low if unclear`;

const ConclusionSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  evidence: z.array(z.string()),
  suggestedFix: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

const InvestigationState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** Tool calls made so far (each call counts as one step). */
  steps: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  /** Signatures of calls already made, to catch the model repeating itself. */
  seenCalls: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  conclusion: Annotation<z.infer<typeof ConclusionSchema>>(),
});

type State = typeof InvestigationState.State;

export interface InvestigateDeps {
  llm: LlmClient;
  tools: StructuredToolInterface[];
  maxSteps: number;
  log?: (message: string) => void;
}

/** Exact tool arguments for a resource, so the model does not have to split "ns/name". */
export function toolTarget(issue: Issue): string {
  const { kind, namespace, name } = issue.resource;
  if (kind === "Pod" && namespace === "kube-system" && issue.category.startsWith("controlplane-")) {
    return `namespace="kube-system" name="${name}" (for k8s_get_logs: pod="${name}"); k8s_cluster_health with section="control-plane" shows all control-plane components`;
  }
  if (kind === "Pod") return `namespace="${namespace}" name="${name}" (for k8s_get_logs: pod="${name}")`;
  if (kind === "Node") return `name="${name}" (k8s_list_nodes shows heartbeat, versions and requests)`;
  // Name the health section, so a small model gets only the relevant part of the output.
  if (kind.endsWith("WebhookConfiguration")) return 'call k8s_cluster_health with section="webhooks"';
  if (kind === "ControlPlane") {
    return `call k8s_cluster_health with section="${name === "etcd" ? "etcd" : "control-plane"}"`;
  }
  if (kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet") {
    return `k8s_get_workload with kind="${kind}" namespace="${namespace}" name="${name}"`;
  }
  if (kind === "ReplicaSet" && issue.workload) {
    return `k8s_get_workload with kind="Deployment" namespace="${namespace}" name="${issue.workload.split("/")[1]}"`;
  }
  if (kind === "Service") return `k8s_get_service with namespace="${namespace}" name="${name}"`;
  return `namespace="${namespace}" name="${name}"`;
}

function describeIssue(issue: Issue): string {
  return [
    `- ${issue.severity.toUpperCase()} ${issue.resource.kind}: ${issue.title}`,
    `  tool arguments: ${toolTarget(issue)}`,
    ...issue.evidence.map((e) => `  evidence: ${e}`),
    // The rule's next step steers the model toward the right check (e.g. compare
    // requests with node capacity) instead of a generic answer.
    ...(issue.hint ? [`  hint from rule: ${issue.hint}`] : []),
  ].join("\n");
}

export function problemPrompt(problem: Problem, maxSteps: number): string {
  return [
    "Investigate this problem:",
    describeIssue(problem.primary),
    ...(problem.related.length > 0
      ? ["Related issues (same root cause suspected):", ...problem.related.map(describeIssue)]
      : []),
    "",
    `You may make at most ${maxSteps} tool calls.`,
  ].join("\n");
}

/**
 * Small models often send `null` for optional fields; zod's `.optional()` only accepts
 * a missing field, so drop nulls before validation.
 */
export function dropNullArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
}

/**
 * The obvious first tool call for a problem, made in code before the model's first turn,
 * so the investigation always starts from the right evidence. In testing, a small model
 * sometimes skipped it and wandered (for example, into the logs of an unrelated pod).
 */
export function seedCall(issue: Issue): { name: string; args: Record<string, unknown> } | undefined {
  const { kind, namespace, name } = issue.resource;
  if (kind === "Pod" && namespace) return { name: "k8s_describe_pod", args: { namespace, name } };
  if ((kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet") && namespace) {
    return { name: "k8s_get_workload", args: { kind, namespace, name } };
  }
  // A ReplicaSet's FailedCreate events show up in its Deployment's controller events.
  if (kind === "ReplicaSet" && namespace && issue.workload) {
    return { name: "k8s_get_workload", args: { kind: "Deployment", namespace, name: issue.workload.split("/")[1] } };
  }
  if (kind === "Service" && namespace) return { name: "k8s_get_service", args: { namespace, name } };
  if (namespace && issue.category === "pod-create-failed") {
    return { name: "k8s_list_events", args: { namespace, objectName: name, objectKind: kind } };
  }
  if (kind === "Node") return { name: "k8s_list_nodes", args: {} };
  if (kind.endsWith("WebhookConfiguration")) return { name: "k8s_cluster_health", args: { section: "webhooks" } };
  if (kind === "ControlPlane") {
    return { name: "k8s_cluster_health", args: { section: name === "etcd" ? "etcd" : "control-plane" } };
  }
  return undefined;
}

function callSignature(name: string, args: unknown): string {
  const sorted =
    args && typeof args === "object"
      ? Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))
      : args;
  return `${name} ${JSON.stringify(sorted)}`;
}

/**
 * ReAct-style loop as a small graph:
 *
 *   START -> agent -(tool calls, budget left)-> tools -(budget left)-> agent
 *              |                                  |
 *              +-(no tool calls)-> conclude <-----+-(budget used up)
 *                                     |
 *                                    END
 *
 * `conclude` makes one final call without tools that must match ConclusionSchema.
 */
export function buildInvestigationGraph({ llm, tools, maxSteps, log = () => {} }: InvestigateDeps) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  async function agent(state: State): Promise<Partial<State>> {
    const reply = await llm.chatWithTools(state.messages, tools);
    return { messages: [reply] };
  }

  async function runTools(state: State): Promise<Partial<State>> {
    const last = state.messages.at(-1) as AIMessage;
    const results: ToolMessage[] = [];
    const seen: string[] = [];
    let used = state.steps;

    for (const call of last.tool_calls ?? []) {
      const id = call.id ?? `${call.name}-${used}`;
      const reply = (content: string) => results.push(new ToolMessage({ content, tool_call_id: id, name: call.name }));

      // Every tool call needs an answer, even the ones we refuse to run.
      if (used >= maxSteps) {
        reply("Skipped: tool call limit reached. Conclude with the evidence you have.");
        continue;
      }
      used++;
      const args = dropNullArgs(call.args);
      const signature = callSignature(call.name, args);
      const tool = toolsByName.get(call.name);
      if (!tool) {
        // Only the registered read-only tools can ever run.
        reply(`Error: unknown tool "${call.name}". Available tools: ${[...toolsByName.keys()].join(", ")}`);
        log(`    ✗ ${call.name} (unknown tool)`);
      } else if (state.seenCalls.includes(signature) || seen.includes(signature)) {
        reply("You already made this exact call; its result is above. Use different arguments or conclude.");
        log(`    ↺ ${signature} (repeated, not run)`);
      } else {
        const started = Date.now();
        let output: string;
        try {
          output = String(await tool.invoke(args));
        } catch (err) {
          // Usually invalid arguments. The zod details come after the first line, so keep
          // the whole message (on one line) for the model to fix its call.
          const message = err instanceof Error ? err.message : String(err);
          output = `Error: ${message.replace(/\s+/g, " ").trim().slice(0, 500)}`;
        }
        reply(output);
        log(`    → ${signature} (${output.length} chars, ${Date.now() - started}ms)`);
      }
      seen.push(signature);
    }
    return { messages: results, steps: used - state.steps, seenCalls: seen };
  }

  async function conclude(state: State): Promise<Partial<State>> {
    const conclusion = await llm.structured(
      ConclusionSchema,
      [...state.messages, new HumanMessage(CONCLUDE_PROMPT)],
      "conclusion",
    );
    return { conclusion };
  }

  const afterAgent = (state: State) => {
    const last = state.messages.at(-1) as AIMessage;
    return (last.tool_calls?.length ?? 0) > 0 && state.steps < maxSteps ? "tools" : "conclude";
  };
  const afterTools = (state: State) => (state.steps < maxSteps ? "agent" : "conclude");

  return new StateGraph(InvestigationState)
    .addNode("agent", agent)
    .addNode("tools", runTools)
    .addNode("conclude", conclude)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", afterAgent, ["tools", "conclude"])
    .addConditionalEdges("tools", afterTools, ["agent", "conclude"])
    .addEdge("conclude", END)
    .compile();
}

export async function investigate(problem: Problem, deps: InvestigateDeps): Promise<Finding> {
  const graph = buildInvestigationGraph(deps);
  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(problemPrompt(problem, deps.maxSteps)),
  ];
  try {
    // Run the seed call as if the model had made it: an AI message with the tool call,
    // then its result. It counts as one step and as a "seen" call.
    const seed = seedCall(problem.primary);
    const seedTool = seed ? deps.tools.find((t) => t.name === seed.name) : undefined;
    const initial: { messages: BaseMessage[]; steps: number; seenCalls: string[] } = { messages, steps: 0, seenCalls: [] };
    if (seed && seedTool && deps.maxSteps > 0) {
      const signature = callSignature(seed.name, seed.args);
      const started = Date.now();
      let output: string;
      try {
        output = String(await seedTool.invoke(seed.args));
      } catch (err) {
        output = `Error: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 500)}`;
      }
      (deps.log ?? (() => {}))(`    → ${signature} (${output.length} chars, ${Date.now() - started}ms, seed)`);
      messages.push(
        new AIMessage({ content: "", tool_calls: [{ id: "seed-0", name: seed.name, args: seed.args, type: "tool_call" }] }),
        new ToolMessage({ content: output, tool_call_id: "seed-0", name: seed.name }),
      );
      initial.steps = 1;
      initial.seenCalls = [signature];
    }
    // Each agent/tools round is 2 graph steps; leave room for the rest.
    const result = await graph.invoke(initial, { recursionLimit: deps.maxSteps * 2 + 10 });
    return { problem, ...result.conclusion, toolCalls: result.steps };
  } catch (err) {
    return {
      problem,
      summary: problem.primary.title,
      rootCause: "Investigation failed.",
      evidence: [],
      suggestedFix: [],
      confidence: "low",
      toolCalls: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
