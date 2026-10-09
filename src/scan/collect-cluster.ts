import type { V1Pod } from "@kubernetes/client-node";
import type { K8sClients } from "../k8s/client.js";
import { k8sErrorMessage } from "../k8s/errors.js";
import {
  ETCD_DEFAULT_QUOTA_BYTES,
  etcdQuotaFromArgs,
  etcdStorageFromMetrics,
  parseHealthChecks,
} from "./cluster.js";
import { podRequests } from "./summarize.js";
import type { ControlPlaneSummary, NodeSummary, WebhookSummary } from "./types.js";

/** Why a raw endpoint could not be read, phrased for the report. */
function rawProblem(status: number): string {
  if (status === 401 || status === 403) return "forbidden (the kubeconfig's user lacks permission)";
  if (status === 404) return "not available on this API server";
  return `HTTP ${status}`;
}

/**
 * API server version and certificate, readiness checks (which include etcd), and etcd
 * storage from /metrics. Anything that cannot be read goes to `notVisible`, so the report
 * says "not checked" instead of implying it is healthy (managed clusters hide etcd).
 */
export async function collectControlPlane(k8s: K8sClients): Promise<ControlPlaneSummary> {
  const notVisible: string[] = [];
  const [version, readyz, metrics, etcdPods] = await Promise.allSettled([
    k8s.raw.get("/version"),
    k8s.raw.get("/readyz?verbose"),
    k8s.raw.get("/metrics"),
    k8s.core.listNamespacedPod({ namespace: "kube-system", labelSelector: "component=etcd" }),
  ]);
  const summary: ControlPlaneSummary = { notVisible };

  if (version.status === "fulfilled" && version.value.status === 200) {
    try {
      summary.serverVersion = (JSON.parse(version.value.body) as { gitVersion?: string }).gitVersion;
    } catch {
      // leave undefined
    }
    summary.certificate = version.value.peerCertificate;
  } else {
    notVisible.push(`API server version: ${version.status === "fulfilled" ? rawProblem(version.value.status) : k8sErrorMessage(version.reason)}`);
  }
  if (!summary.certificate && version.status === "fulfilled") {
    notVisible.push("API server certificate: not available (plain HTTP or a proxy in between)");
  }

  // /readyz answers 500 when a check fails, but the body still lists every check.
  if (readyz.status === "fulfilled" && (readyz.value.status === 200 || readyz.value.status === 500)) {
    const checks = parseHealthChecks(readyz.value.body);
    if (checks.length > 0) summary.readyz = checks;
    else notVisible.push("API server health checks: unexpected /readyz output");
  } else {
    notVisible.push(`API server health checks: ${readyz.status === "fulfilled" ? rawProblem(readyz.value.status) : k8sErrorMessage(readyz.reason)}`);
  }

  if (metrics.status === "fulfilled" && metrics.value.status === 200) {
    const storage = etcdStorageFromMetrics(metrics.value.body);
    const args =
      etcdPods.status === "fulfilled"
        ? etcdPods.value.items.flatMap((p) => [...(p.spec?.containers[0]?.command ?? []), ...(p.spec?.containers[0]?.args ?? [])])
        : [];
    const quotaFromFlag = etcdQuotaFromArgs(args);
    summary.etcd = {
      dbSizeBytes: storage.dbSizeBytes,
      quotaBytes: quotaFromFlag ?? ETCD_DEFAULT_QUOTA_BYTES,
      quotaSource: quotaFromFlag !== undefined ? "flag" : "default",
      objectCounts: storage.objectCounts.slice(0, 10),
    };
    if (storage.dbSizeBytes === undefined) {
      notVisible.push("etcd size: not exposed by this API server (managed control plane?)");
    }
  } else {
    notVisible.push(`etcd size and object counts: /metrics ${metrics.status === "fulfilled" ? rawProblem(metrics.value.status) : k8sErrorMessage(metrics.reason)}`);
  }
  return summary;
}

/**
 * Adds each node's last heartbeat (its Lease in kube-node-lease) and the resources
 * requested by the pods running on it. `allPods` must cover every namespace.
 */
export async function addNodeUsage(
  k8s: K8sClients,
  nodes: NodeSummary[],
  allPods: V1Pod[],
  errors: string[],
): Promise<void> {
  try {
    const leases = await k8s.coordination.listNamespacedLease({ namespace: "kube-node-lease" });
    const renewed = new Map(leases.items.map((l) => [l.metadata?.name ?? "", l.spec?.renewTime]));
    for (const node of nodes) {
      const t = renewed.get(node.name);
      if (t) node.heartbeat = new Date(t).toISOString();
    }
  } catch (err) {
    errors.push(`list node leases: ${k8sErrorMessage(err)}`);
  }

  const usage = new Map<string, { cpu: number; memory: number; pods: number }>();
  for (const pod of allPods) {
    const nodeName = pod.spec?.nodeName;
    const phase = pod.status?.phase;
    if (!nodeName || phase === "Succeeded" || phase === "Failed") continue;
    const req = podRequests(pod.spec?.containers ?? [], pod.spec?.initContainers ?? []);
    const u = usage.get(nodeName) ?? { cpu: 0, memory: 0, pods: 0 };
    u.cpu += req.cpu ?? 0;
    u.memory += req.memory ?? 0;
    u.pods += 1;
    usage.set(nodeName, u);
  }
  for (const node of nodes) node.requested = usage.get(node.name) ?? { cpu: 0, memory: 0, pods: 0 };
}

/** Lists admission webhooks and checks whether their backing Service can answer. */
export async function collectWebhooks(k8s: K8sClients): Promise<WebhookSummary[]> {
  const [validating, mutating] = await Promise.all([
    k8s.admission.listValidatingWebhookConfiguration(),
    k8s.admission.listMutatingWebhookConfiguration(),
  ]);
  const entries = [
    ...validating.items.flatMap((c) => (c.webhooks ?? []).map((w) => ({ kind: "Validating" as const, config: c.metadata?.name ?? "?", w }))),
    ...mutating.items.flatMap((c) => (c.webhooks ?? []).map((w) => ({ kind: "Mutating" as const, config: c.metadata?.name ?? "?", w }))),
  ];

  // Several webhooks often share one Service; check each Service once.
  const serviceStatus = new Map<string, Promise<Pick<WebhookSummary, "status" | "detail">>>();
  const checkService = (namespace: string, name: string) => {
    const key = `${namespace}/${name}`;
    if (!serviceStatus.has(key)) {
      serviceStatus.set(
        key,
        (async () => {
          try {
            await k8s.core.readNamespacedService({ namespace, name });
          } catch (err) {
            if ((err as { code?: number }).code === 404) {
              return { status: "service-missing" as const, detail: `Service ${key} does not exist` };
            }
            return { status: "unknown" as const, detail: `Service ${key}: ${k8sErrorMessage(err)}` };
          }
          try {
            const slices = await k8s.discovery.listNamespacedEndpointSlice({
              namespace,
              labelSelector: `kubernetes.io/service-name=${name}`,
            });
            // An endpoint without a "ready" condition counts as ready (API convention).
            const ready = slices.items.flatMap((s) => s.endpoints ?? []).filter((e) => e.conditions?.ready !== false);
            return ready.length > 0
              ? { status: "ok" as const, detail: `${ready.length} ready endpoint(s)` }
              : { status: "no-ready-endpoints" as const, detail: `Service ${key} has no ready endpoints` };
          } catch (err) {
            return { status: "unknown" as const, detail: `endpoints of ${key}: ${k8sErrorMessage(err)}` };
          }
        })(),
      );
    }
    return serviceStatus.get(key)!;
  };

  return Promise.all(
    entries.map(async ({ kind, config, w }) => {
      const svc = w.clientConfig.service;
      const base = { kind, configName: config, name: w.name, failurePolicy: w.failurePolicy ?? "Fail" };
      if (!svc) return { ...base, status: "external" as const, detail: "URL-based webhook; reachability not checked" };
      return { ...base, service: { namespace: svc.namespace, name: svc.name }, ...(await checkService(svc.namespace, svc.name)) };
    }),
  );
}
