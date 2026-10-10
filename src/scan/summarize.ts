import type {
  CoreV1Event,
  V1Container,
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
  ContainerSummary,
  DeploymentSummary,
  EventSummary,
  NodeSummary,
  PodSummary,
  ServiceSummary,
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
  if (!owner) return undefined;
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
