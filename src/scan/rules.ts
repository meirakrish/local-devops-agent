import type {
  ClusterOverview,
  ContainerSummary,
  DeploymentSummary,
  Issue,
  NodeSummary,
  PodSummary,
  Severity,
} from "./types.js";
import { controlPlaneIssues, controlPlanePodIssues, nodeCapacityIssues, webhookIssues } from "./cluster-rules.js";
import { formatCpu, formatMemory, parseQuantity } from "./quantity.js";
import { dnsIssues, podCreateFailureIssues, serviceIssues, workloadIssues } from "./workload-rules.js";

/**
 * Deterministic, rule-based problem detection. The issues found here decide severity
 * and the exit code, and are the candidates the LLM triage step chooses from.
 */

export interface RuleOptions {
  restartThreshold: number;
  now: Date;
  /** Pending / not-ready pods younger than this are treated as still starting. */
  gracePeriodMinutes?: number;
  /** Nodes, used to compare an unschedulable pod's requests with node capacity. */
  nodes?: NodeSummary[];
  /** How far back restarts and probe failures count as recent (default 60). */
  windowMinutes?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

function worst(severities: Severity[]): Severity {
  return [...severities].sort(compareSeverity)[0] ?? "info";
}

const IMAGE_ERRORS = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "ErrImageNeverPull"]);
const CONFIG_ERRORS = new Set(["CreateContainerConfigError", "CreateContainerError", "RunContainerError"]);

export function nodeIssues(node: NodeSummary): Issue[] {
  const issues: Issue[] = [];
  const resource = { kind: "Node", name: node.name };
  if (!node.ready) {
    issues.push({
      id: `node/${node.name}:not-ready`,
      severity: "critical",
      category: "node-not-ready",
      resource,
      title: `Node ${node.name} is NotReady`,
      evidence: [node.readyMessage ?? "Ready condition is not True"],
      hint: "Check kubelet / container runtime on the node and its conditions (`kubectl describe node`).",
    });
  }
  if (node.pressures.length > 0) {
    issues.push({
      id: `node/${node.name}:pressure`,
      severity: "warning",
      category: "node-pressure",
      resource,
      title: `Node ${node.name} reports ${node.pressures.join(", ")}`,
      evidence: node.pressures.map((p) => `${p}=True`),
      hint: "Look for pods using excessive memory/disk on this node; pods may be evicted.",
    });
  }
  if (node.unschedulable) {
    issues.push({
      id: `node/${node.name}:cordoned`,
      severity: "info",
      category: "node-cordoned",
      resource,
      title: `Node ${node.name} is cordoned (unschedulable)`,
      evidence: ["spec.unschedulable=true"],
      hint: "Expected during maintenance; uncordon when done.",
    });
  }
  return issues;
}

interface Finding {
  severity: Severity;
  category: string;
  evidence: string;
  hint?: string;
}

function containerFindings(c: ContainerSummary, restartThreshold: number): Finding[] {
  const label = `${c.init ? "init container" : "container"} ${c.name}`;
  const findings: Finding[] = [];
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

function ageMinutes(createdAt: string | undefined, now: Date): number {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  return (now.getTime() - new Date(createdAt).getTime()) / 60_000;
}

export function podIssues(pod: PodSummary, opts: RuleOptions): Issue[] {
  // Completed Job pods are healthy.
  if (pod.phase === "Succeeded") return [];

  const grace = opts.gracePeriodMinutes ?? 5;
  const oldEnough = ageMinutes(pod.createdAt, opts.now) >= grace;
  const findings: Finding[] = pod.containers.flatMap((c) =>
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
      severity: worst(findings.map((f) => f.severity)),
      category: primary.category,
      resource: { kind: "Pod", namespace: pod.namespace, name: pod.name },
      title: `Pod ${pod.namespace}/${pod.name}: ${primary.category}`,
      evidence: findings.map((f) => f.evidence),
      hint: primary.hint,
      workload: pod.workload ? `${pod.namespace}/${pod.workload}` : undefined,
    },
  ];
}

export function deploymentIssues(d: DeploymentSummary): Issue[] {
  const resource = { kind: "Deployment", namespace: d.namespace, name: d.name };
  const workload = `${d.namespace}/${d.name}`;
  const progressing = d.conditions.find((c) => c.type === "Progressing");
  const issues: Issue[] = [];

  if (progressing?.status === "False" && progressing.reason === "ProgressDeadlineExceeded") {
    issues.push({
      id: `deployment/${d.namespace}/${d.name}:rollout-stuck`,
      severity: "critical",
      category: "rollout-stuck",
      resource,
      title: `Deployment ${d.namespace}/${d.name} rollout exceeded its progress deadline`,
      evidence: [progressing.message ?? "Progressing=False (ProgressDeadlineExceeded)"],
      hint: "Inspect the new ReplicaSet's pods; consider `kubectl rollout undo` after finding the cause.",
      workload,
    });
  }

  if (d.desired > 0 && d.ready < d.desired) {
    // ReplicaFailure=True: the API server rejected its pods, so there are no pods to look at.
    const replicaFailure = d.conditions.find((c) => c.type === "ReplicaFailure" && c.status === "True");
    issues.push({
      id: `deployment/${d.namespace}/${d.name}:unavailable`,
      severity: d.ready === 0 ? "critical" : "warning",
      category: "replicas-unavailable",
      resource,
      title: `Deployment ${d.namespace}/${d.name} has ${d.ready}/${d.desired} replicas ready`,
      evidence: [
        `desired=${d.desired} ready=${d.ready} available=${d.available} updated=${d.updated}`,
        ...(replicaFailure ? [`ReplicaFailure (${replicaFailure.reason ?? "?"}): ${replicaFailure.message ?? ""}`] : []),
      ],
      hint: replicaFailure
        ? "Its pods cannot be created; the ReplicaSet's FailedCreate events say why (quota, Pod Security, admission webhook)."
        : "See the pod issues for this deployment for the underlying cause.",
      workload,
    });
  }
  return issues;
}

export function detectIssues(overview: ClusterOverview, opts: RuleOptions): Issue[] {
  const cpPodIssues = controlPlanePodIssues(overview.controlPlane.pods ?? [], opts.now, opts.windowMinutes ?? 60);
  // A control-plane pod gets one issue from the control-plane rule, which includes its
  // current state, instead of a second one from the generic pod rules.
  const covered = new Set(cpPodIssues.map((i) => i.resource.name));
  const coveredByControlPlane = (i: Issue) =>
    i.resource.kind === "Pod" && i.resource.namespace === "kube-system" && covered.has(i.resource.name);

  // Services behind a webhook or cluster DNS get their own, more specific rules.
  const coveredServices = new Set([
    ...overview.webhooks.flatMap((w) => (w.service ? [`${w.service.namespace}/${w.service.name}`] : [])),
    ...(overview.dns.service ? [`${overview.dns.service.namespace}/${overview.dns.service.name}`] : []),
  ]);
  // A FailedCreate event outlives the failure; skip it once its workload is fully ready.
  const fullyReady = new Set(
    [...overview.deployments, ...overview.workloads]
      .filter((w) => w.ready >= w.desired)
      .map((w) => `${w.namespace}/${w.name}`),
  );

  const issues = [
    ...controlPlaneIssues(overview.controlPlane, opts.now),
    ...cpPodIssues,
    ...overview.webhooks.flatMap(webhookIssues),
    ...overview.nodes.flatMap(nodeIssues),
    ...overview.nodes.flatMap((n) => nodeCapacityIssues(n, opts.now, overview.controlPlane.serverVersion)),
    ...overview.pods
      .flatMap((p) => podIssues(p, { ...opts, nodes: opts.nodes ?? overview.nodes }))
      .filter((i) => !coveredByControlPlane(i)),
    ...overview.deployments.flatMap(deploymentIssues),
    ...overview.workloads.flatMap(workloadIssues),
    ...overview.services
      .filter((s) => !coveredServices.has(`${s.namespace}/${s.name}`))
      .flatMap((s) => serviceIssues(s, opts.now, opts.gracePeriodMinutes)),
    ...dnsIssues(overview.dns),
    ...podCreateFailureIssues(overview.podCreateFailures).filter((i) => !i.workload || !fullyReady.has(i.workload)),
  ];
  return issues.sort(
    (a, b) => compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id),
  );
}
