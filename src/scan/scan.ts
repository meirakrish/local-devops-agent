import type { K8sClients } from "../k8s/client.js";
import { k8sErrorMessage } from "../k8s/errors.js";
import { addNodeUsage, collectControlPlane, collectWebhooks } from "./collect-cluster.js";
import {
  summarizeDeployment,
  summarizeEvent,
  summarizeNode,
  summarizePod,
} from "./summarize.js";
import type { ClusterOverview, EventSummary } from "./types.js";

export interface ScanOptions {
  namespace?: string;
  eventWindowMinutes: number;
  maxEvents?: number;
  now?: Date;
}

/** Keeps warning events inside the time window, newest first. */
export function recentEvents(
  events: EventSummary[],
  now: Date,
  windowMinutes: number,
  max: number,
): EventSummary[] {
  const cutoff = now.getTime() - windowMinutes * 60_000;
  return events
    .filter((e) => !e.lastSeen || new Date(e.lastSeen).getTime() >= cutoff)
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
    .slice(0, max);
}

/**
 * Deterministic cluster overview (no LLM). Each API call is independent, so a
 * failure in one (e.g. no permission to list nodes) is recorded in `errors` and
 * the rest of the scan still runs.
 */
export async function scanCluster(k8s: K8sClients, opts: ScanOptions): Promise<ClusterOverview> {
  const now = opts.now ?? new Date();
  const ns = opts.namespace;
  const errors: string[] = [];

  if (ns) {
    // Fail fast on a typo'd namespace instead of reporting an empty, "healthy" cluster.
    try {
      await k8s.core.readNamespace({ name: ns });
    } catch (err) {
      throw new Error(`Cannot read namespace "${ns}": ${k8sErrorMessage(err)}`);
    }
  }

  const warningOnly = { fieldSelector: "type=Warning" };
  // Cluster-level checks (control plane, etcd, webhooks) run regardless of --namespace.
  const [nodes, namespaces, pods, deployments, events, controlPlane, webhooks] = await Promise.allSettled([
    k8s.core.listNode(),
    ns ? Promise.resolve({ items: [{ metadata: { name: ns } }] }) : k8s.core.listNamespace(),
    ns ? k8s.core.listNamespacedPod({ namespace: ns }) : k8s.core.listPodForAllNamespaces(),
    ns
      ? k8s.apps.listNamespacedDeployment({ namespace: ns })
      : k8s.apps.listDeploymentForAllNamespaces(),
    ns
      ? k8s.core.listNamespacedEvent({ namespace: ns, ...warningOnly })
      : k8s.core.listEventForAllNamespaces(warningOnly),
    collectControlPlane(k8s),
    collectWebhooks(k8s),
  ]);

  function items<T>(label: string, result: PromiseSettledResult<{ items: T[] }>): T[] {
    if (result.status === "fulfilled") return result.value.items;
    errors.push(`list ${label}: ${k8sErrorMessage(result.reason)}`);
    return [];
  }

  // Node usage needs the pods of every namespace, even when --namespace limits the scan.
  const nodeSummaries = items("nodes", nodes).map(summarizeNode);
  let allPods = items("pods", pods);
  if (ns) {
    try {
      allPods = (await k8s.core.listPodForAllNamespaces()).items;
    } catch (err) {
      errors.push(`list pods of all namespaces (node usage): ${k8sErrorMessage(err)}`);
      allPods = [];
    }
  }
  await addNodeUsage(k8s, nodeSummaries, allPods, errors);

  if (webhooks.status === "rejected") errors.push(`list admission webhooks: ${k8sErrorMessage(webhooks.reason)}`);

  return {
    context: k8s.context,
    scannedAt: now.toISOString(),
    namespaceFilter: ns,
    namespaces: items("namespaces", namespaces)
      .map((n) => n.metadata?.name ?? "")
      .filter(Boolean)
      .sort(),
    nodes: nodeSummaries,
    pods: items("pods", pods).map(summarizePod),
    deployments: items("deployments", deployments).map(summarizeDeployment),
    warningEvents: recentEvents(
      items("events", events).map(summarizeEvent),
      now,
      opts.eventWindowMinutes,
      opts.maxEvents ?? 50,
    ),
    controlPlane:
      controlPlane.status === "fulfilled"
        ? controlPlane.value
        : { notVisible: [`control plane: ${k8sErrorMessage(controlPlane.reason)}`] },
    webhooks: webhooks.status === "fulfilled" ? webhooks.value : [],
    errors,
  };
}
