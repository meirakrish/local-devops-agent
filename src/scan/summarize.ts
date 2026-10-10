import type {
  CoreV1Event,
  V1APIService,
  V1Container,
  V1CronJob,
  V1Job,
  V1Lease,
  V1Namespace,
  V1PersistentVolumeClaim,
  V1StorageClass,
  V1Endpoint,
  V1ContainerStatus,
  V1DaemonSet,
  V1Deployment,
  V1EndpointSlice,
  V1Node,
  V1Pod,
  V1Service,
  V1StatefulSet,
} from "@kubernetes/client-node";
import type {
  ApiServiceSummary,
  ContainerSummary,
  CronJobSummary,
  DeploymentSummary,
  EventSummary,
  JobSummary,
  LeaderLease,
  NodeSummary,
  PodSummary,
  PvcSummary,
  ServiceSummary,
  TerminatingNamespace,
  WorkloadSummary,
} from "./types.js";
import { parseQuantity } from "./quantity.js";

const PRESSURE_CONDITIONS = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

function toIso(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function summarizeNode(node: V1Node): NodeSummary {
  const conditions = node.status?.conditions ?? [];
  const readyCond = conditions.find((c) => c.type === "Ready");
  const labels = node.metadata?.labels ?? {};
  const roles = Object.keys(labels)
    .filter((l) => l.startsWith("node-role.kubernetes.io/"))
    .map((l) => l.slice("node-role.kubernetes.io/".length));
  const alloc = node.status?.allocatable ?? {};
  return {
    name: node.metadata?.name ?? "<unknown>",
    ready: readyCond?.status === "True",
    readyMessage: readyCond?.status === "True" ? undefined : readyCond?.message,
    roles: roles.length > 0 ? roles : ["worker"],
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
    pressures: conditions.filter((c) => PRESSURE_CONDITIONS.includes(c.type) && c.status === "True").map((c) => c.type),
    unschedulable: node.spec?.unschedulable === true,
    allocatable: { cpu: alloc["cpu"], memory: alloc["memory"], pods: alloc["pods"] },
  };
}

function summarizeContainer(cs: V1ContainerStatus, init: boolean): ContainerSummary {
  const { running, waiting, terminated } = cs.state ?? {};
  const last = cs.lastState?.terminated;
  return {
    name: cs.name,
    init,
    ready: cs.ready,
    restarts: cs.restartCount ?? 0,
    state: running ? "running" : waiting ? "waiting" : terminated ? "terminated" : "unknown",
    reason: waiting?.reason ?? terminated?.reason,
    message: waiting?.message ?? terminated?.message,
    exitCode: terminated?.exitCode,
    lastTerminationReason: last?.reason,
    lastExitCode: last?.exitCode,
  };
}

/**
 * Requests the scheduler uses for a pod: the sum over app containers, or the largest
 * init container if that is bigger (init containers run one at a time, before the app).
 */
export function podRequests(containers: V1Container[], initContainers: V1Container[] = []) {
  const total = (resource: "cpu" | "memory") => {
    const values = (list: V1Container[]) => list.map((c) => parseQuantity(c.resources?.requests?.[resource]));
    const app = values(containers);
    const init = values(initContainers);
    if ([...app, ...init].every((v) => v === undefined)) return undefined;
    const sum = app.reduce<number>((a, v) => a + (v ?? 0), 0);
    return Math.max(sum, ...init.map((v) => v ?? 0));
  };
  return { cpu: total("cpu"), memory: total("memory") };
}

/** {app: "web", tier: "fe"} -> "app=web,tier=fe", as used in label selectors. */
export function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** An endpoint without a "ready" condition counts as ready (API convention). */
export function isEndpointReady(e: V1Endpoint): boolean {
  return e.conditions?.ready !== false;
}

/** Sort comparator for events (or anything with `lastSeen`): newest first. */
export function byNewest(a: { lastSeen?: string }, b: { lastSeen?: string }): number {
  return (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
}

/**
 * The Deployment that owns a ReplicaSet. A ReplicaSet is named
 * "<deployment>-<pod-template-hash>"; pass the hash when known (from the pod's
 * pod-template-hash label), otherwise the suffix is recognized by its shape.
 */
export function deploymentOfReplicaSet(replicaSet: string, hash?: string): string {
  if (hash) return replicaSet.endsWith(`-${hash}`) ? replicaSet.slice(0, -hash.length - 1) : replicaSet;
  return /^(.+)-[a-z0-9]{6,10}$/.exec(replicaSet)?.[1] ?? replicaSet;
}

/** The workload a pod belongs to: the Deployment of its ReplicaSet, else its owner. */
export function podWorkload(pod: V1Pod): string | undefined {
  const owner = pod.metadata?.ownerReferences?.find((o) => o.controller) ?? pod.metadata?.ownerReferences?.[0];
  // Static pods are "owned" by their Node, which is not a workload: pods on one node are unrelated.
  if (!owner || owner.kind === "Node") return undefined;
  if (owner.kind !== "ReplicaSet") return owner.name;
  const hash = pod.metadata?.labels?.["pod-template-hash"];
  return hash ? deploymentOfReplicaSet(owner.name, hash) : owner.name;
}

export function summarizePod(pod: V1Pod): PodSummary {
  const status = pod.status ?? {};
  const containers = [
    ...(status.initContainerStatuses ?? []).map((c) => summarizeContainer(c, true)),
    ...(status.containerStatuses ?? []).map((c) => summarizeContainer(c, false)),
  ];
  const appContainers = containers.filter((c) => !c.init);
  const scheduled = status.conditions?.find((c) => c.type === "PodScheduled");
  const owner = pod.metadata?.ownerReferences?.[0];
  return {
    namespace: pod.metadata?.namespace ?? "default",
    name: pod.metadata?.name ?? "<unknown>",
    phase: status.phase ?? "Unknown",
    reason: status.reason,
    message: status.message,
    nodeName: pod.spec?.nodeName,
    owner: owner ? { kind: owner.kind, name: owner.name } : undefined,
    workload: podWorkload(pod),
    createdAt: toIso(pod.metadata?.creationTimestamp),
    readyContainers: appContainers.filter((c) => c.ready).length,
    // Containers that have not started yet have no status, so fall back to the spec.
    totalContainers: Math.max(appContainers.length, pod.spec?.containers.length ?? 0),
    restarts: containers.reduce((sum, c) => sum + c.restarts, 0),
    containers,
    requests: podRequests(pod.spec?.containers ?? [], pod.spec?.initContainers ?? []),
    unschedulable: scheduled?.status === "False" ? { reason: scheduled.reason, message: scheduled.message } : undefined,
    claims: claimsOf(pod),
  };
}

/** PersistentVolumeClaims a pod mounts; undefined when none. */
function claimsOf(pod: V1Pod): string[] | undefined {
  const claims = (pod.spec?.volumes ?? []).flatMap((v) =>
    v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : [],
  );
  return claims.length > 0 ? claims : undefined;
}

export function summarizeJob(job: V1Job): JobSummary {
  const conditions = job.status?.conditions ?? [];
  const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
  const owner = job.metadata?.ownerReferences?.find((o) => o.kind === "CronJob");
  return {
    namespace: job.metadata?.namespace ?? "default",
    name: job.metadata?.name ?? "<unknown>",
    cronJob: owner?.name,
    createdAt: toIso(job.metadata?.creationTimestamp),
    completionTime: toIso(job.status?.completionTime),
    active: job.status?.active ?? 0,
    succeeded: job.status?.succeeded ?? 0,
    failed: job.status?.failed ?? 0,
    complete: conditions.some((c) => c.type === "Complete" && c.status === "True"),
    failedCondition: failed
      ? { reason: failed.reason, message: failed.message, since: toIso(failed.lastTransitionTime) }
      : undefined,
    backoffLimit: job.spec?.backoffLimit,
  };
}

export function summarizeCronJob(cj: V1CronJob): CronJobSummary {
  return {
    namespace: cj.metadata?.namespace ?? "default",
    name: cj.metadata?.name ?? "<unknown>",
    schedule: cj.spec?.schedule ?? "?",
    suspended: cj.spec?.suspend === true,
    lastScheduleTime: toIso(cj.status?.lastScheduleTime),
    lastSuccessfulTime: toIso(cj.status?.lastSuccessfulTime),
    active: cj.status?.active?.length ?? 0,
  };
}

const DEFAULT_CLASS_ANNOTATION = "storageclass.kubernetes.io/is-default-class";

/**
 * Summarizes a PVC. With `classes` (the cluster's StorageClasses), also says whether its
 * class binds on first use and whether it can be provisioned at all; without them (not
 * visible), those fields stay undefined rather than guessing.
 */
export function summarizePvc(pvc: V1PersistentVolumeClaim, classes?: V1StorageClass[]): PvcSummary {
  const requested = pvc.spec?.storageClassName;
  const summary: PvcSummary = {
    namespace: pvc.metadata?.namespace ?? "default",
    name: pvc.metadata?.name ?? "<unknown>",
    phase: pvc.status?.phase ?? "Pending",
    storageClass: requested || undefined,
    createdAt: toIso(pvc.metadata?.creationTimestamp),
    requested: pvc.spec?.resources?.requests?.["storage"],
    volumeName: pvc.spec?.volumeName,
  };
  if (!classes || summary.phase !== "Pending") return summary;
  if (requested === "") {
    // An explicit "" means static binding: only a pre-created PersistentVolume can satisfy it.
    if (!summary.volumeName) summary.storageClassProblem = 'storageClassName is "" (no dynamic provisioning)';
    return summary;
  }
  const cls =
    requested !== undefined
      ? classes.find((c) => c.metadata?.name === requested)
      : classes.find((c) => c.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === "true");
  if (!cls) {
    summary.storageClassProblem =
      requested !== undefined
        ? `StorageClass "${requested}" does not exist (existing: ${classes.map((c) => c.metadata?.name).join(", ") || "none"})`
        : "no storageClassName and no default StorageClass";
    return summary;
  }
  summary.waitForFirstConsumer = cls.volumeBindingMode === "WaitForFirstConsumer";
  return summary;
}

/** Summarizes an APIService backed by a Service; undefined for local (built-in) ones. */
export function summarizeApiService(a: V1APIService): ApiServiceSummary | undefined {
  const svc = a.spec?.service;
  if (!svc) return undefined;
  const available = a.status?.conditions?.find((c) => c.type === "Available");
  return {
    name: a.metadata?.name ?? "<unknown>",
    service: { namespace: svc.namespace ?? "default", name: svc.name ?? "?" },
    available: available?.status === "True",
    reason: available?.reason,
    message: available?.message,
    since: toIso(available?.lastTransitionTime),
  };
}

/** Summarizes a namespace that is being deleted; undefined for one that is not. */
export function summarizeTerminatingNamespace(ns: V1Namespace): TerminatingNamespace | undefined {
  if (ns.status?.phase !== "Terminating") return undefined;
  return {
    name: ns.metadata?.name ?? "<unknown>",
    deletionTimestamp: toIso(ns.metadata?.deletionTimestamp),
    conditions: (ns.status.conditions ?? [])
      .filter((c) => c.status === "True")
      .map((c) => ({ type: c.type, reason: c.reason, message: c.message })),
    finalizers: ns.spec?.finalizers ?? [],
  };
}

export function summarizeLeaderLease(component: string, lease: V1Lease): LeaderLease {
  return {
    component,
    holder: lease.spec?.holderIdentity || undefined,
    renewTime: toIso(lease.spec?.renewTime),
    leaseDurationSeconds: lease.spec?.leaseDurationSeconds,
  };
}

export function summarizeDeployment(d: V1Deployment): DeploymentSummary {
  return {
    namespace: d.metadata?.namespace ?? "default",
    name: d.metadata?.name ?? "<unknown>",
    desired: d.spec?.replicas ?? 1,
    ready: d.status?.readyReplicas ?? 0,
    available: d.status?.availableReplicas ?? 0,
    updated: d.status?.updatedReplicas ?? 0,
    conditions: (d.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
  };
}

export function summarizeDaemonSet(d: V1DaemonSet): WorkloadSummary {
  return {
    kind: "DaemonSet",
    namespace: d.metadata?.namespace ?? "default",
    name: d.metadata?.name ?? "<unknown>",
    desired: d.status?.desiredNumberScheduled ?? 0,
    ready: d.status?.numberReady ?? 0,
    updated: d.status?.updatedNumberScheduled ?? 0,
  };
}

export function summarizeStatefulSet(s: V1StatefulSet): WorkloadSummary {
  return {
    kind: "StatefulSet",
    namespace: s.metadata?.namespace ?? "default",
    name: s.metadata?.name ?? "<unknown>",
    desired: s.spec?.replicas ?? 1,
    ready: s.status?.readyReplicas ?? 0,
    updated: s.status?.updatedReplicas ?? 0,
    currentRevision: s.status?.currentRevision,
    updateRevision: s.status?.updateRevision,
  };
}

/**
 * Summarizes a Service with its endpoints and the pods its selector matches. `slices` and
 * `pods` may cover more than the Service's namespace; only matching ones are used.
 * Returns undefined for Services without a selector (their endpoints are managed by hand)
 * and ExternalName Services.
 */
export function summarizeService(svc: V1Service, slices: V1EndpointSlice[], pods: V1Pod[]): ServiceSummary | undefined {
  const namespace = svc.metadata?.namespace ?? "default";
  const name = svc.metadata?.name ?? "<unknown>";
  const selector = svc.spec?.selector ?? {};
  if (Object.keys(selector).length === 0 || svc.spec?.type === "ExternalName") return undefined;

  const endpoints = slices
    .filter((s) => s.metadata?.namespace === namespace && s.metadata?.labels?.["kubernetes.io/service-name"] === name)
    .flatMap((s) => s.endpoints ?? []);
  const ready = endpoints.filter(isEndpointReady).length;

  const live = pods.filter(
    (p) => p.metadata?.namespace === namespace && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed",
  );
  const matching = live.filter((p) => Object.entries(selector).every(([k, v]) => p.metadata?.labels?.[k] === v));
  const podLabelValues = Object.fromEntries(
    Object.keys(selector).map((k) => [
      k,
      [...new Set(live.map((p) => p.metadata?.labels?.[k]).filter((v): v is string => v !== undefined))]
        .sort()
        .slice(0, 10),
    ]),
  );

  return {
    namespace,
    name,
    type: svc.spec?.type ?? "ClusterIP",
    selector,
    readyEndpoints: ready,
    notReadyEndpoints: endpoints.length - ready,
    pods: matching.map((p) => {
      const s = summarizePod(p);
      const stuck = s.containers.find((c) => c.reason && c.state !== "running");
      return {
        name: s.name,
        ready: s.phase === "Running" && s.readyContainers === s.totalContainers,
        phase: s.phase,
        reason: stuck?.reason,
        createdAt: s.createdAt,
        workload: s.workload,
      };
    }),
    podLabelValues,
  };
}

/** Best-effort "last seen" time; different event sources fill different fields. */
export function eventLastSeen(e: CoreV1Event): string | undefined {
  return toIso(e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp);
}

export function summarizeEvent(e: CoreV1Event): EventSummary {
  return {
    // Events about Nodes live in "default", but the Node itself has no namespace.
    namespace: e.involvedObject.namespace || undefined,
    involvedKind: e.involvedObject.kind,
    involvedName: e.involvedObject.name,
    reason: e.reason,
    message: e.message,
    count: e.series?.count ?? e.count ?? 1,
    lastSeen: eventLastSeen(e),
  };
}
