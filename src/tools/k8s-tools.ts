import type { V1Container, V1Pod } from "@kubernetes/client-node";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { K8sClients } from "../k8s/client.js";
import { k8sErrorMessage } from "../k8s/errors.js";
import {
  summarizeDeployment,
  summarizeEvent,
  summarizeNode,
  summarizePod,
} from "../scan/summarize.js";
import { addNodeUsage, collectControlPlane, collectWebhooks } from "../scan/collect-cluster.js";
import { formatCpu, formatMemory, parseQuantity } from "../scan/quantity.js";
import type { EventSummary, NodeSummary, PodSummary } from "../scan/types.js";
import { truncateMiddle } from "./truncate.js";

/**
 * The agent's tools. All are read-only: they only receive the read-only client.
 * Outputs are compact text (cheaper than JSON for a small model) and truncated.
 * Errors are returned as text so the model can correct itself instead of crashing.
 */

export interface ToolOptions {
  maxChars: number;
  defaultTailLines?: number;
  maxListItems?: number;
}

const MAX_TAIL_LINES = 200;

// Kubernetes names are lowercase DNS names. A strict pattern turns a common small-model
// mistake ("agent-test/web" in the name field) into a clear error the model can fix.
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const k8sName = (what: string) =>
  z
    .string()
    .regex(NAME_PATTERN, `${what} must be a bare Kubernetes name such as "web-7db8d69f68-4f2n7", without a "namespace/" prefix`)
    .describe(`Exact ${what}`);
const namespaceField = z
  .string()
  .regex(NAME_PATTERN, 'namespace must be a bare namespace name such as "default"')
  .describe("Namespace");

function podLine(p: PodSummary): string {
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

function nodeLine(n: NodeSummary, now: Date): string {
  const usage = (used: number, total: string | undefined, fmt: (v: number) => string) => {
    const t = parseQuantity(total);
    return t ? `${fmt(used)}/${fmt(t)} (${Math.round((used / t) * 100)}%)` : `${fmt(used)}/?`;
  };
  return [
    n.name,
    n.ready ? "Ready" : `NotReady${n.readyMessage ? ` (${n.readyMessage})` : ""}`,
    `roles=${n.roles.join(",")}`,
    `kubelet=${n.kubeletVersion ?? "?"}`,
    n.heartbeat ? `heartbeat=${Math.round((now.getTime() - Date.parse(n.heartbeat)) / 1000)}s ago` : "heartbeat=unknown",
    `pressure=${n.pressures.join(",") || "none"}`,
    n.unschedulable ? "cordoned" : "",
    n.requested
      ? `requested cpu=${usage(n.requested.cpu, n.allocatable.cpu, formatCpu)} memory=${usage(n.requested.memory, n.allocatable.memory, formatMemory)} pods=${usage(n.requested.pods, n.allocatable.pods, String)}`
      : `allocatable(cpu=${n.allocatable.cpu ?? "?"},memory=${n.allocatable.memory ?? "?"},pods=${n.allocatable.pods ?? "?"})`,
  ]
    .filter(Boolean)
    .join(" ");
}

function eventLine(e: EventSummary): string {
  const obj = `${e.involvedKind ?? "?"}/${e.involvedName ?? "?"}`;
  return `- ${e.lastSeen ?? "?"} ${obj} ${e.reason ?? ""} (x${e.count}): ${e.message ?? ""}`.trim();
}

function isProblemPod(p: PodSummary): boolean {
  if (p.phase === "Succeeded") return false;
  return p.phase !== "Running" || p.readyContainers < p.totalContainers || p.restarts > 0;
}

function formatResources(c: V1Container): string | undefined {
  const r = c.resources;
  if (!r?.requests && !r?.limits) return undefined;
  const fmt = (m?: Record<string, string>) =>
    m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(",") : "none";
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

export function describePodText(pod: V1Pod, events: EventSummary[]): string {
  const s = summarizePod(pod);
  const lines = [
    `Pod ${s.namespace}/${s.name}`,
    `Phase: ${s.phase}${s.reason ? ` (${s.reason})` : ""}  Node: ${s.nodeName ?? "<none>"}  Owner: ${s.owner ? `${s.owner.kind}/${s.owner.name}` : "<none>"}`,
  ];
  if (s.message) lines.push(`Message: ${s.message}`);
  const conds = (pod.status?.conditions ?? []).map(
    (c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.status === "False" && c.message ? `: ${c.message}` : ""}`,
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
    lines.push(`- ${init ? "[init] " : ""}${c.name} image=${c.image ?? "?"} ready=${st?.ready ?? false} restarts=${st?.restarts ?? 0}`);
    if (st) {
      lines.push(`  state: ${st.state}${st.reason ? ` ${st.reason}` : ""}${st.exitCode !== undefined ? ` exitCode=${st.exitCode}` : ""}${st.message ? `: ${st.message}` : ""}`);
      if (st.lastTerminationReason) {
        lines.push(`  last termination: ${st.lastTerminationReason} exitCode=${st.lastExitCode ?? "?"}`);
      }
    }
    if (c.command || c.args) lines.push(`  command: ${[...(c.command ?? []), ...(c.args ?? [])].join(" ").replace(/\s+/g, " ").slice(0, 300)}`);
    const res = formatResources(c);
    if (res) lines.push(`  resources: ${res}`);
    lines.push(`  env: ${formatEnv(c)}`);
    for (const probe of ["liveness", "readiness", "startup"]) {
      const text = formatProbe(probe, c);
      if (text) lines.push(`  ${text}`);
    }
  }

  lines.push("Events (newest first):");
  if (events.length === 0) lines.push("- (none)");
  for (const e of events) lines.push(eventLine(e));
  return lines.join("\n");
}

/** The log text the kubelet returns when a run's logs are gone, or our own placeholders. */
function isUnavailableLog(text: string): boolean {
  return text === "(empty)" || text.startsWith("(no logs") || text.startsWith("unable to retrieve container logs");
}

/** Explains a missing namespace (and lists real ones) so the model can correct itself. */
async function missingNamespaceHint(k8s: K8sClients, namespace: string): Promise<string | undefined> {
  try {
    await k8s.core.readNamespace({ name: namespace });
    return undefined;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) return undefined;
    const names = (await k8s.core.listNamespace().catch(() => ({ items: [] }))).items
      .map((n) => n.metadata?.name)
      .filter(Boolean);
    return `namespace "${namespace}" does not exist. Existing namespaces: ${names.join(", ") || "(unknown)"}`;
  }
}

/**
 * Wraps a tool body: truncates the output and returns errors as text. A 404 also
 * checks whether the namespace exists, since a wrong namespace is the usual cause.
 */
function safe<A extends { namespace?: string; name?: string; pod?: string }>(
  k8s: K8sClients,
  maxChars: number,
  fn: (args: A) => Promise<string>,
) {
  return async (args: A): Promise<string> => {
    try {
      return truncateMiddle(await fn(args), maxChars);
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        const hint = args.namespace ? await missingNamespaceHint(k8s, args.namespace) : undefined;
        if (hint) return `Error: ${hint}`;
        const what = args.name ?? args.pod;
        return `Error: ${what ? `"${what}" ` : ""}not found${args.namespace ? ` in namespace "${args.namespace}"` : ""}. Check the exact name with a list tool.`;
      }
      return `Error: ${k8sErrorMessage(err)}`;
    }
  };
}

export function createK8sTools(k8s: K8sClients, opts: ToolOptions): StructuredToolInterface[] {
  const maxItems = opts.maxListItems ?? 60;
  const defaultTail = opts.defaultTailLines ?? 50;

  async function podEvents(namespace: string, name: string): Promise<EventSummary[]> {
    const list = await k8s.core.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${name}`,
    });
    return list.items
      .map(summarizeEvent)
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
      .slice(0, 15);
  }

  const listNodes = tool(
    safe(k8s, opts.maxChars, async () => {
      const nodes = (await k8s.core.listNode()).items.map(summarizeNode);
      const errors: string[] = [];
      await addNodeUsage(k8s, nodes, (await k8s.core.listPodForAllNamespaces()).items, errors);
      return [...nodes.map((n) => nodeLine(n, new Date())), ...errors.map((e) => `(${e})`)].join("\n");
    }),
    {
      name: "k8s_list_nodes",
      description:
        "List cluster nodes: Ready status, pressure conditions, kubelet version, seconds since the last kubelet heartbeat, and requested vs allocatable CPU, memory and pods.",
      schema: z.object({}),
    },
  );

  const listPods = tool(
    safe(k8s, opts.maxChars, async ({ namespace, onlyProblems }: { namespace?: string; onlyProblems?: boolean }) => {
      const list = namespace
        ? await k8s.core.listNamespacedPod({ namespace })
        : await k8s.core.listPodForAllNamespaces();
      let pods = list.items.map(summarizePod);
      if (onlyProblems) pods = pods.filter(isProblemPod);
      if (pods.length === 0) {
        const hint = namespace ? await missingNamespaceHint(k8s, namespace) : undefined;
        return hint ? `Error: ${hint}` : "No matching pods.";
      }
      const shown = pods.slice(0, maxItems).map(podLine);
      if (pods.length > maxItems) shown.push(`... and ${pods.length - maxItems} more`);
      return shown.join("\n");
    }),
    {
      name: "k8s_list_pods",
      description: "List pods with phase, ready containers, restart count and waiting reason.",
      schema: z.object({
        namespace: namespaceField.optional().describe("Namespace to list; omit for all namespaces"),
        onlyProblems: z
          .boolean()
          .optional()
          .describe("If true, only pods that are not Running+Ready or have restarts"),
      }),
    },
  );

  const describePod = tool(
    safe(k8s, opts.maxChars, async ({ namespace, name }: { namespace: string; name: string }) => {
      const pod = await k8s.core.readNamespacedPod({ namespace, name });
      return describePodText(pod, await podEvents(namespace, name));
    }),
    {
      name: "k8s_describe_pod",
      description:
        "Describe one pod: conditions, container states and last termination reason, image, resources, env var names, probes and the pod's recent events.",
      schema: z.object({
        namespace: namespaceField,
        name: k8sName("pod name"),
      }),
    },
  );

  const getLogs = tool(
    safe(
      k8s,
      opts.maxChars,
      async ({
        namespace,
        pod,
        container,
        tailLines,
        previous,
      }: {
        namespace: string;
        pod: string;
        container?: string;
        tailLines?: number;
        previous?: boolean;
      }) => {
        const p = await k8s.core.readNamespacedPod({ namespace, name: pod });
        const summary = summarizePod(p);
        const appContainers = summary.containers.filter((c) => !c.init);
        const notes: string[] = [];

        let target = container ? summary.containers.find((c) => c.name === container) : undefined;
        if (container && !target) {
          return `Error: container "${container}" not found. Containers: ${summary.containers.map((c) => c.name).join(", ")}`;
        }
        if (!target) {
          // Pick the container most likely to explain a problem.
          target =
            appContainers.find((c) => c.restarts > 0 || (!c.ready && c.state !== "running")) ??
            appContainers[0] ??
            summary.containers[0];
          if (summary.containers.length > 1 && target) {
            notes.push(`(container not specified; showing "${target.name}" of ${summary.containers.map((c) => c.name).join(", ")})`);
          }
        }
        if (!target) return "Pod has no container statuses yet (it may not be scheduled).";

        const lines = Math.min(tailLines ?? defaultTail, MAX_TAIL_LINES);
        const read = async (prev: boolean) => {
          try {
            const text = await k8s.core.readNamespacedPodLog({
              namespace,
              name: pod,
              container: target.name,
              tailLines: lines,
              previous: prev,
            });
            return text.trim() === "" ? "(empty)" : text.trimEnd();
          } catch (err) {
            return `(no logs: ${k8sErrorMessage(err)})`;
          }
        };

        // For a restarted container the current run is often empty or just starting;
        // the crash is in the previous run. Include it unless the caller said otherwise.
        const wantPrevious = previous ?? target.restarts > 0;
        const sections = [...notes];
        let previousUnavailable = false;
        if (wantPrevious) {
          const text = await read(true);
          previousUnavailable = isUnavailableLog(text);
          sections.push(`=== previous run of ${target.name} (last ${lines} lines) ===`, text);
        }
        // Between restarts the crashed run is the *current* one (state: terminated) and the
        // run before it may already be garbage-collected, so fall back to the current run.
        if (previous !== true || previousUnavailable) {
          const exited =
            target.state === "terminated" ? `, already exited with code ${target.exitCode ?? "?"}` : "";
          const why = previous === true ? " (previous run's logs are not available)" : "";
          sections.push(`=== current run of ${target.name}${exited} (last ${lines} lines)${why} ===`, await read(false));
        }
        return sections.join("\n");
      },
    ),
    {
      name: "k8s_get_logs",
      description:
        "Get the last lines of a pod container's logs. If the container has restarted, the previous (crashed) run's logs are included automatically.",
      schema: z.object({
        namespace: namespaceField,
        pod: k8sName("pod name"),
        container: z.string().optional().describe("Container name; omit to pick the failing container"),
        tailLines: z.number().int().positive().optional().describe(`Number of lines (default ${defaultTail}, max ${MAX_TAIL_LINES})`),
        previous: z
          .boolean()
          .optional()
          .describe("true = only the previous run, false = only the current run; omit for automatic"),
      }),
    },
  );

  const listEvents = tool(
    safe(
      k8s,
      opts.maxChars,
      async ({ namespace, objectName, objectKind }: { namespace?: string; objectName?: string; objectKind?: string }) => {
        const selectors = ["type=Warning"];
        if (objectName) selectors.push(`involvedObject.name=${objectName}`);
        if (objectKind) selectors.push(`involvedObject.kind=${objectKind}`);
        const fieldSelector = selectors.join(",");
        const list = namespace
          ? await k8s.core.listNamespacedEvent({ namespace, fieldSelector })
          : await k8s.core.listEventForAllNamespaces({ fieldSelector });
        const events = list.items
          .map(summarizeEvent)
          .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
          .slice(0, maxItems);
        if (events.length > 0) return events.map(eventLine).join("\n");
        const hint = namespace ? await missingNamespaceHint(k8s, namespace) : undefined;
        return hint ? `Error: ${hint}` : "No warning events found.";
      },
    ),
    {
      name: "k8s_list_events",
      description: "List recent Warning events, newest first, optionally filtered by namespace and involved object.",
      schema: z.object({
        namespace: namespaceField.optional().describe("Namespace; omit for all namespaces"),
        objectName: k8sName("object name").optional().describe("Name of the involved object, e.g. a pod name"),
        objectKind: z.string().optional().describe("Kind of the involved object, e.g. Pod, Node, Deployment"),
      }),
    },
  );

  const getDeployment = tool(
    safe(k8s, opts.maxChars, async ({ namespace, name }: { namespace: string; name: string }) => {
      const d = await k8s.apps.readNamespacedDeployment({ namespace, name });
      const s = summarizeDeployment(d);
      const lines = [
        `Deployment ${s.namespace}/${s.name}`,
        `Replicas: desired=${s.desired} ready=${s.ready} available=${s.available} updated=${s.updated}`,
        `Strategy: ${d.spec?.strategy?.type ?? "RollingUpdate"}  Generation: ${d.metadata?.generation ?? "?"} observed=${d.status?.observedGeneration ?? "?"}`,
        `Images: ${(d.spec?.template.spec?.containers ?? []).map((c) => `${c.name}=${c.image}`).join(", ")}`,
        "Conditions:",
        ...s.conditions.map((c) => `- ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`),
      ];
      const matchLabels = d.spec?.selector.matchLabels;
      if (matchLabels) {
        const labelSelector = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`).join(",");
        const pods = (await k8s.core.listNamespacedPod({ namespace, labelSelector })).items.map(summarizePod);
        lines.push("Pods:", ...(pods.length > 0 ? pods.map((p) => `- ${podLine(p)}`) : ["- (none)"]));
      }
      return lines.join("\n");
    }),
    {
      name: "k8s_get_deployment",
      description: "Get a deployment's desired vs ready replicas, rollout conditions, images and the status of its pods.",
      schema: z.object({
        namespace: namespaceField,
        name: k8sName("deployment name"),
      }),
    },
  );

  const clusterHealth = tool(
    safe(k8s, opts.maxChars, async () => {
      const problems: string[] = [];
      const [cp, webhooks] = await Promise.all([
        collectControlPlane(k8s),
        collectWebhooks(k8s).catch((err: unknown) => {
          problems.push(`admission webhooks: ${k8sErrorMessage(err)}`);
          return [];
        }),
      ]);
      const lines = [`API server version: ${cp.serverVersion ?? "unknown"}`];
      if (cp.certificate) lines.push(`API server certificate: ${cp.certificate.subject}, valid until ${cp.certificate.notAfter}`);
      if (cp.readyz) {
        const failing = cp.readyz.filter((c) => !c.ok);
        lines.push(
          `Readiness checks (/readyz): ${cp.readyz.length - failing.length}/${cp.readyz.length} passing`,
          ...failing.map((c) => `- FAILING ${c.name}${c.reason ? `: ${c.reason}` : ""}`),
        );
      }
      if (cp.etcd) {
        const size = cp.etcd.dbSizeBytes;
        lines.push(
          `etcd database: ${size !== undefined ? `${formatMemory(size)} of ${formatMemory(cp.etcd.quotaBytes)} quota (${Math.round((size / cp.etcd.quotaBytes) * 100)}%)` : "size not exposed"}${cp.etcd.quotaSource === "default" ? ", default quota assumed" : ""}`,
          `etcd largest object counts: ${cp.etcd.objectCounts.slice(0, 8).map((o) => `${o.resource}=${o.count}`).join(", ") || "unknown"}`,
        );
      }
      lines.push(`Admission webhooks: ${webhooks.length}`);
      for (const w of webhooks) {
        lines.push(`- ${w.kind} ${w.configName}/${w.name} failurePolicy=${w.failurePolicy} status=${w.status}${w.detail ? ` (${w.detail})` : ""}`);
      }
      for (const n of [...cp.notVisible, ...problems]) lines.push(`Not visible: ${n}`);
      return lines.join("\n");
    }),
    {
      name: "k8s_cluster_health",
      description:
        "Control-plane health: API server version and certificate expiry, /readyz checks (including etcd), etcd database size vs quota and largest object counts, and admission webhooks with whether their service can answer.",
      schema: z.object({}),
    },
  );

  return [listNodes, listPods, describePod, getLogs, listEvents, getDeployment, clusterHealth];
}
