import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { investigate, problemPrompt, seedCall } from "../src/agent/investigate.js";
import { addMissedCritical, buildProblems, fallbackTriage, triage } from "../src/agent/triage.js";
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

// Like the rules, pod and Deployment issues record their workload, which triage groups by.
const webPod1 = {
  ...issue("pod/shop/web-7db8d69f68-4f2n7:crashloop", "Pod", "web-7db8d69f68-4f2n7"),
  workload: "shop/web",
};
const webPod2 = {
  ...issue("pod/shop/web-7db8d69f68-q5rls:crashloop", "Pod", "web-7db8d69f68-q5rls"),
  workload: "shop/web",
};
const webDeploy = { ...issue("deployment/shop/web:unavailable", "Deployment", "web"), workload: "shop/web" };
const payPod = {
  ...issue("pod/shop/payments-9877b44c9-hql6z:image-pull", "Pod", "payments-9877b44c9-hql6z"),
  workload: "shop/payments",
};
const cordoned = issue("node/n1:cordoned", "Node", "n1", "info");
const ALL = [webDeploy, webPod1, webPod2, payPod, cordoned];

const overview: ClusterOverview = {
  context: "test",
  scannedAt: "2026-01-01T00:00:00.000Z",
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
  jobs: [],
  cronJobs: [],
  persistentVolumeClaims: [],
  storageEvents: [],
  apiHealth: { notVisible: [] },
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

  it("buildProblems keeps another workload's issues out of a problem, so they can form their own", () => {
    const problems = buildProblems([{ issueId: payPod.id, relatedIssueIds: [webDeploy.id, cordoned.id] }], ALL, 5);
    // The node issue has no workload, so the model's merge is kept; the web Deployment is not.
    expect(problems[0]?.related.map((i) => i.id)).toEqual([cordoned.id]);
    const completed = addMissedCritical(problems, ALL, 5);
    expect(completed.map((p) => p.primary.id)).toContain(webPod1.id);
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
    const problems = await triage(llm, overview, [scheduler, cm, apiserver, payPod], 5);
    const problem = problems.find((p) => p.primary.resource.namespace === "kube-system");
    expect(problem?.primary.id).toBe(apiserver.id);
    expect(problem?.related.map((i) => i.id).sort()).toEqual([cm.id, scheduler.id].sort());
    // The critical image-pull issue the LLM skipped is added as its own problem.
    expect(problems.map((p) => p.primary.id)).toEqual([payPod.id, apiserver.id]);
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
    expect(problems[0]?.primary.id).toBe(payPod.id);
    expect(problems[0]?.reason).toBe("bad image");
  });

  it("adds critical problems the LLM left out, while there is room", async () => {
    const { llm } = fakeLlm([], { problems: [{ issueId: payPod.id, relatedIssueIds: [], reason: "bad image" }] });
    const problems = await triage(llm, overview, ALL, 5);
    expect(problems.map((p) => p.primary.id)).toEqual([payPod.id, webPod1.id]);
    expect(problems[1]?.reason).toBe("added: critical issue not chosen by the LLM");
    expect(problems[1]?.related.map((i) => i.id).sort()).toEqual([webDeploy.id, webPod2.id].sort());

    const full = await triage(
      fakeLlm([], { problems: [{ issueId: payPod.id, relatedIssueIds: [], reason: "" }] }).llm,
      overview,
      ALL,
      1,
    );
    expect(full.map((p) => p.primary.id)).toEqual([payPod.id]);
  });

  it("leaves skipped warnings to the LLM's judgement", () => {
    const warning = issue("pod/shop/api-5f6d7c8b9-abcde:high-restarts", "Pod", "api-5f6d7c8b9-abcde", "warning");
    const picked = buildProblems([{ issueId: payPod.id }], [payPod, warning], 5);
    expect(addMissedCritical(picked, [payPod, warning], 5)).toEqual(picked);
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

  it("attaches the investigation's token usage to the finding", async () => {
    const { llm } = fakeLlm([new AIMessage("I know the cause.")]);
    let taken = 0;
    llm.takeUsage = () => ({ calls: ++taken, promptTokens: 100, outputTokens: 10, peakPromptTokens: 100 });
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 5 });
    // Taken once at the start (discarding earlier calls) and once at the end.
    expect(finding.usage?.calls).toBe(2);
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
    const toolReplies = seen
      .at(-1)!
      .filter((m) => m instanceof ToolMessage)
      .map((m) => String(m.content));
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
      {
        name: "k8s_get_logs",
        description: "logs",
        schema: z.object({ pod: z.string(), container: z.string().optional() }),
      },
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
    expect(prompt({ ...webDeploy, resource: { kind: "ValidatingWebhookConfiguration", name: "policy" } })).toContain(
      'section="webhooks"',
    );
    expect(prompt({ ...webDeploy, resource: { kind: "ControlPlane", name: "etcd" } })).toContain('section="etcd"');
    expect(prompt({ ...webDeploy, resource: { kind: "ControlPlane", name: "kube-apiserver" } })).toContain(
      'section="control-plane"',
    );
    const cpPod = {
      ...webPod1,
      category: "controlplane-restart",
      resource: { kind: "Pod", namespace: "kube-system", name: "kube-scheduler-cp" },
    };
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
      {
        name: "k8s_describe_pod",
        description: "describe",
        schema: z.object({ namespace: z.string(), name: z.string() }),
      },
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
    expect(seedCall(webPod1)).toEqual({
      name: "k8s_describe_pod",
      args: { namespace: "shop", name: "web-7db8d69f68-4f2n7" },
    });
    expect(seedCall({ ...webDeploy, resource: { kind: "ValidatingWebhookConfiguration", name: "p" } })).toEqual({
      name: "k8s_cluster_health",
      args: { section: "webhooks" },
    });
    expect(seedCall({ ...webDeploy, resource: { kind: "ControlPlane", name: "etcd" } })?.args).toEqual({
      section: "etcd",
    });
    expect(seedCall(webDeploy)).toEqual({
      name: "k8s_get_workload",
      args: { kind: "Deployment", namespace: "shop", name: "web" },
    });
    expect(
      seedCall({ ...webDeploy, resource: { kind: "DaemonSet", namespace: "kube-system", name: "kube-proxy" } }),
    ).toEqual({
      name: "k8s_get_workload",
      args: { kind: "DaemonSet", namespace: "kube-system", name: "kube-proxy" },
    });
    expect(seedCall({ ...webDeploy, resource: { kind: "Service", namespace: "shop", name: "web" } })).toEqual({
      name: "k8s_get_service",
      args: { namespace: "shop", name: "web" },
    });
  });

  it("seeds a ReplicaSet's FailedCreate with its Deployment, and a Job's with the Job (its events included)", () => {
    const rs = {
      ...issue("replicaset/shop/web-7db8d69f68:create-failed", "ReplicaSet", "web-7db8d69f68"),
      category: "pod-create-failed",
      workload: "shop/web",
    };
    expect(seedCall(rs)).toEqual({
      name: "k8s_get_workload",
      args: { kind: "Deployment", namespace: "shop", name: "web" },
    });
    const job = {
      ...issue("job/shop/backup:create-failed", "Job", "backup"),
      category: "pod-create-failed",
      workload: "shop/backup",
    };
    expect(seedCall(job)).toEqual({
      name: "k8s_get_workload",
      args: { kind: "Job", namespace: "shop", name: "backup" },
    });
  });

  it("seeds Jobs, CronJobs, PVCs, APIServices and stuck namespaces with the matching tool", () => {
    const cronJob = {
      ...issue("cronjob/shop/report:last-run-failed", "CronJob", "report"),
      category: "cronjob-failed",
    };
    expect(seedCall(cronJob)).toEqual({
      name: "k8s_get_workload",
      args: { kind: "CronJob", namespace: "shop", name: "report" },
    });
    const pvc = { ...issue("pvc/shop/data:pending", "PersistentVolumeClaim", "data"), category: "pvc-pending" };
    expect(seedCall(pvc)).toEqual({
      name: "k8s_list_events",
      args: { namespace: "shop", objectName: "data", objectKind: "PersistentVolumeClaim" },
    });
    const api: Issue = {
      ...issue("apiservice/v1beta1.metrics.k8s.io:unavailable", "APIService", "v1beta1.metrics.k8s.io"),
      resource: { kind: "APIService", name: "v1beta1.metrics.k8s.io" },
    };
    const ns: Issue = {
      ...issue("namespace/old:stuck-terminating", "Namespace", "old"),
      resource: { kind: "Namespace", name: "old" },
    };
    for (const i of [api, ns]) {
      expect(seedCall(i)).toEqual({ name: "k8s_cluster_health", args: { section: "apiservices" } });
    }
    const lease: Issue = {
      ...issue("controlplane/kube-scheduler:leader-stale", "ControlPlane", "kube-scheduler"),
      resource: { kind: "ControlPlane", name: "kube-scheduler" },
    };
    expect(seedCall(lease)).toEqual({ name: "k8s_cluster_health", args: { section: "control-plane" } });
  });

  it("reports a failed investigation instead of throwing", async () => {
    const { llm } = fakeLlm([]); // first chat call throws
    const finding = await investigate(problem, { llm, tools: [getLogs], maxSteps: 5 });
    expect(finding.error).toContain("ran out of replies");
    expect(finding.confidence).toBe("low");
  });
});

describe("triage grouping by workload", () => {
  const svc: Issue = { ...issue("service/shop/web:no-ready-endpoints", "Service", "web"), workload: "shop/web" };
  const sts = { ...issue("statefulset/shop/db:unavailable", "StatefulSet", "db"), workload: "shop/db" };
  const stsPod = { ...issue("pod/shop/db-0:crashloop", "Pod", "db-0"), workload: "shop/db" };
  const rs = {
    ...issue("replicaset/shop/api-5f6d7c8b9:create-failed", "ReplicaSet", "api-5f6d7c8b9"),
    category: "pod-create-failed",
    workload: "shop/api",
  };
  const apiDeploy = { ...issue("deployment/shop/api:unavailable", "Deployment", "api"), workload: "shop/api" };

  it("merges a Service, its Deployment and pods into one problem led by a pod", () => {
    const problems = fallbackTriage([svc, webDeploy, webPod1], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(webPod1);
    expect(problems[0]?.related.map((i) => i.id).sort()).toEqual([svc.id, webDeploy.id].sort());
  });

  it("groups StatefulSet pods with their StatefulSet, which pod names alone cannot do", () => {
    const problems = fallbackTriage([sts, stsPod], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(stsPod);
  });

  it("leads with the FailedCreate issue when a Deployment has no pods", () => {
    const problems = fallbackTriage([apiDeploy, rs], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(rs);
  });

  it("groups a pending PVC with the pods that wait for it, led by a pod", () => {
    const pvc: Issue = {
      ...issue("pvc/shop/data-db-0:pending", "PersistentVolumeClaim", "data-db-0"),
      category: "pvc-pending",
      workload: "shop/db",
    };
    const problems = fallbackTriage([pvc, sts, stsPod], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(stsPod);
    expect(problems[0]?.related.map((i) => i.id).sort()).toEqual([pvc.id, sts.id].sort());
  });

  it("groups a failing CronJob with the failed pods of its Jobs", () => {
    const cronJob: Issue = {
      ...issue("cronjob/shop/report:last-run-failed", "CronJob", "report", "warning"),
      category: "cronjob-failed",
      workload: "shop/report",
    };
    const jobPod: Issue = {
      ...issue("pod/shop/report-29123-abcde:pod-failed", "Pod", "report-29123-abcde", "warning"),
      category: "pod-failed",
      workload: "shop/report",
    };
    const problems = fallbackTriage([cronJob, jobPod], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(jobPod);
  });
});

describe("triage grouping of cluster-level issues", () => {
  const cluster = (id: string, kind: string, name: string, category: string, severity: Issue["severity"]): Issue => ({
    id,
    severity,
    category,
    resource: { kind, name },
    title: `${kind} ${name}`,
    evidence: [],
  });
  const api = cluster(
    "apiservice/v1beta1.metrics.k8s.io:unavailable",
    "APIService",
    "v1beta1.metrics.k8s.io",
    "apiservice-unavailable",
    "critical",
  );
  const stuckOnApi = cluster(
    "namespace/old-app:stuck-terminating",
    "Namespace",
    "old-app",
    "namespace-terminating-api",
    "warning",
  );
  const stuckOnFinalizer = cluster(
    "namespace/operator:stuck-terminating",
    "Namespace",
    "operator",
    "namespace-terminating",
    "warning",
  );

  it("merges an unavailable APIService and the namespaces it keeps from deleting, led by the APIService", () => {
    const problems = fallbackTriage([stuckOnApi, stuckOnFinalizer, api], 5);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.primary).toBe(api);
    expect(problems[0]?.related).toEqual([stuckOnApi]);
    expect(problems[1]?.primary).toBe(stuckOnFinalizer);
  });

  it("merges the APIService group even when the LLM picks the namespace", () => {
    const problems = buildProblems([{ issueId: stuckOnApi.id }], [api, stuckOnApi], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(api);
  });

  it("treats a stale leader lease as part of the control-plane incident", () => {
    const lease = cluster(
      "controlplane/kube-scheduler:leader-stale",
      "ControlPlane",
      "kube-scheduler",
      "leader-election-stale",
      "critical",
    );
    const etcd: Issue = {
      ...cluster(
        "pod/kube-system/etcd-cp:controlplane-pod-down",
        "Pod",
        "etcd-cp",
        "controlplane-pod-down",
        "critical",
      ),
      resource: { kind: "Pod", namespace: "kube-system", name: "etcd-cp" },
    };
    const problems = fallbackTriage([lease, etcd], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.primary).toBe(etcd);
    expect(problems[0]?.related).toEqual([lease]);
    // On its own (managed cluster, no pods visible), the lease leads the problem.
    expect(fallbackTriage([lease], 5)[0]?.primary).toBe(lease);
  });
});
