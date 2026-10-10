import { formatBytes, formatPercent } from "./quantity.js";
import { minutesSince } from "./time.js";
import type {
  ApiServiceSummary,
  ControlPlanePod,
  ControlPlaneSummary,
  Issue,
  LeaderLease,
  TerminatingNamespace,
  WebhookSummary,
} from "./types.js";

/**
 * Rules for cluster-level health: control plane, etcd, leader election, admission
 * webhooks, aggregated APIs and namespaces stuck terminating.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const CLUSTER_THRESHOLDS = {
  certCriticalDays: 7,
  certWarningDays: 30,
  etcdWarningRatio: 0.7,
  etcdCriticalRatio: 0.9,
  objectCountWarning: 100_000,
  /** Probe failures of a control-plane pod within the event window before warning. */
  probeFailureWarning: 3,
  /**
   * Seconds a leader-election Lease may be overdue (past leaseDurationSeconds) before it
   * counts as stale. Covers clock skew between this machine and the control plane, and a
   * leader handover, which takes up to one lease duration plus a retry period.
   */
  leaderLeaseSlackSeconds: 60,
};

export function controlPlaneIssues(cp: ControlPlaneSummary, now: Date): Issue[] {
  const issues: Issue[] = [];
  const apiServer = { kind: "ControlPlane", name: "kube-apiserver" };
  const etcd = { kind: "ControlPlane", name: "etcd" };

  const failed = (cp.readyz ?? []).filter((c) => !c.ok);
  const etcdFailed = failed.filter((c) => c.name.startsWith("etcd"));
  const otherFailed = failed.filter((c) => !c.name.startsWith("etcd"));
  const describe = (c: { name: string; reason?: string }) =>
    `readyz check "${c.name}" failed${c.reason ? `: ${c.reason}` : ""}`;
  if (etcdFailed.length > 0) {
    issues.push({
      id: "controlplane/etcd:unhealthy",
      severity: "critical",
      category: "etcd-unhealthy",
      resource: etcd,
      title: "etcd health check is failing (the API server cannot use etcd)",
      evidence: etcdFailed.map(describe),
      hint: "Check the etcd pods or members on the control-plane nodes: are they running, do they have quorum, is the disk full or slow? On managed clusters, contact the provider.",
    });
  }
  if (otherFailed.length > 0) {
    issues.push({
      id: "controlplane/kube-apiserver:not-ready",
      severity: "critical",
      category: "apiserver-not-ready",
      resource: apiServer,
      title: `API server reports ${otherFailed.length} failing readiness check(s)`,
      evidence: otherFailed.map(describe),
      hint: "Check the kube-apiserver logs and its dependencies (etcd, webhooks, aggregated APIs).",
    });
  }

  if (cp.certificate) {
    const daysLeft = (Date.parse(cp.certificate.notAfter) - now.getTime()) / DAY_MS;
    if (daysLeft < CLUSTER_THRESHOLDS.certWarningDays) {
      const expired = daysLeft < 0;
      issues.push({
        id: "controlplane/kube-apiserver:certificate",
        severity: daysLeft < CLUSTER_THRESHOLDS.certCriticalDays ? "critical" : "warning",
        category: "certificate-expiry",
        resource: apiServer,
        title: expired
          ? "API server certificate has expired"
          : `API server certificate expires in ${Math.floor(daysLeft)} day(s)`,
        evidence: [
          `certificate ${cp.certificate.subject} (issuer ${cp.certificate.issuer}) is valid until ${cp.certificate.notAfter}`,
        ],
        hint: "On kubeadm clusters, run `kubeadm certs check-expiration` and `kubeadm certs renew all` on each control-plane node, then restart the control-plane pods. Managed clusters rotate certificates automatically.",
      });
    }
  }

  if (cp.etcd?.dbSizeBytes !== undefined) {
    const ratio = cp.etcd.dbSizeBytes / cp.etcd.quotaBytes;
    if (ratio >= CLUSTER_THRESHOLDS.etcdWarningRatio) {
      const top = cp.etcd.objectCounts
        .slice(0, 3)
        .map((o) => `${o.resource}=${o.count}`)
        .join(", ");
      issues.push({
        id: "controlplane/etcd:db-size",
        severity: ratio >= CLUSTER_THRESHOLDS.etcdCriticalRatio ? "critical" : "warning",
        category: "etcd-db-size",
        resource: etcd,
        title: `etcd database is at ${formatPercent(ratio)} of its quota`,
        evidence: [
          `etcd database ${formatBytes(cp.etcd.dbSizeBytes)} of ${formatBytes(cp.etcd.quotaBytes)} quota (${cp.etcd.quotaSource === "default" ? "etcd default; --quota-backend-bytes not visible" : "from --quota-backend-bytes"})`,
          ...(top ? [`largest object counts: ${top}`] : []),
          "when the quota is reached, etcd raises a NOSPACE alarm and the cluster becomes read-only",
        ],
        hint: "Delete objects that are no longer needed (old ReplicaSets, completed Jobs, events), then compact and defragment etcd. If the database legitimately needs more room, raise --quota-backend-bytes (8 GiB is the recommended maximum).",
      });
    }
  }

  for (const o of cp.etcd?.objectCounts ?? []) {
    if (o.count < CLUSTER_THRESHOLDS.objectCountWarning) continue;
    issues.push({
      id: `controlplane/etcd:objects-${o.resource}`,
      severity: "warning",
      category: "etcd-object-count",
      resource: etcd,
      title: `${o.count} ${o.resource} objects stored in etcd`,
      evidence: [
        `apiserver object count for ${o.resource} is ${o.count} (warning at ${CLUSTER_THRESHOLDS.objectCountWarning})`,
      ],
      hint: "Large object counts slow down the API server and fill etcd. Look for a controller or job that creates objects without cleaning them up.",
    });
  }
  return issues;
}

export function webhookIssues(w: WebhookSummary): Issue[] {
  if (w.status !== "service-missing" && w.status !== "no-ready-endpoints") return [];
  const blocking = w.failurePolicy !== "Ignore";
  return [
    {
      id: `webhook/${w.configName}/${w.name}:unavailable`,
      severity: blocking ? "critical" : "warning",
      category: "webhook-unavailable",
      resource: { kind: `${w.kind}WebhookConfiguration`, name: w.configName },
      title: blocking
        ? `${w.kind} webhook ${w.name} is unreachable and blocks the requests it matches`
        : `${w.kind} webhook ${w.name} is unreachable and silently skipped`,
      evidence: [
        w.detail ?? w.status,
        `failurePolicy=${w.failurePolicy}: ${blocking ? "matching create/update requests are rejected" : "matching requests are allowed without this webhook's checks"}`,
      ],
      hint: `Restore the webhook's backend (Service ${w.service?.namespace}/${w.service?.name} and its pods), or delete the ${w.kind}WebhookConfiguration ${w.configName} if that component was uninstalled.`,
    },
  ];
}

/** Where to look first, per component. */
const COMPONENT_HINTS: Record<string, string> = {
  "kube-apiserver":
    "Check the kube-apiserver logs and etcd health (k8s_cluster_health). A readiness probe answering HTTP 500 means one of its /readyz checks failed, often etcd. Also check CPU and memory pressure on the control-plane node.",
  etcd: 'Check the etcd logs for slow disk warnings ("apply request took too long"), leader elections or a NOSPACE alarm. etcd needs fast, uncontended disks.',
  "kube-scheduler":
    'The scheduler exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.',
  "kube-controller-manager":
    'The controller-manager exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.',
};

/** Whole minutes since `iso`, for messages. */
function minutesAgo(iso: string, now: Date): number {
  return Math.round(minutesSince(iso, now));
}

/**
 * One issue per control-plane pod: critical while it is down, a warning when it restarted
 * or failed probes within the window but has recovered (the incident is over, but the
 * cause usually is not).
 */
export function controlPlanePodIssues(pods: ControlPlanePod[], now: Date, windowMinutes: number): Issue[] {
  const issues: Issue[] = [];
  for (const pod of pods) {
    const down = !pod.ready || pod.phase !== "Running";
    const recentRestart =
      pod.lastRestart && minutesAgo(pod.lastRestart.finishedAt, now) <= windowMinutes ? pod.lastRestart : undefined;
    const probes =
      pod.probeFailures && pod.probeFailures.count >= CLUSTER_THRESHOLDS.probeFailureWarning
        ? pod.probeFailures
        : undefined;
    if (!down && !recentRestart && !probes) continue;

    const evidence: string[] = [];
    if (down)
      evidence.push(
        `${pod.component} is ${pod.phase}${pod.stateReason ? ` (${pod.stateReason})` : ""} and not ready on node ${pod.nodeName ?? "?"}`,
      );
    if (recentRestart) {
      const how = [
        recentRestart.reason,
        recentRestart.exitCode !== undefined ? `exit code ${recentRestart.exitCode}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      evidence.push(
        `last restart ${minutesAgo(recentRestart.finishedAt, now)} min ago${how ? ` (${how})` : ""}; ${pod.restarts} restart(s) in total`,
      );
    }
    if (probes) {
      evidence.push(
        `up to ${probes.count} ${probes.kinds.join("/") || "probe"} probe failure(s) in the last ${windowMinutes} min, last ${minutesAgo(probes.lastSeen, now)} min ago: ${probes.lastMessage}`,
      );
    }

    const category = down
      ? "controlplane-pod-down"
      : recentRestart
        ? "controlplane-restart"
        : "controlplane-probe-failures";
    const title = down
      ? `Control-plane component ${pod.component} is not ready${pod.stateReason ? ` (${pod.stateReason})` : ""}`
      : recentRestart
        ? `Control-plane component ${pod.component} restarted ${minutesAgo(recentRestart.finishedAt, now)} min ago`
        : `Control-plane component ${pod.component} failed health probes ${probes!.count} time(s) recently`;

    issues.push({
      id: `pod/kube-system/${pod.name}:${category}`,
      severity: down ? "critical" : "warning",
      category,
      resource: { kind: "Pod", namespace: "kube-system", name: pod.name },
      title,
      evidence,
      hint:
        COMPONENT_HINTS[pod.component] ??
        "Check this component's previous logs and the health of the API server and etcd it depends on.",
    });
  }
  return issues;
}

/** What stops working while a component has no active leader. */
const LEADER_IMPACT: Record<string, string> = {
  "kube-scheduler": "nothing schedules new pods: they stay Pending without a scheduling event",
  "kube-controller-manager":
    "controllers do not reconcile: Deployments and Jobs create no pods, Service endpoints are not updated, NotReady nodes are not handled, and namespaces are not deleted",
};

function duration(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
}

/**
 * A stale leader-election Lease means the component is not working: no instance holds and
 * renews it. Works on managed clusters too, where the control-plane pods are hidden.
 */
export function leaderLeaseIssues(leases: LeaderLease[], now: Date): Issue[] {
  return leases.flatMap((lease): Issue[] => {
    const duration_ = lease.leaseDurationSeconds ?? 15;
    const age = lease.renewTime ? (now.getTime() - Date.parse(lease.renewTime)) / 1000 : Number.POSITIVE_INFINITY;
    if (age <= duration_ + CLUSTER_THRESHOLDS.leaderLeaseSlackSeconds) return [];
    const renewed = lease.renewTime ? `last renewed ${duration(age)} ago (${lease.renewTime})` : "never renewed";
    return [
      {
        id: `controlplane/${lease.component}:leader-stale`,
        severity: "critical",
        category: "leader-election-stale",
        resource: { kind: "ControlPlane", name: lease.component },
        title: `${lease.component} has no active leader: its leader-election Lease was ${renewed.split(" (")[0]}`,
        evidence: [
          `Lease kube-system/${lease.component}: holder ${lease.holder ?? "(none)"}, ${renewed}, leaseDurationSeconds=${duration_}`,
          `while no ${lease.component} instance leads, ${LEADER_IMPACT[lease.component] ?? "this component does nothing"}`,
        ],
        hint: `Every ${lease.component} instance is down or cannot reach the API server. On self-managed clusters, check its pods and previous logs on the control-plane nodes (k8s_cluster_health section="control-plane") and the API server and etcd it depends on; on managed clusters, contact the provider.`,
      },
    ];
  });
}

/** "v1beta1.metrics.k8s.io" -> "metrics.k8s.io/v1beta1". */
export function apiServiceGroupVersion(name: string): string {
  const dot = name.indexOf(".");
  return dot > 0 ? `${name.slice(dot + 1)}/${name.slice(0, dot)}` : name;
}

/**
 * An aggregated API whose backend does not answer. Besides its own API failing, API
 * discovery is incomplete, which stalls namespace deletion and garbage collection
 * cluster-wide. Brief outages (e.g. while its pods restart) are skipped.
 */
export function apiServiceIssues(a: ApiServiceSummary, now: Date, graceMinutes = 5): Issue[] {
  if (a.available || minutesSince(a.since, now) < graceMinutes) return [];
  const gv = apiServiceGroupVersion(a.name);
  const svc = `${a.service.namespace}/${a.service.name}`;
  const since = a.since ? `for ${Math.round(minutesSince(a.since, now))} min` : "for an unknown time";
  return [
    {
      id: `apiservice/${a.name}:unavailable`,
      severity: "critical",
      category: "apiservice-unavailable",
      resource: { kind: "APIService", name: a.name },
      title: `Aggregated API ${gv} is unavailable${a.reason ? ` (${a.reason})` : ""}`,
      evidence: [
        `APIService ${a.name}: Available=False ${since}${a.reason ? ` (${a.reason})` : ""}${a.message ? `: ${a.message}` : ""}`,
        `backed by Service ${svc}`,
        `requests to ${gv} fail, API discovery is incomplete (kubectl warns "unable to retrieve the complete list of server APIs"), and namespace deletion and garbage collection stall${gv.startsWith("metrics.k8s.io/") ? "; HorizontalPodAutoscalers and `kubectl top` stop working" : ""}`,
      ],
      hint: `Restore the backend: Service ${svc}, its endpoints and pods (k8s_get_service). If that component was uninstalled, delete the leftover APIService ${a.name}.`,
    },
  ];
}

/** Conditions that mean the namespace controller cannot list or delete some API group. */
const API_DELETION_FAILURES = new Set([
  "NamespaceDeletionDiscoveryFailure",
  "NamespaceDeletionGroupVersionParsingFailure",
]);

/**
 * A namespace still Terminating after the grace period. When deletion is blocked by API
 * discovery (often an unavailable aggregated API) the category is "namespace-terminating-api",
 * which triage groups with the unavailable APIServices; otherwise "namespace-terminating".
 */
export function terminatingNamespaceIssues(
  ns: TerminatingNamespace,
  unavailableApis: ApiServiceSummary[],
  now: Date,
  graceMinutes = 5,
): Issue[] {
  const minutes = minutesSince(ns.deletionTimestamp, now);
  if (minutes < graceMinutes) return [];
  const messages = ns.conditions.map((c) => c.message ?? "").join("\n");
  const blockingApis = unavailableApis.filter((a) => messages.includes(apiServiceGroupVersion(a.name)));
  const apiBlocked = ns.conditions.some((c) => API_DELETION_FAILURES.has(c.type)) || blockingApis.length > 0;
  const named = blockingApis.length > 0 ? blockingApis : apiBlocked ? unavailableApis : [];

  return [
    {
      id: `namespace/${ns.name}:stuck-terminating`,
      severity: "warning",
      category: apiBlocked ? "namespace-terminating-api" : "namespace-terminating",
      resource: { kind: "Namespace", name: ns.name },
      title: `Namespace ${ns.name} is stuck Terminating${Number.isFinite(minutes) ? ` for ${Math.round(minutes)} min` : ""}`,
      evidence: [
        ...ns.conditions.map((c) => `${c.type}${c.reason ? ` (${c.reason})` : ""}: ${c.message ?? ""}`),
        ...(ns.conditions.length === 0 ? ["no deletion conditions reported yet"] : []),
        ...(named.length > 0
          ? [
              `unavailable aggregated API(s): ${named.map((a) => a.name).join(", ")}; deletion waits until every API group can be listed`,
            ]
          : []),
        ...(ns.finalizers.length > 0 ? [`spec.finalizers: ${ns.finalizers.join(", ")}`] : []),
      ],
      hint: apiBlocked
        ? "Deletion is blocked because an API group cannot be discovered or listed, usually an unavailable aggregated API (APIService). Fix or delete that APIService; deletion then resumes on its own. Do not remove the namespace's finalizer by hand: that leaves orphaned objects behind."
        : "Objects with finalizers are left in the namespace (see NamespaceContentRemaining / NamespaceFinalizersRemaining). Find the controller that should remove those finalizers (often an uninstalled operator); remove a finalizer by hand only once you know what it protects.",
    },
  ];
}
