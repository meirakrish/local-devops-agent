import type { V1Container, V1LabelSelector } from "@kubernetes/client-node";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { K8sClients } from "../k8s/client.js";
import { isNotFound, k8sErrorMessage } from "../k8s/errors.js";
import {
  byNewest,
  formatLabels,
  summarizeDaemonSet,
  summarizeDeployment,
  summarizeEvent,
  summarizeNode,
  summarizePod,
  summarizeService,
  summarizeStatefulSet,
} from "../scan/summarize.js";
import { addNodeUsage, collectControlPlane, collectWebhooks } from "../scan/collect-cluster.js";
import { formatBytes } from "../scan/quantity.js";
import type { EventSummary, PodSummary } from "../scan/types.js";
import { describePodText, eventLine, nodeLine, podLine } from "./format.js";
import { truncateMiddle } from "./truncate.js";

/**
 * The agent's tools. All are read-only: they only receive the read-only client.
 * Outputs are compact text (cheaper than JSON for a small model) and truncated.
 * Errors are returned as text so the model can correct itself instead of crashing.
 */

const HEALTH_SECTIONS = ["control-plane", "etcd", "webhooks", "all"] as const;
type HealthSection = (typeof HEALTH_SECTIONS)[number];
const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet"] as const;
type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export interface ToolOptions {
  maxChars: number;
  /** Window for "recent" control-plane restarts and probe failures (EVENT_WINDOW_MINUTES). */
  windowMinutes: number;
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

function isProblemPod(p: PodSummary): boolean {
  if (p.phase === "Succeeded") return false;
  return p.phase !== "Running" || p.readyContainers < p.totalContainers || p.restarts > 0;
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
    if (!isNotFound(err)) return undefined;
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
function safe<A extends object>(k8s: K8sClients, maxChars: number, fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<string> => {
    try {
      return truncateMiddle(await fn(args), maxChars);
    } catch (err) {
      if (isNotFound(err)) {
        const target = args as { namespace?: string; name?: string; pod?: string };
        const hint = target.namespace ? await missingNamespaceHint(k8s, target.namespace) : undefined;
        if (hint) return `Error: ${hint}`;
        const what = target.name ?? target.pod;
        return `Error: ${what ? `"${what}" ` : ""}not found${target.namespace ? ` in namespace "${target.namespace}"` : ""}. Check the exact name with a list tool.`;
      }
      return `Error: ${k8sErrorMessage(err)}`;
    }
  };
}

/**
 * Builds the eight read-only tools the investigate loop may call. Each tool returns text,
 * truncated to `opts.maxChars`; API errors come back as "Error: ..." text, not exceptions.
 */
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
      .sort(byNewest)
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
          .sort(byNewest)
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

  /** Warning events of a workload's controller; for a Deployment, also of its ReplicaSets. */
  async function controllerEvents(kind: WorkloadKind, namespace: string, name: string): Promise<EventSummary[]> {
    const list = await k8s.core.listNamespacedEvent({ namespace, fieldSelector: "type=Warning" });
    return list.items
      .map(summarizeEvent)
      .filter(
        (e) =>
          (e.involvedKind === kind && e.involvedName === name) ||
          (kind === "Deployment" && e.involvedKind === "ReplicaSet" && (e.involvedName ?? "").startsWith(`${name}-`)),
      )
      .sort(byNewest)
      .slice(0, 10);
  }

  async function podsOf(namespace: string, selector: V1LabelSelector | undefined): Promise<string[]> {
    const matchLabels = selector?.matchLabels;
    if (!matchLabels) return [];
    const labelSelector = formatLabels(matchLabels);
    const pods = (await k8s.core.listNamespacedPod({ namespace, labelSelector })).items.map(summarizePod);
    return ["Pods:", ...(pods.length > 0 ? pods.map((p) => `- ${podLine(p)}`) : ["- (none)"])];
  }

  const getWorkload = tool(
    safe(k8s, opts.maxChars, async ({ kind = "Deployment", namespace, name }: { kind?: WorkloadKind; namespace: string; name: string }) => {
      const images = (containers: V1Container[] | undefined) =>
        `Images: ${(containers ?? []).map((c) => `${c.name}=${c.image}`).join(", ")}`;
      const lines: string[] = [];
      let selector: V1LabelSelector | undefined;
      if (kind === "Deployment") {
        const d = await k8s.apps.readNamespacedDeployment({ namespace, name });
        const s = summarizeDeployment(d);
        selector = d.spec?.selector;
        lines.push(
          `Deployment ${s.namespace}/${s.name}`,
          `Replicas: desired=${s.desired} ready=${s.ready} available=${s.available} updated=${s.updated}`,
          `Strategy: ${d.spec?.strategy?.type ?? "RollingUpdate"}  Generation: ${d.metadata?.generation ?? "?"} observed=${d.status?.observedGeneration ?? "?"}`,
          images(d.spec?.template.spec?.containers),
          "Conditions:",
          ...s.conditions.map((c) => `- ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`),
        );
      } else if (kind === "StatefulSet") {
        const st = await k8s.apps.readNamespacedStatefulSet({ namespace, name });
        const s = summarizeStatefulSet(st);
        selector = st.spec?.selector;
        lines.push(
          `StatefulSet ${s.namespace}/${s.name}`,
          `Replicas: desired=${s.desired} ready=${s.ready} updated=${s.updated}`,
          `Revisions: current=${s.currentRevision ?? "?"} update=${s.updateRevision ?? "?"}  Pod management: ${st.spec?.podManagementPolicy ?? "OrderedReady"}`,
          images(st.spec?.template.spec?.containers),
          `Volume claim templates: ${(st.spec?.volumeClaimTemplates ?? []).map((v) => v.metadata?.name).join(", ") || "(none)"}`,
        );
      } else {
        const ds = await k8s.apps.readNamespacedDaemonSet({ namespace, name });
        const s = summarizeDaemonSet(ds);
        selector = ds.spec?.selector;
        lines.push(
          `DaemonSet ${s.namespace}/${s.name}`,
          `Pods: desired=${s.desired} current=${ds.status?.currentNumberScheduled ?? 0} ready=${s.ready} updated=${s.updated} available=${ds.status?.numberAvailable ?? 0} misscheduled=${ds.status?.numberMisscheduled ?? 0}`,
          images(ds.spec?.template.spec?.containers),
          `NodeSelector: ${JSON.stringify(ds.spec?.template.spec?.nodeSelector ?? {})}  Tolerations: ${(ds.spec?.template.spec?.tolerations ?? []).map((t) => t.key ?? (t.operator === "Exists" ? "<all>" : "?")).join(", ") || "(none)"}`,
        );
      }
      lines.push(...(await podsOf(namespace, selector)));
      const events = await controllerEvents(kind, namespace, name);
      if (events.length > 0) lines.push("Controller warning events (newest first):", ...events.map(eventLine));
      return lines.join("\n");
    }),
    {
      name: "k8s_get_workload",
      description:
        "Get a Deployment, StatefulSet or DaemonSet: desired vs ready pods, rollout status, images, its pods with their nodes, and its controller's warning events (e.g. FailedCreate when the API server rejects its pods).",
      schema: z.object({
        kind: z.enum(WORKLOAD_KINDS).optional().describe('Workload kind (default "Deployment")'),
        namespace: namespaceField,
        name: k8sName("workload name"),
      }),
    },
  );

  const getService = tool(
    safe(k8s, opts.maxChars, async ({ namespace, name }: { namespace: string; name: string }) => {
      const svc = await k8s.core.readNamespacedService({ namespace, name });
      const [slices, pods] = await Promise.all([
        k8s.discovery.listNamespacedEndpointSlice({ namespace, labelSelector: `kubernetes.io/service-name=${name}` }),
        k8s.core.listNamespacedPod({ namespace }),
      ]);
      const ports = (svc.spec?.ports ?? []).map((p) => `${p.name ? `${p.name}:` : ""}${p.port}->${p.targetPort ?? p.port}/${p.protocol ?? "TCP"}`);
      const lines = [
        `Service ${namespace}/${name} type=${svc.spec?.type ?? "ClusterIP"} clusterIP=${svc.spec?.clusterIP ?? "?"}`,
        `Ports: ${ports.join(", ") || "(none)"}`,
      ];
      const endpoints = slices.items.flatMap((s) => s.endpoints ?? []);
      const endpointLines = endpoints
        .slice(0, 20)
        .map((e) => `- ${e.targetRef?.name ?? e.addresses.join(",")} ${e.conditions?.ready === false ? "NOT READY" : "ready"}`);

      const s = summarizeService(svc, slices.items, pods.items);
      if (!s) {
        lines.push("No selector: endpoints are managed manually (or this is an ExternalName Service).", `Endpoints: ${endpoints.length}`, ...endpointLines);
        return lines.join("\n");
      }
      lines.push(
        `Selector: ${formatLabels(s.selector)}`,
        `Endpoints: ${s.readyEndpoints} ready, ${s.notReadyEndpoints} not ready`,
        ...endpointLines,
      );
      const matching = pods.items.filter((p) => s.pods.some((m) => m.name === p.metadata?.name));
      if (matching.length === 0) {
        lines.push(
          "Pods matching the selector: (none)",
          `Label values on running pods in ${namespace}: ${Object.entries(s.podLabelValues).map(([k, vs]) => `${k}: ${vs.join(", ") || "(no pod has this label)"}`).join("; ")}`,
        );
        return lines.join("\n");
      }
      lines.push("Pods matching the selector:", ...matching.map((p) => `- ${podLine(summarizePod(p))}`));
      // A targetPort the pods do not declare is a common cause of refused connections.
      const declared = matching[0]!.spec?.containers.flatMap((c) => c.ports ?? []) ?? [];
      if (declared.length > 0) {
        lines.push(`Container ports (first pod): ${declared.map((p) => `${p.containerPort}${p.name ? `(${p.name})` : ""}`).join(", ")}`);
        for (const p of svc.spec?.ports ?? []) {
          const target = p.targetPort ?? p.port;
          const found = declared.some((d) => d.containerPort === target || d.name === target);
          if (!found) lines.push(`Note: targetPort ${target} of port ${p.port} is not a declared container port`);
        }
      }
      return lines.join("\n");
    }),
    {
      name: "k8s_get_service",
      description:
        "Get a Service: type, ports, selector, ready and not-ready endpoints, the pods its selector matches and their status. If no pod matches, shows the label values pods in the namespace actually have.",
      schema: z.object({
        namespace: namespaceField,
        name: k8sName("service name"),
      }),
    },
  );

  const clusterHealth = tool(
    safe(k8s, opts.maxChars, async ({ section = "all" }: { section?: HealthSection }) => {
      const want = (s: HealthSection) => section === "all" || section === s;
      const problems: string[] = [];
      const [cp, webhooks] = await Promise.all([
        collectControlPlane(k8s, opts.windowMinutes),
        want("webhooks")
          ? collectWebhooks(k8s).catch((err: unknown) => {
              problems.push(`admission webhooks: ${k8sErrorMessage(err)}`);
              return [];
            })
          : Promise.resolve([]),
      ]);

      const lines: string[] = [];
      if (want("control-plane")) {
        lines.push(`API server version: ${cp.serverVersion ?? "unknown"}`);
        if (cp.certificate) lines.push(`API server certificate: ${cp.certificate.subject}, valid until ${cp.certificate.notAfter}`);
        if (cp.readyz) {
          const failing = cp.readyz.filter((c) => !c.ok);
          lines.push(
            `Readiness checks (/readyz): ${cp.readyz.length - failing.length}/${cp.readyz.length} passing`,
            ...failing.map((c) => `- FAILING ${c.name}${c.reason ? `: ${c.reason}` : ""}`),
          );
        }
        if (cp.pods) {
          lines.push(`Control-plane pods (restarts and probe failures within the last ${opts.windowMinutes} min):`);
          for (const p of cp.pods) {
            const parts = [`- ${p.component} (${p.name})`, p.ready ? "ready" : `NOT READY${p.stateReason ? ` (${p.stateReason})` : ""}`, `restarts=${p.restarts}`];
            if (p.lastRestart) {
              parts.push(`last restart ${p.lastRestart.finishedAt}${p.lastRestart.reason ? ` ${p.lastRestart.reason}` : ""}${p.lastRestart.exitCode !== undefined ? ` exit ${p.lastRestart.exitCode}` : ""}`);
            }
            if (p.probeFailures) {
              parts.push(`probe failures (up to)=${p.probeFailures.count} last ${p.probeFailures.lastSeen}: ${p.probeFailures.lastMessage}`);
            }
            lines.push(parts.join(" "));
          }
        }
      }
      if (want("etcd")) {
        const etcdCheck = cp.readyz?.find((c) => c.name === "etcd");
        if (etcdCheck) lines.push(`etcd health check (/readyz): ${etcdCheck.ok ? "ok" : `FAILING${etcdCheck.reason ? `: ${etcdCheck.reason}` : ""}`}`);
        if (cp.etcd) {
          const size = cp.etcd.dbSizeBytes;
          lines.push(
            `etcd database: ${size !== undefined ? `${formatBytes(size)} of ${formatBytes(cp.etcd.quotaBytes)} quota (${Math.round((size / cp.etcd.quotaBytes) * 100)}%)` : "size not exposed"}${cp.etcd.quotaSource === "default" ? ", default quota assumed" : ""}`,
            `etcd largest object counts: ${cp.etcd.objectCounts.slice(0, 8).map((o) => `${o.resource}=${o.count}`).join(", ") || "unknown"}`,
          );
        }
      }
      if (want("webhooks")) {
        lines.push(`Admission webhooks: ${webhooks.length}`);
        for (const w of webhooks) {
          lines.push(`- ${w.kind} ${w.configName}/${w.name} failurePolicy=${w.failurePolicy} status=${w.status}${w.detail ? ` (${w.detail})` : ""}`);
        }
      }
      for (const n of [...cp.notVisible, ...problems]) lines.push(`Not visible: ${n}`);
      return lines.join("\n");
    }),
    {
      name: "k8s_cluster_health",
      description:
        "Cluster health by section. control-plane: API server version, certificate expiry, /readyz checks, and control-plane pods (kube-apiserver, etcd, scheduler, controller-manager) with recent restarts and probe failures. etcd: etcd health check, database size vs quota, largest object counts. webhooks: admission webhooks and whether their service can answer.",
      schema: z.object({
        section: z
          .enum(HEALTH_SECTIONS)
          .optional()
          .describe('Which part to show; use the section named in the problem description (default "all")'),
      }),
    },
  );

  return [listNodes, listPods, describePod, getLogs, listEvents, getWorkload, getService, clusterHealth];
}
