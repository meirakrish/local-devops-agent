import { describe, expect, it } from "vitest";
import { computeConfidence, type ConfidenceInput } from "../src/agent/confidence.js";
import { checkFixes } from "../src/agent/fix-check.js";
import { Corpus } from "../src/agent/grounding.js";

// Real tool output from the demo cluster (shortened).
const DESCRIBE_CACHE = `Pod agent-test/cache-5cc48794d-2lc5m
Phase: Running  Node: devops-agent-demo-worker  Owner: ReplicaSet/cache-5cc48794d
Conditions: Ready=False (ContainersNotReady): containers with unready status: [cache]; PodScheduled=True
Containers:
- cache image=busybox:1.36 ready=false restarts=79
  state: waiting CrashLoopBackOff: back-off 5m0s restarting failed container=cache pod=cache-5cc48794d-2lc5m_agent-test
  last termination: OOMKilled exitCode=137
  command: sh -c echo 'warming cache'; tail /dev/zero
  resources: requests(memory=16Mi) limits(memory=32Mi)
  env: (none)
Events (newest first):
- 2026-10-10T15:53:56.000Z Pod/cache-5cc48794d-2lc5m BackOff (x19): Back-off restarting failed container cache in pod cache-5cc48794d-2lc5m_agent-test`;

const LIST_NODES = `devops-agent-demo-control-plane Ready roles=control-plane kubelet=v1.37.0 heartbeat=2s ago pressure=none requested cpu=950m/12 (8%) memory=290Mi/15.6Gi (2%) pods=9/110 (8%)
devops-agent-demo-worker Ready roles=worker kubelet=v1.37.0 heartbeat=3s ago pressure=none requested cpu=120m/12 (1%) memory=98Mi/15.6Gi (1%) pods=8/110 (7%)`;

const DESCRIBE_BATCH = `Pod agent-test/batch-5f5678686c-pmv6m
Phase: Pending  Node: <none>  Owner: ReplicaSet/batch-5f5678686c
Conditions: PodScheduled=False (Unschedulable): 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.
Containers:
- worker image=busybox:1.36 ready=false restarts=0
  resources: requests(cpu=1k) limits(none)`;

const LOGS_WEB = `=== previous run of app (last 50 lines) ===
starting web server v1.4.2
loading config from environment
FATAL: DATABASE_URL is not set, cannot connect to database`;

const PAYMENTS_ISSUE = `container payments is waiting: ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:1.99.99-doesnotexist": not found`;

describe("Corpus.supports", () => {
  const corpus = new Corpus([DESCRIBE_CACHE, LIST_NODES, DESCRIBE_BATCH, LOGS_WEB]);

  it("accepts quotes and close paraphrases of tool output", () => {
    expect(corpus.supports("Logs show: `FATAL: DATABASE_URL is not set, cannot connect to database`")).toBe(true);
    expect(corpus.supports("The pod was terminated with code 137 (OOMKilled).")).toBe(true);
    expect(corpus.supports("The container `cache` has 79 restarts.")).toBe(true);
    expect(corpus.supports("The memory limit for the container is 32Mi")).toBe(true);
    expect(corpus.supports("0/2 nodes are available: 1 Insufficient cpu")).toBe(true);
  });

  it("rejects numbers that never appeared, even among familiar words", () => {
    // Real model output: the pod requests cpu=1k, and 950m is what is already requested.
    expect(corpus.supports("The pod requests 1000m CPU, but only 950m is available on the control plane node.")).toBe(
      false,
    );
    expect(corpus.supports("The node is already at 80% CPU utilization.")).toBe(false);
  });

  it("rejects claims whose words are scattered across unrelated lines", () => {
    expect(corpus.supports("The database server node ran out of memory")).toBe(false);
    expect(corpus.supports("")).toBe(false);
  });

  it("matches concrete values as whole words only", () => {
    expect(corpus.hasValue("busybox:1.36")).toBe(true);
    expect(corpus.hasValue("32Mi")).toBe(true);
    expect(corpus.hasValue("2Mi")).toBe(false); // not inside "32Mi"
    expect(corpus.hasValue("cache-5cc48794d")).toBe(true);
    expect(corpus.hasValue("cache-5cc")).toBe(false);
  });
});

describe("computeConfidence", () => {
  const base: ConfidenceInput = {
    modelConfidence: "high",
    rootCause: "The container cache exceeds its 32Mi memory limit and is OOMKilled.",
    evidence: ["last termination: OOMKilled exitCode=137", "limits(memory=32Mi)"],
    toolOutputs: [DESCRIBE_CACHE],
    ruleText: ["Pod agent-test/cache-5cc48794d-2lc5m: oom", "container cache was OOMKilled"],
    stopReason: "model",
  };

  it("keeps high when the evidence is found in tool output", () => {
    expect(computeConfidence(base)).toEqual({
      confidence: "high",
      reason: "2 of 2 evidence point(s) found in tool output",
    });
  });

  it("never rates above the model", () => {
    expect(computeConfidence({ ...base, modelConfidence: "medium" })).toEqual({
      confidence: "medium",
      reason: "the model's own rating; 2 of 2 evidence point(s) found in tool output",
    });
  });

  it("drops to low when no evidence is found in tool output", () => {
    const result = computeConfidence({
      ...base,
      evidence: ["The node is already at 80% CPU utilization.", "The kernel killed the process at 3Gi"],
    });
    expect(result).toEqual({ confidence: "low", reason: "evidence not found in tool output; the model said high" });
  });

  it("drops to medium when fewer than half of the evidence points are found", () => {
    const result = computeConfidence({
      ...base,
      evidence: ["limits(memory=32Mi)", "Node memory is at 91%", "The app leaks 5Mi per request"],
    });
    expect(result.confidence).toBe("medium");
    expect(result.reason).toBe("only 1 of 3 evidence point(s) found in tool output; the model said high");
  });

  it("drops to low without evidence or without any tool data", () => {
    expect(computeConfidence({ ...base, evidence: [] }).reason).toContain("no evidence given");
    const noData = computeConfidence({ ...base, toolOutputs: [] });
    expect(noData.confidence).toBe("low");
    expect(noData.reason).toContain("no tool call returned data");
  });

  it("drops to medium when the root cause only restates the rule", () => {
    const result = computeConfidence({
      ...base,
      rootCause: "Container cache was OOMKilled.",
      evidence: ["container cache was OOMKilled"],
      toolOutputs: ["container cache was OOMKilled"],
    });
    expect(result).toEqual({
      confidence: "medium",
      reason: "root cause only restates the rule's finding; the model said high",
    });
    // Restating the rule is fine when the tool output added something beyond it.
    expect(computeConfidence({ ...base, rootCause: "Container cache was OOMKilled." }).confidence).toBe("high");
  });

  it("drops to medium when the loop was cut off", () => {
    expect(computeConfidence({ ...base, stopReason: "step-limit" }).reason).toBe(
      "step limit reached before the model finished; the model said high",
    );
    // Ending on repeats is not a sign of doubt: the model had nothing new to look up.
    expect(computeConfidence({ ...base, stopReason: "repeats" }).confidence).toBe("high");
  });

  it("lists every reason at the final level", () => {
    const result = computeConfidence({ ...base, modelConfidence: "medium", stopReason: "step-limit" });
    expect(result).toEqual({ confidence: "medium", reason: "step limit reached before the model finished" });
  });
});

describe("checkFixes", () => {
  const known = [DESCRIBE_CACHE, PAYMENTS_ISSUE, "Deployment agent-test/payments has 0/1 replicas ready"];

  it("flags an invented image tag but not the real one", () => {
    const flags = checkFixes(
      [
        "kubectl set image deployment/payments payments=nginx:1.25.9 -n agent-test",
        "Check that nginx:1.99.99-doesnotexist exists in the registry",
      ],
      known,
    );
    expect(flags).toEqual([
      { step: 0, kind: "unverified", value: "nginx:1.25.9", message: "does not appear in the cluster data" },
    ]);
  });

  it("flags invented resource names, namespaces, quantities and env values", () => {
    const flags = checkFixes(
      [
        "kubectl rollout restart deployment payment-api -n shop",
        "Raise the memory limit of deployment/cache to 64Mi",
        "Keep the 32Mi request on deployment/cache",
        "kubectl set env deployment/web DATABASE_URL=postgres://db/app",
      ],
      known,
    );
    expect(flags.map((f) => [f.step, f.value])).toEqual([
      [0, "payment-api"],
      [0, "shop"],
      [1, "64Mi"],
      [3, "web"],
      [3, "postgres://db/app"],
    ]);
  });

  it("does not flag generic advice, placeholders, URLs or times", () => {
    const flags = checkFixes(
      [
        "Increase the memory limit for the container.",
        "Apply the updated deployment configuration using `kubectl apply -f <your-deployment-file.yaml>`.",
        "kubectl set env deployment/cache DATABASE_URL=<your-database-url>",
        "See https://kubernetes.io/docs/concepts/ for details; the last restart was at 15:46:45.",
        "Edit the Deployment to remove `hostNetwork: true` from the pod template.",
        "Review the image name and tag (`image: <name>:<tag>`).",
        "kubectl get pods -n agent-test",
      ],
      known,
    );
    expect(flags).toEqual([]);
  });

  it("flags destructive commands and notes rollbacks", () => {
    const flags = checkFixes(
      [
        "kubectl delete pod cache-5cc48794d-2lc5m -n agent-test --grace-period=0 --force",
        "kubectl rollout undo deployment/payments -n agent-test",
        "Delete the Service if it is no longer needed.", // advice, not a command
      ],
      known,
    );
    expect(flags.map((f) => [f.step, f.kind, f.value])).toEqual([
      [0, "destructive", "kubectl delete"],
      [0, "destructive", "--force"],
      [0, "destructive", "--grace-period=0"],
      [1, "changes-cluster", "kubectl rollout undo"],
    ]);
  });
});
