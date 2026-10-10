import { formatCpu, formatMemory, parseQuantity } from "./quantity.js";
import { compareSeverity, worstSeverity } from "./severity.js";
import { minutesSince } from "./time.js";
import type { ContainerSummary, Issue, NodeSummary, PodSummary, Severity } from "./types.js";

/** Rules for pods and their containers. */

export interface PodRuleOptions {
  restartThreshold: number;
  now: Date;
  /** Pending / not-ready pods younger than this are treated as still starting. */
  gracePeriodMinutes?: number;
  /** Nodes, used to compare an unschedulable pod's requests with node capacity. */
  nodes?: NodeSummary[];
}

const IMAGE_ERRORS = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "ErrImageNeverPull"]);
const CONFIG_ERRORS = new Set(["CreateContainerConfigError", "CreateContainerError", "RunContainerError"]);

/** One problem found in a pod or one of its containers; a pod's findings become one Issue. */
interface PodFinding {
  severity: Severity;
  category: string;
  evidence: string;
  hint?: string;
}

function containerFindings(c: ContainerSummary, restartThreshold: number): PodFinding[] {
  const label = `${c.init ? "init container" : "container"} ${c.name}`;
  const findings: PodFinding[] = [];
  const detail = c.message ? `: ${c.message}` : "";

  // Checked first: "oom" explains a crash better than "crashloop".
  if (c.lastTerminationReason === "OOMKilled" || c.reason === "OOMKilled") {
    findings.push({
      severity: "critical",
      category: "oom",
      evidence: `${label} was OOMKilled`,
      hint: "Raise the container memory limit or reduce the app's memory usage.",
    });
  }

  // A crashlooping container cycles waiting(CrashLoopBackOff) -> running -> terminated(Error),
  // so a scan can catch it in the terminated phase too.
  const crashedAfterRestarts =
    c.state === "terminated" && !c.init && c.restarts > 0 && (c.exitCode ?? 0) !== 0;

  if ((c.state === "waiting" && c.reason === "CrashLoopBackOff") || crashedAfterRestarts) {
    const last = c.lastTerminationReason
      ? ` (last exit: ${c.lastTerminationReason}, code ${c.lastExitCode ?? "?"})`
      : "";
    const status = crashedAfterRestarts ? `exited with code ${c.exitCode} (crash loop)` : "is in CrashLoopBackOff";
    findings.push({
      severity: "critical",
      category: "crashloop",
      evidence: `${label} ${status}${last}, ${c.restarts} restarts`,
      hint: "Read the previous container logs (`kubectl logs --previous`) to see why it exits.",
    });
  } else if (c.state === "waiting" && c.reason && IMAGE_ERRORS.has(c.reason)) {
    findings.push({
      severity: "critical",
      category: "image-pull",
      evidence: `${label} is waiting: ${c.reason}${detail}`,
      hint: "Check the image name/tag exists and that pull credentials (imagePullSecrets) are set.",
    });
  } else if (c.state === "waiting" && c.reason && CONFIG_ERRORS.has(c.reason)) {
    findings.push({
      severity: "critical",
      category: "container-config",
      evidence: `${label} is waiting: ${c.reason}${detail}`,
      hint: "Usually a missing ConfigMap/Secret or bad env/volume reference; check pod events.",
    });
  }

  if (c.restarts >= restartThreshold && !findings.some((f) => f.category === "crashloop")) {
    findings.push({
      severity: "warning",
      category: "high-restarts",
      evidence: `${label} restarted ${c.restarts} times`,
      hint: "Check previous logs and liveness probe settings.",
    });
  }
  return findings;
}

/**
 * Compares an unschedulable pod's requests with the largest node's allocatable
 * resources. Done in code because a small model reads the numbers but does not
 * reliably compare them (it once suggested *raising* a 64-CPU request on 12-CPU nodes).
 */
export function capacityFinding(pod: PodSummary, nodes: NodeSummary[]): { evidence: string; hint: string } | undefined {
  const usable = nodes.filter((n) => n.ready && !n.unschedulable);
  const pool = usable.length > 0 ? usable : nodes;
  if (pool.length === 0) return undefined;

  const checks = [
    { name: "cpu", requested: pod.requests.cpu, fmt: formatCpu, key: "cpu" as const },
    { name: "memory", requested: pod.requests.memory, fmt: formatMemory, key: "memory" as const },
  ];
  const tooBig: string[] = [];
  const fits: string[] = [];
  for (const c of checks) {
    if (c.requested === undefined) continue;
    const largest = Math.max(...pool.map((n) => parseQuantity(n.allocatable[c.key]) ?? 0));
    if (largest <= 0) continue;
    const text = `requests ${c.name}=${c.fmt(c.requested)}, largest node allocatable ${c.name}=${c.fmt(largest)}`;
    (c.requested > largest ? tooBig : fits).push(text);
  }

  if (tooBig.length > 0) {
    return {
      evidence: `No node can ever fit this pod: ${tooBig.join("; ")}`,
      hint: "Lower the pod's resource requests so they fit on a node, or add larger nodes. More nodes of the same size will not help.",
    };
  }
  if (fits.length > 0) {
    return {
      evidence: `Pod would fit an empty node (${fits.join("; ")}), so other pods are using the capacity`,
      hint: "Free capacity (scale down or right-size other workloads), add nodes, or lower this pod's requests.",
    };
  }
  return undefined;
}

export function podIssues(pod: PodSummary, opts: PodRuleOptions): Issue[] {
  // Completed Job pods are healthy.
  if (pod.phase === "Succeeded") return [];

  const grace = opts.gracePeriodMinutes ?? 5;
  const oldEnough = minutesSince(pod.createdAt, opts.now) >= grace;
  const findings: PodFinding[] = pod.containers.flatMap((c) =>
    containerFindings(c, opts.restartThreshold),
  );

  if (pod.phase === "Pending" && pod.unschedulable) {
    const message = pod.unschedulable.message ?? pod.unschedulable.reason ?? "unknown reason";
    // Only add capacity numbers when the scheduler says resources are the problem.
    const capacity = /Insufficient (cpu|memory)/i.test(message) ? capacityFinding(pod, opts.nodes ?? []) : undefined;
    findings.push({
      severity: "critical",
      category: "unschedulable",
      evidence: `Pod cannot be scheduled: ${message}`,
      hint:
        capacity?.hint ??
        "Compare the pod's resource requests, nodeSelector/affinity and tolerations with available nodes.",
    });
    if (capacity) {
      findings.push({ severity: "critical", category: "unschedulable", evidence: capacity.evidence });
    }
  } else if (pod.phase === "Pending" && oldEnough && findings.length === 0) {
    findings.push({
      severity: "warning",
      category: "pending",
      evidence: "Pod has been Pending longer than the grace period",
      hint: "Check pod events for volume, image or scheduling problems.",
    });
  }

  if (pod.phase === "Failed") {
    findings.push({
      severity: "warning",
      category: pod.reason === "Evicted" ? "evicted" : "pod-failed",
      evidence: `Pod phase is Failed${pod.reason ? ` (${pod.reason})` : ""}${pod.message ? `: ${pod.message}` : ""}`,
      hint:
        pod.reason === "Evicted"
          ? "The node ran short on resources; check node pressure and pod requests/limits."
          : "Inspect container exit codes and logs.",
    });
  }

  if (
    pod.phase === "Running" &&
    oldEnough &&
    findings.length === 0 &&
    pod.readyContainers < pod.totalContainers
  ) {
    findings.push({
      severity: "warning",
      category: "not-ready",
      evidence: `Only ${pod.readyContainers}/${pod.totalContainers} containers ready`,
      hint: "Usually a failing readiness probe; check pod events and the probe endpoint.",
    });
  }

  if (findings.length === 0) return [];
  const primary = [...findings].sort((a, b) => compareSeverity(a.severity, b.severity))[0]!;
  return [
    {
      id: `pod/${pod.namespace}/${pod.name}:${primary.category}`,
      severity: worstSeverity(findings.map((f) => f.severity)),
      category: primary.category,
      resource: { kind: "Pod", namespace: pod.namespace, name: pod.name },
      title: `Pod ${pod.namespace}/${pod.name}: ${primary.category}`,
      evidence: findings.map((f) => f.evidence),
      hint: primary.hint,
      workload: pod.workload ? `${pod.namespace}/${pod.workload}` : undefined,
    },
  ];
}
