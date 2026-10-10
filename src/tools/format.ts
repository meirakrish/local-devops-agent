import type { V1Container, V1Pod } from "@kubernetes/client-node";
import { formatCpu, formatMemory, parseQuantity } from "../scan/quantity.js";
import { summarizePod } from "../scan/summarize.js";
import type { EventSummary, JobSummary, LeaderLease, NodeSummary, PodSummary, PvcSummary } from "../scan/types.js";

/**
 * Compact text renderings of cluster objects for tool output: one line per pod, node or
 * event, and a kubectl-describe-like block for a pod. Plain text is cheaper than JSON
 * for a small model.
 */

export function podLine(p: PodSummary): string {
  const problem = p.containers.find((c) => c.reason && c.state !== "running");
  const parts = [
    `${p.namespace}/${p.name}`,
    p.phase,
    `ready=${p.readyContainers}/${p.totalContainers}`,
    `restarts=${p.restarts}`,
  ];
  if (problem?.reason) parts.push(`reason=${problem.reason}`);
  if (p.reason) parts.push(`podReason=${p.reason}`);
  if (p.unschedulable) parts.push("unschedulable");
  if (p.nodeName) parts.push(`node=${p.nodeName}`);
  return parts.join(" ");
}

export function nodeLine(n: NodeSummary, now: Date): string {
  const usage = (used: number, total: string | undefined, fmt: (v: number) => string) => {
    const t = parseQuantity(total);
    return t ? `${fmt(used)}/${fmt(t)} (${Math.round((used / t) * 100)}%)` : `${fmt(used)}/?`;
  };
  return [
    n.name,
    n.ready ? "Ready" : `NotReady${n.readyMessage ? ` (${n.readyMessage})` : ""}`,
    `roles=${n.roles.join(",")}`,
    `kubelet=${n.kubeletVersion ?? "?"}`,
    n.heartbeat
      ? `heartbeat=${Math.round((now.getTime() - Date.parse(n.heartbeat)) / 1000)}s ago`
      : "heartbeat=unknown",
    `pressure=${n.pressures.join(",") || "none"}`,
    n.unschedulable ? "cordoned" : "",
    n.requested
      ? `requested cpu=${usage(n.requested.cpu, n.allocatable.cpu, formatCpu)} memory=${usage(n.requested.memory, n.allocatable.memory, formatMemory)} pods=${usage(n.requested.pods, n.allocatable.pods, String)}`
      : `allocatable(cpu=${n.allocatable.cpu ?? "?"},memory=${n.allocatable.memory ?? "?"},pods=${n.allocatable.pods ?? "?"})`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function eventLine(e: EventSummary): string {
  const obj = `${e.involvedKind ?? "?"}/${e.involvedName ?? "?"}`;
  return `- ${e.lastSeen ?? "?"} ${obj} ${e.reason ?? ""} (x${e.count}): ${e.message ?? ""}`.trim();
}

export function jobLine(j: JobSummary): string {
  const state = j.failedCondition
    ? `FAILED (${j.failedCondition.reason ?? "?"}${j.failedCondition.message ? `: ${j.failedCondition.message}` : ""})`
    : j.complete
      ? "Complete"
      : j.active > 0
        ? "Running"
        : "Pending";
  return `${state} active=${j.active} succeeded=${j.succeeded} failed=${j.failed} created=${j.createdAt ?? "?"}${j.completionTime ? ` completed=${j.completionTime}` : ""}`;
}

export function leaseLine(l: LeaderLease, now: Date): string {
  const age = l.renewTime ? `${Math.round((now.getTime() - Date.parse(l.renewTime)) / 1000)}s ago` : "never";
  return `${l.component}: holder=${l.holder ?? "(none)"} renewed ${age} (leaseDurationSeconds=${l.leaseDurationSeconds ?? "?"})`;
}

/** A PersistentVolumeClaim a pod mounts, as shown by k8s_describe_pod. */
export interface ClaimInfo {
  name: string;
  pvc?: PvcSummary;
  /** Warning events of a claim that is not Bound, newest first. */
  events?: EventSummary[];
  /** Why the claim could not be read, e.g. "does not exist". */
  error?: string;
}

function claimLines(c: ClaimInfo): string[] {
  if (!c.pvc) return [`- ${c.name}: ${c.error ?? "unknown"}`];
  const p = c.pvc;
  const lines = [
    `- ${c.name}: ${p.phase} storageClass=${p.storageClass ?? "(none)"}${p.requested ? ` size=${p.requested}` : ""}${p.volumeName ? ` volume=${p.volumeName}` : ""}${p.waitForFirstConsumer ? " (binds when first used)" : ""}`,
  ];
  if (p.storageClassProblem) lines.push(`  problem: ${p.storageClassProblem}`);
  for (const e of c.events ?? []) lines.push(`  ${eventLine(e)}`);
  return lines;
}

function formatResources(c: V1Container): string | undefined {
  const r = c.resources;
  if (!r?.requests && !r?.limits) return undefined;
  const fmt = (m?: Record<string, string>) =>
    m
      ? Object.entries(m)
          .map(([k, v]) => `${k}=${v}`)
          .join(",")
      : "none";
  return `requests(${fmt(r.requests)}) limits(${fmt(r.limits)})`;
}

/** Env var names and their source only; values may be secrets and are never shown. */
function formatEnv(c: V1Container): string | undefined {
  const names = (c.env ?? []).map((e) => {
    const from = e.valueFrom?.secretKeyRef
      ? ` (from secret ${e.valueFrom.secretKeyRef.name})`
      : e.valueFrom?.configMapKeyRef
        ? ` (from configmap ${e.valueFrom.configMapKeyRef.name})`
        : "";
    return `${e.name}${from}`;
  });
  for (const src of c.envFrom ?? []) {
    if (src.secretRef) names.push(`<all keys of secret ${src.secretRef.name}>`);
    if (src.configMapRef) names.push(`<all keys of configmap ${src.configMapRef.name}>`);
  }
  return names.length > 0 ? names.join(", ") : "(none)";
}

function formatProbe(name: string, c: V1Container): string | undefined {
  const p = name === "liveness" ? c.livenessProbe : name === "readiness" ? c.readinessProbe : c.startupProbe;
  if (!p) return undefined;
  const how = p.httpGet
    ? `http GET ${p.httpGet.path ?? "/"} port ${p.httpGet.port}`
    : p.tcpSocket
      ? `tcp port ${p.tcpSocket.port}`
      : p.exec
        ? `exec ${(p.exec.command ?? []).join(" ")}`
        : "other";
  return `${name}: ${how} (delay=${p.initialDelaySeconds ?? 0}s period=${p.periodSeconds ?? 10}s failureThreshold=${p.failureThreshold ?? 3})`;
}

export function describePodText(pod: V1Pod, events: EventSummary[], claims: ClaimInfo[] = []): string {
  const s = summarizePod(pod);
  const lines = [
    `Pod ${s.namespace}/${s.name}`,
    `Phase: ${s.phase}${s.reason ? ` (${s.reason})` : ""}  Node: ${s.nodeName ?? "<none>"}  Owner: ${s.owner ? `${s.owner.kind}/${s.owner.name}` : "<none>"}`,
  ];
  if (s.message) lines.push(`Message: ${s.message}`);
  const conds = (pod.status?.conditions ?? []).map(
    (c) =>
      `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.status === "False" && c.message ? `: ${c.message}` : ""}`,
  );
  if (conds.length > 0) lines.push(`Conditions: ${conds.join("; ")}`);
  if (pod.spec?.nodeSelector) lines.push(`NodeSelector: ${JSON.stringify(pod.spec.nodeSelector)}`);

  const specs = [
    ...(pod.spec?.initContainers ?? []).map((c) => ({ c, init: true })),
    ...(pod.spec?.containers ?? []).map((c) => ({ c, init: false })),
  ];
  lines.push("Containers:");
  for (const { c, init } of specs) {
    const st = s.containers.find((x) => x.name === c.name && x.init === init);
    lines.push(
      `- ${init ? "[init] " : ""}${c.name} image=${c.image ?? "?"} ready=${st?.ready ?? false} restarts=${st?.restarts ?? 0}`,
    );
    if (st) {
      lines.push(
        `  state: ${st.state}${st.reason ? ` ${st.reason}` : ""}${st.exitCode !== undefined ? ` exitCode=${st.exitCode}` : ""}${st.message ? `: ${st.message}` : ""}`,
      );
      if (st.lastTerminationReason) {
        lines.push(`  last termination: ${st.lastTerminationReason} exitCode=${st.lastExitCode ?? "?"}`);
      }
    }
    if (c.command || c.args)
      lines.push(
        `  command: ${[...(c.command ?? []), ...(c.args ?? [])].join(" ").replace(/\s+/g, " ").slice(0, 300)}`,
      );
    const res = formatResources(c);
    if (res) lines.push(`  resources: ${res}`);
    lines.push(`  env: ${formatEnv(c)}`);
    for (const probe of ["liveness", "readiness", "startup"]) {
      const text = formatProbe(probe, c);
      if (text) lines.push(`  ${text}`);
    }
  }

  if (claims.length > 0) lines.push("PersistentVolumeClaims:", ...claims.flatMap(claimLines));
  lines.push("Events (newest first):");
  if (events.length === 0) lines.push("- (none)");
  for (const e of events) lines.push(eventLine(e));
  return lines.join("\n");
}
