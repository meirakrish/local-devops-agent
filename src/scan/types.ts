import type { PeerCertificate } from "../k8s/raw.js";
import type { HealthCheck } from "./apiserver-parse.js";

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
  /** Owning workload: the Deployment of a ReplicaSet pod, else the owner (StatefulSet, DaemonSet, Job). */
  workload?: string;
  createdAt?: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  containers: ContainerSummary[];
  /** Effective resource requests: CPU in cores, memory in bytes (what the scheduler uses). */
  requests: { cpu?: number; memory?: number };
  /** Set when the scheduler could not place the pod (PodScheduled=False). */
  unschedulable?: { reason?: string; message?: string };
  /** Names of the PersistentVolumeClaims the pod mounts. */
  claims?: string[];
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

/** A DaemonSet or StatefulSet (Deployments have their own summary with conditions). */
export interface WorkloadSummary {
  kind: "DaemonSet" | "StatefulSet";
  namespace: string;
  name: string;
  /** DaemonSet: nodes that should run a pod. StatefulSet: spec.replicas. */
  desired: number;
  ready: number;
  updated: number;
  /** StatefulSet revisions; they differ while a rollout is in progress (or stuck). */
  currentRevision?: string;
  updateRevision?: string;
}

/** A Job, as far as the failed-Job checks need it. */
export interface JobSummary {
  namespace: string;
  name: string;
  /** Name of the CronJob that created it, if any. */
  cronJob?: string;
  createdAt?: string;
  completionTime?: string;
  active: number;
  succeeded: number;
  failed: number;
  /** Complete=True: the Job finished successfully. */
  complete: boolean;
  /** Failed=True condition, e.g. BackoffLimitExceeded or DeadlineExceeded. */
  failedCondition?: { reason?: string; message?: string; since?: string };
  backoffLimit?: number;
}

export interface CronJobSummary {
  namespace: string;
  name: string;
  schedule: string;
  suspended: boolean;
  lastScheduleTime?: string;
  lastSuccessfulTime?: string;
  /** Jobs the CronJob currently runs. */
  active: number;
}

export interface PvcSummary {
  namespace: string;
  name: string;
  /** Pending, Bound or Lost. */
  phase: string;
  /** The StorageClass it asks for; undefined when it names none. */
  storageClass?: string;
  createdAt?: string;
  requested?: string;
  volumeName?: string;
  /** The StorageClass binds only once a pod uses the claim (volumeBindingMode WaitForFirstConsumer). */
  waitForFirstConsumer?: boolean;
  /** Why the claim cannot be provisioned, when visible from the StorageClasses (e.g. class missing). */
  storageClassProblem?: string;
}

/** An aggregated API (APIService backed by a Service, e.g. metrics-server). Local APIServices are skipped. */
export interface ApiServiceSummary {
  name: string;
  service: { namespace: string; name: string };
  available: boolean;
  reason?: string;
  message?: string;
  /** When the Available condition last changed. */
  since?: string;
}

/** A namespace in phase Terminating, with the conditions that say what blocks its deletion. */
export interface TerminatingNamespace {
  name: string;
  deletionTimestamp?: string;
  /** Deletion conditions that are True, e.g. NamespaceDeletionDiscoveryFailure. */
  conditions: { type: string; reason?: string; message?: string }[];
  finalizers: string[];
}

/** Cluster-level API health: aggregated APIs and namespaces stuck deleting. */
export interface ApiHealthSummary {
  /** Undefined when not visible. */
  apiServices?: ApiServiceSummary[];
  /** Undefined when not visible. */
  terminatingNamespaces?: TerminatingNamespace[];
  /** Checks that could not run and why. */
  notVisible: string[];
}

/** Leader-election Lease of kube-scheduler or kube-controller-manager (kube-system). */
export interface LeaderLease {
  component: string;
  holder?: string;
  renewTime?: string;
  leaseDurationSeconds?: number;
}

/** A pod selected by a Service, as far as the Service checks need it. */
export interface ServicePod {
  name: string;
  ready: boolean;
  phase: string;
  /** Waiting/terminated reason of a container that is not running, e.g. CrashLoopBackOff. */
  reason?: string;
  createdAt?: string;
  /** Owning workload name (Deployment, StatefulSet, DaemonSet or Job). */
  workload?: string;
}

export interface ServiceSummary {
  namespace: string;
  name: string;
  type: string;
  selector: Record<string, string>;
  readyEndpoints: number;
  notReadyEndpoints: number;
  /** Non-terminated pods in the namespace that match the selector. */
  pods: ServicePod[];
  /**
   * For each selector key, the values that pods in the namespace actually carry. Shows a
   * selector typo ("app=fronted" vs pods with "app=frontend") without the model comparing.
   */
  podLabelValues: Record<string, string[]>;
}

/** Cluster DNS: the kube-dns Service in kube-system (CoreDNS in most clusters). */
export interface DnsSummary {
  service?: ServiceSummary;
  /** Why DNS could not be checked, e.g. no kube-dns Service or forbidden. */
  notVisible?: string;
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
  /** Leader-election Leases that exist; a missing one is listed in `notVisible`. */
  leaderLeases?: LeaderLease[];
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
  /** DaemonSets and StatefulSets. */
  workloads: WorkloadSummary[];
  /** Services with a selector (others have manually managed endpoints and are skipped). */
  services: ServiceSummary[];
  dns: DnsSummary;
  warningEvents: EventSummary[];
  /**
   * FailedCreate events of pod controllers (ReplicaSet, StatefulSet, DaemonSet, Job) in
   * the event window. Collected separately from `warningEvents`, which is capped, because
   * a controller that cannot create pods leaves no pod for the other rules to see.
   */
  podCreateFailures: EventSummary[];
  controlPlane: ControlPlaneSummary;
  webhooks: WebhookSummary[];
  jobs: JobSummary[];
  cronJobs: CronJobSummary[];
  persistentVolumeClaims: PvcSummary[];
  /**
   * FailedMount, FailedAttachVolume and ProvisioningFailed events in the event window,
   * collected separately from the capped `warningEvents` (like `podCreateFailures`).
   */
  storageEvents: EventSummary[];
  /** Aggregated APIs and stuck namespace deletions; checked regardless of --namespace. */
  apiHealth: ApiHealthSummary;
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
  /** Rule-based next step; shown in the report and passed to the LLM investigation. */
  hint?: string;
  /**
   * "namespace/name" of the workload (Deployment, StatefulSet, DaemonSet, Job) this issue
   * belongs to. Triage groups issues of one workload into one problem.
   */
  workload?: string;
}
