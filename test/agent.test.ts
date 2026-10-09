import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { investigate, problemPrompt, seedCall } from "../src/agent/investigate.js";
import { buildProblems, fallbackTriage, triage } from "../src/agent/triage.js";
import type { Problem } from "../src/agent/types.js";
import type { LlmClient } from "../src/llm/model.js";
import type { ClusterOverview, Issue } from "../src/scan/types.js";

function issue(id: string, kind: string, name: string, severity: Issue["severity"] = "critical"): Issue {
  return {
    id,
    severity,
    category: id.split(":")[1] ?? "x",
    resource: { kind, namespace: kind === "Node" ? undefined : "shop", name },
    title: `${kind} ${name}`,
    evidence: [`evidence for ${name}`],
  };
}

const webPod1 = issue("pod/shop/web-7db8d69f68-4f2n7:crashloop", "Pod", "web-7db8d69f68-4f2n7");
const webPod2 = issue("pod/shop/web-7db8d69f68-q5rls:crashloop", "Pod", "web-7db8d69f68-q5rls");
const webDeploy = issue("deployment/shop/web:unavailable", "Deployment", "web");
const payPod = issue("pod/shop/payments-9877b44c9-hql6z:image-pull", "Pod", "payments-9877b44c9-hql6z");
const cordoned = issue("node/n1:cordoned", "Node", "n1", "info");
const ALL = [webDeploy, webPod1, webPod2, payPod, cordoned];

const overview: ClusterOverview = {
  context: "test",
  scannedAt: "2026-01-01T00:00:00.000Z",
  namespaces: [],
  nodes: [],
  pods: [],
  deployments: [],
  warningEvents: [],
  controlPlane: { notVisible: [] },
  webhooks: [],
  errors: [],
};

const CONCLUSION = {
  summary: "web crashes on start",
  rootCause: "DATABASE_URL is not set",
  evidence: ["FATAL: DATABASE_URL is not set"],
  suggestedFix: ["Add DATABASE_URL to the deployment env"],
  confidence: "high" as const,
};

/** Scripted LLM: returns the given chat replies in order, and a fixed structured answer. */
function fakeLlm(replies: AIMessage[], structured: unknown = CONCLUSION) {
  const seen: BaseMessage[][] = [];
  const llm: LlmClient = {
    chatWithTools: async (messages) => {
      seen.push(messages);
      const next = replies.shift();
      if (!next) throw new Error("fake LLM ran out of replies");
      return next;
    },
    structured: async (_schema, messages) => {
      seen.push(messages);
      if (structured instanceof Error) throw structured;
      return structured as never;
    },
  };
  return { llm, seen };
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

describe("triage", () => {
  it("fallback groups a deployment with its pods and skips info issues", () => {
    const problems = fallbackTriage(ALL, 5);
    expect(problems.map((p) => p.primary.id)).toEqual([webPod1.id, payPod.id]);
    expect(problems[0]?.related.map((i) => i.id).sort()).toEqual([webDeploy.id, webPod2.id].sort());
  });

  it("buildProblems drops duplicates and merges same-workload issues the model missed", () => {
    const problems = buildProblems(
      [
        { issueId: webPod1.id, relatedIssueIds: [] },
        { issueId: webPod1.id, relatedIssueIds: [] }, // duplicate
        { issueId: webPod2.id, relatedIssueIds: [] }, // already merged into the first
        { issueId: payPod.id, relatedIssueIds: [webPod1.id] }, // webPod1 already used
      ],
      ALL,
      5,
    );
    expect(problems.map((p) => p.primary.id)).toEqual([webPod1.id, payPod.id]);
    expect(problems[0]?.related.map((i) => i.id).sort()).toEqual([webDeploy.id, webPod2.id].sort());
    expect(problems[1]?.related).toEqual([]);
  });

  it("makes the pod the primary issue even when the LLM picks the deployment", async () => {
    const { llm } = fakeLlm([], {
      problems: [{ issueId: webDeploy.id, relatedIssueIds: [webPod1.id], reason: "web down" }],
    });
    const [problem] = await triage(llm, overview, ALL, 5);
    expect(problem?.primary.id).toBe(webPod1.id);
    expect(problem?.related.map((i) => i.id).sort()).toEqual([webDeploy.id, webPod2.id].sort());
  });

  it("groups a control-plane incident into one problem, starting from the API server", async () => {
    const cp = (component: string, category: string, severity: Issue["severity"] = "warning"): Issue => ({
      ...issue(`pod/kube-system/${component}-cp:${category}`, "Pod", `${component}-cp`, severity),
      category,
      resource: { kind: "Pod", namespace: "kube-system", name: `${component}-cp` },
    });
    const scheduler = cp("kube-scheduler", "controlplane-restart");
    const cm = cp("kube-controller-manager", "controlplane-restart");
    const apiserver = cp("kube-apiserver", "controlplane-probe-failures");
    // The LLM picks the scheduler and forgets the rest; code merges them and re-ranks.
    const { llm } = fakeLlm([], { problems: [{ issueId: scheduler.id, relatedIssueIds: [], reason: "restarts" }] });
    const [problem, ...rest] = await triage(llm, overview, [scheduler, cm, apiserver, payPod], 5);
    expect(problem?.primary.id).toBe(apiserver.id);
    expect(problem?.related.map((i) => i.id).sort()).toEqual([cm.id, scheduler.id].sort());
    expect(rest).toEqual([]);
    // etcd outranks the API server when both are involved.
    const etcd = cp("etcd", "controlplane-pod-down", "critical");
    expect(fallbackTriage([apiserver, etcd, scheduler], 5)[0]?.primary.id).toBe(etcd.id);
  });

  it("respects maxProblems", () => {
    expect(fallbackTriage(ALL, 1)).toHaveLength(1);
  });

  it("uses the LLM's picks when valid", async () => {
    const { llm } = fakeLlm([], { problems: [{ issueId: payPod.id, relatedIssueIds: [], reason: "bad image" }] });
    const problems = await triage(llm, overview, ALL, 5);
    expect(problems.map((p) => p.primary.id)).toEqual([payPod.id]);
    expect(problems[0]?.reason).toBe("bad image");
  });

  it("falls back when the LLM fails or returns nothing", async () => {
    const failing = fakeLlm([], new Error("connection refused")).llm;
    expect((await triage(failing, overview, ALL, 5)).length).toBe(2);
    const empty = fakeLlm([], { problems: [] }).llm;
    expect((await triage(empty, overview, ALL, 5)).length).toBe(2);
  });
});

describe("investigate loop", () => {
  const problem: Problem = { primary: webPod1, related: [], reason: "", severity: "critical" };
  let calls: unknown[] = [];
  const getLogs = tool(
    async (args: { pod: string }) => {
      calls.push(args);
      return `FATAL: DATABASE_URL is not set (${args.pod})`;
    },
    { name: "k8s_get_logs", description: "logs", schema: z.object({ pod: z.string() }) },
  );

  it("runs tools, feeds results back, and concludes", async () => {
    calls = [];
    const { llm, seen } = fakeLlm([call("k8s_get_logs", { pod: "web-1" }, "c1"), new AIMessage("I know the cause.")]);
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 5 });

    expect(calls).toEqual([{ pod: "web-1" }]);
    expect(finding.toolCalls).toBe(1);
    expect(finding.rootCause).toBe("DATABASE_URL is not set");
    // The second agent turn saw the tool result.
    const toolMsg = seen[1]?.find((m) => m instanceof ToolMessage);
    expect(String(toolMsg?.content)).toContain("FATAL");
  });

  it("stops at maxSteps and still concludes", async () => {
    calls = [];
    const { llm } = fakeLlm([
      call("k8s_get_logs", { pod: "a" }, "c1"),
      call("k8s_get_logs", { pod: "b" }, "c2"),
      call("k8s_get_logs", { pod: "c" }, "c3"), // never reached
    ]);
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 2 });
    expect(calls).toHaveLength(2);
    expect(finding.toolCalls).toBe(2);
    expect(finding.error).toBeUndefined();
  });

  it("answers unknown tools and repeated calls without running them", async () => {
    calls = [];
    const { llm, seen } = fakeLlm([
      call("k8s_delete_pod", { pod: "a" }, "c1"),
      call("k8s_get_logs", { pod: "a" }, "c2"),
      call("k8s_get_logs", { pod: "a" }, "c3"),
      new AIMessage("done"),
    ]);
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 10 });
    expect(calls).toHaveLength(1); // the repeat was not executed
    const toolReplies = seen.at(-1)!.filter((m) => m instanceof ToolMessage).map((m) => String(m.content));
    expect(toolReplies[0]).toContain('unknown tool "k8s_delete_pod"');
    expect(toolReplies[2]).toContain("already made this exact call");
    expect(finding.toolCalls).toBe(3);
  });

  it("treats null optional arguments as missing", async () => {
    calls = [];
    const optional = tool(
      async (args: { pod: string; container?: string }) => {
        calls.push(args);
        return "ok";
      },
      { name: "k8s_get_logs", description: "logs", schema: z.object({ pod: z.string(), container: z.string().optional() }) },
    );
    const { llm } = fakeLlm([call("k8s_get_logs", { pod: "a", container: null }, "c1"), new AIMessage("done")]);
    await investigate(problem, { llm, tools: [optional], maxSteps: 5 });
    expect(calls).toEqual([{ pod: "a" }]);
  });

  it("returns invalid tool arguments to the model as an error", async () => {
    calls = [];
    const { llm, seen } = fakeLlm([call("k8s_get_logs", { pod: 42 }, "c1"), new AIMessage("done")]);
    await investigate(problem, { llm, tools: [getLogs], maxSteps: 5 });
    expect(calls).toHaveLength(0);
    const reply = String(seen[1]?.find((m) => m instanceof ToolMessage)?.content);
    expect(reply).toMatch(/^Error:/);
    // The zod details (not just "did not match expected schema") reach the model.
    expect(reply).toContain("expected string");
    expect(reply).not.toContain("\n");
  });

  it("gives the model exact tool arguments instead of namespace/name", () => {
    const prompt = problemPrompt({ primary: webPod1, related: [webDeploy], reason: "", severity: "critical" }, 6);
    expect(prompt).toContain('namespace="shop" name="web-7db8d69f68-4f2n7"');
    expect(prompt).toContain('pod="web-7db8d69f68-4f2n7"');
    expect(prompt).toContain('namespace="shop" name="web"');
    expect(prompt).not.toContain("shop/web");
  });

  it("points cluster-level problems at the relevant k8s_cluster_health section", () => {
    const prompt = (i: Issue) => problemPrompt({ primary: i, related: [], reason: "", severity: i.severity }, 6);
    expect(prompt({ ...webDeploy, resource: { kind: "ValidatingWebhookConfiguration", name: "policy" } })).toContain('section="webhooks"');
    expect(prompt({ ...webDeploy, resource: { kind: "ControlPlane", name: "etcd" } })).toContain('section="etcd"');
    expect(prompt({ ...webDeploy, resource: { kind: "ControlPlane", name: "kube-apiserver" } })).toContain('section="control-plane"');
    const cpPod = { ...webPod1, category: "controlplane-restart", resource: { kind: "Pod", namespace: "kube-system", name: "kube-scheduler-cp" } };
    expect(prompt(cpPod)).toContain('pod="kube-scheduler-cp"');
    expect(prompt(cpPod)).toContain('section="control-plane"');
  });

  it("includes the rule's hint in the problem prompt", () => {
    const withHint = { ...webPod1, hint: "Read the previous container logs." };
    const prompt = problemPrompt({ primary: withHint, related: [], reason: "", severity: "critical" }, 6);
    expect(prompt).toContain("hint from rule: Read the previous container logs.");
  });

  it("makes the obvious first tool call in code before the model's first turn", async () => {
    const described: unknown[] = [];
    const describe = tool(
      async (args: { namespace: string; name: string }) => {
        described.push(args);
        return "state: waiting CrashLoopBackOff";
      },
      { name: "k8s_describe_pod", description: "describe", schema: z.object({ namespace: z.string(), name: z.string() }) },
    );
    const { llm, seen } = fakeLlm([
      call("k8s_describe_pod", { namespace: "shop", name: "web-7db8d69f68-4f2n7" }, "c1"), // repeat of the seed
      new AIMessage("done"),
    ]);
    const finding = await investigate(problem, { llm, tools: [describe], maxSteps: 5 });
    expect(described).toEqual([{ namespace: "shop", name: "web-7db8d69f68-4f2n7" }]); // only the seed ran
    expect(String(seen[0]?.find((m) => m instanceof ToolMessage)?.content)).toContain("CrashLoopBackOff");
    expect(finding.toolCalls).toBe(2); // seed + the blocked repeat
  });

  it("chooses seed calls by resource kind", () => {
    expect(seedCall(webPod1)).toEqual({ name: "k8s_describe_pod", args: { namespace: "shop", name: "web-7db8d69f68-4f2n7" } });
    expect(seedCall({ ...webDeploy, resource: { kind: "ValidatingWebhookConfiguration", name: "p" } })).toEqual({
      name: "k8s_cluster_health",
      args: { section: "webhooks" },
    });
    expect(seedCall({ ...webDeploy, resource: { kind: "ControlPlane", name: "etcd" } })?.args).toEqual({ section: "etcd" });
  });

  it("reports a failed investigation instead of throwing", async () => {
    const { llm } = fakeLlm([]); // first chat call throws
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 5 });
    expect(finding.error).toContain("ran out of replies");
    expect(finding.confidence).toBe("low");
  });
});
