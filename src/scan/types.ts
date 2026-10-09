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

export interface ClusterOverview {
  context: string;
  scannedAt: string;
  namespaceFilter?: string;
  namespaces: string[];
  nodes: NodeSummary[];
  pods: PodSummary[];
  deployments: DeploymentSummary[];
  warningEvents: EventSummary[];
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
