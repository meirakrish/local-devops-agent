import type { PeerCertificate } from "../k8s/raw.js";
import type { HealthCheck } from "./cluster.js";

/**
 * Compact summaries of cluster objects. Raw Kubernetes objects are large; these
 * keep only what is useful for spotting problems (and what fits an LLM context).
 */

export interface NodeSummary {
  name: string;
  ready: boolean;
  readyMessage?: string;
  roles: string[];
  kubeletVersion?: string;
  /** Conditions such as MemoryPressure / DiskPressure / PIDPressure that are True. */
  pressures: string[];
  unschedulable: boolean;
  allocatable: { cpu?: string; memory?: string; pods?: string };
  /** Last kubelet heartbeat: renewTime of the node's Lease in kube-node-lease. */
  heartbeat?: string;
  /** Sum over non-terminated pods on the node (CPU in cores, memory in bytes). */
  requested?: { cpu: number; memory: number; pods: number };
}

export type ContainerStateName = "running" | "waiting" | "terminated" | "unknown";

export interface ContainerSummary {
  name: string;
  init: boolean;
  ready: boolean;
  restarts: number;
  state: ContainerStateName;
  reason?: string;
  message?: string;
  exitCode?: number;
  /** Why the previous run ended, e.g. OOMKilled / Error. */
  lastTerminationReason?: string;
  lastExitCode?: number;
}

export interface PodSummary {
  namespace: string;
  name: string;
  phase: string;
  /** Pod-level reason, e.g. "Evicted". */
  reason?: string;
  message?: string;
  nodeName?: string;
  owner?: { kind: string; name: string };
  createdAt?: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  containers: ContainerSummary[];
  /** Effective resource requests: CPU in cores, memory in bytes (what the scheduler uses). */
  requests: { cpu?: number; memory?: number };
  /** Set when the scheduler could not place the pod (PodScheduled=False). */
  unschedulable?: { reason?: string; message?: string };
}

export interface DeploymentCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface DeploymentSummary {
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  available: number;
  updated: number;
  conditions: DeploymentCondition[];
}

export interface EventSummary {
  /** Namespace of the involved object; undefined for cluster-scoped objects like Nodes. */
  namespace?: string;
  involvedKind?: string;
  involvedName?: string;
  reason?: string;
  message?: string;
  count: number;
  lastSeen?: string;
}

export interface EtcdSummary {
  dbSizeBytes?: number;
  quotaBytes: number;
  /** "flag" when read from etcd's --quota-backend-bytes, "default" when assumed (2 GiB). */
  quotaSource: "flag" | "default";
  /** Largest object counts per resource. */
  objectCounts: { resource: string; count: number }[];
}

/** A control-plane component pod (kube-system, label tier=control-plane). */
export interface ControlPlanePod {
  name: string;
  /** Value of the "component" label, e.g. kube-apiserver, etcd, kube-scheduler. */
  component: string;
  nodeName?: string;
  phase: string;
  ready: boolean;
  /** Waiting/terminated reason of the current container, e.g. CrashLoopBackOff. */
  stateReason?: string;
  restarts: number;
  /** How the previous container ended, when it has restarted. */
  lastRestart?: { finishedAt: string; reason?: string; exitCode?: number };
  /** Liveness/readiness/startup probe failures from Unhealthy events in the event window. */
  probeFailures?: { count: number; lastSeen: string; kinds: string[]; lastMessage: string };
}

export interface ControlPlaneSummary {
  serverVersion?: string;
  /** API server readiness checks (includes etcd); undefined when not visible. */
  readyz?: HealthCheck[];
  certificate?: PeerCertificate;
  etcd?: EtcdSummary;
  /** Control-plane pods; undefined when not visible (managed control planes hide them). */
  pods?: ControlPlanePod[];
  /** Checks that could not run and why, e.g. "etcd size: /metrics forbidden". */
  notVisible: string[];
}

export interface WebhookSummary {
  kind: "Validating" | "Mutating";
  configName: string;
  name: string;
  /** "Fail" (the v1 default) blocks matching requests when the webhook is unreachable. */
  failurePolicy: string;
  service?: { namespace: string; name: string };
  /** For service-backed webhooks: whether anything can answer. URL webhooks are "external". */
  status: "ok" | "service-missing" | "no-ready-endpoints" | "external" | "unknown";
  detail?: string;
}

export interface ClusterOverview {
  context: string;
  scannedAt: string;
  namespaceFilter?: string;
  namespaces: string[];
  nodes: NodeSummary[];
  pods: PodSummary[];
  deployments: DeploymentSummary[];
  warningEvents: EventSummary[];
  controlPlane: ControlPlaneSummary;
  webhooks: WebhookSummary[];
  /** Partial failures (e.g. RBAC forbids listing nodes); the scan continues. */
  errors: string[];
}

export type Severity = "critical" | "warning" | "info";

export interface Issue {
  /** Stable id, e.g. "pod/default/web-123:crashloop". */
  id: string;
  severity: Severity;
  category: string;
  resource: { kind: string; namespace?: string; name: string };
  title: string;
  evidence: string[];
  /** Rule-based next step; the LLM investigation (milestone 2) goes deeper. */
  hint?: string;
}
