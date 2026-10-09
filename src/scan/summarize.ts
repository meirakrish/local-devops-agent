import type {
  CoreV1Event,
  V1ContainerStatus,
  V1Deployment,
  V1Node,
  V1Pod,
} from "@kubernetes/client-node";
import type {
  ContainerSummary,
  DeploymentSummary,
  EventSummary,
  NodeSummary,
  PodSummary,
} from "./types.js";

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
    pressures: conditions
      .filter((c) => PRESSURE_CONDITIONS.includes(c.type) && c.status === "True")
      .map((c) => c.type),
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
    createdAt: toIso(pod.metadata?.creationTimestamp),
    readyContainers: appContainers.filter((c) => c.ready).length,
    // Containers that have not started yet have no status, so fall back to the spec.
    totalContainers: Math.max(appContainers.length, pod.spec?.containers.length ?? 0),
    restarts: containers.reduce((sum, c) => sum + c.restarts, 0),
    containers,
    unschedulable:
      scheduled?.status === "False"
        ? { reason: scheduled.reason, message: scheduled.message }
        : undefined,
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

/** Best-effort "last seen" time; different event sources fill different fields. */
export function eventLastSeen(e: CoreV1Event): string | undefined {
  return toIso(
    e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp,
  );
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
