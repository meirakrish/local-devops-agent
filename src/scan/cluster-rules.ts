import { parseMinorVersion } from "./cluster.js";
import { formatCpu, formatMemory, parseQuantity } from "./quantity.js";
import type { ControlPlanePod, ControlPlaneSummary, Issue, NodeSummary, WebhookSummary } from "./types.js";

/** Rules for cluster-level health: control plane, etcd, node capacity and webhooks. */

const DAY_MS = 24 * 60 * 60 * 1000;

export const THRESHOLDS = {
  certCriticalDays: 7,
  certWarningDays: 30,
  etcdWarningRatio: 0.7,
  etcdCriticalRatio: 0.9,
  objectCountWarning: 100_000,
  /** Kubelets renew their Lease every ~10s; the node controller reacts after ~50s. */
  heartbeatStaleSeconds: 60,
  nodeRequestRatio: 0.9,
  /** Supported skew: kubelet may be up to 3 minor versions older, never newer. */
  maxKubeletMinorsBehind: 3,
  /** Probe failures of a control-plane pod within the event window before warning. */
  probeFailureWarning: 3,
};

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function controlPlaneIssues(cp: ControlPlaneSummary, now: Date): Issue[] {
  const issues: Issue[] = [];
  const apiServer = { kind: "ControlPlane", name: "kube-apiserver" };
  const etcd = { kind: "ControlPlane", name: "etcd" };

  const failed = (cp.readyz ?? []).filter((c) => !c.ok);
  const etcdFailed = failed.filter((c) => c.name.startsWith("etcd"));
  const otherFailed = failed.filter((c) => !c.name.startsWith("etcd"));
  const describe = (c: { name: string; reason?: string }) => `readyz check "${c.name}" failed${c.reason ? `: ${c.reason}` : ""}`;
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
    if (daysLeft < THRESHOLDS.certWarningDays) {
      const expired = daysLeft < 0;
      issues.push({
        id: "controlplane/kube-apiserver:certificate",
        severity: daysLeft < THRESHOLDS.certCriticalDays ? "critical" : "warning",
        category: "certificate-expiry",
        resource: apiServer,
        title: expired
          ? "API server certificate has expired"
          : `API server certificate expires in ${Math.floor(daysLeft)} day(s)`,
        evidence: [`certificate ${cp.certificate.subject} (issuer ${cp.certificate.issuer}) is valid until ${cp.certificate.notAfter}`],
        hint: "On kubeadm clusters, run `kubeadm certs check-expiration` and `kubeadm certs renew all` on each control-plane node, then restart the control-plane pods. Managed clusters rotate certificates automatically.",
      });
    }
  }

  if (cp.etcd?.dbSizeBytes !== undefined) {
    const ratio = cp.etcd.dbSizeBytes / cp.etcd.quotaBytes;
    if (ratio >= THRESHOLDS.etcdWarningRatio) {
      const top = cp.etcd.objectCounts.slice(0, 3).map((o) => `${o.resource}=${o.count}`).join(", ");
      issues.push({
        id: "controlplane/etcd:db-size",
        severity: ratio >= THRESHOLDS.etcdCriticalRatio ? "critical" : "warning",
        category: "etcd-db-size",
        resource: etcd,
        title: `etcd database is at ${pct(ratio)} of its quota`,
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
    if (o.count < THRESHOLDS.objectCountWarning) continue;
    issues.push({
      id: `controlplane/etcd:objects-${o.resource}`,
      severity: "warning",
      category: "etcd-object-count",
      resource: etcd,
      title: `${o.count} ${o.resource} objects stored in etcd`,
      evidence: [`apiserver object count for ${o.resource} is ${o.count} (warning at ${THRESHOLDS.objectCountWarning})`],
      hint: "Large object counts slow down the API server and fill etcd. Look for a controller or job that creates objects without cleaning them up.",
    });
  }
  return issues;
}

export function nodeCapacityIssues(node: NodeSummary, now: Date, serverVersion?: string): Issue[] {
  const issues: Issue[] = [];
  const resource = { kind: "Node", name: node.name };

  if (node.heartbeat) {
    const ageSeconds = (now.getTime() - Date.parse(node.heartbeat)) / 1000;
    if (ageSeconds > THRESHOLDS.heartbeatStaleSeconds) {
      issues.push({
        id: `node/${node.name}:heartbeat`,
        severity: "critical",
        category: "node-heartbeat",
        resource,
        title: `Node ${node.name} kubelet has not sent a heartbeat for ${Math.round(ageSeconds)}s`,
        evidence: [`Lease kube-node-lease/${node.name} was last renewed at ${node.heartbeat} (kubelets renew it about every 10s)`],
        hint: "The kubelet is down, hung, or cannot reach the API server; check the node, its kubelet service and its network. If every node shows this, check the clock of the machine running this check.",
      });
    }
  }

  if (node.requested) {
    const checks = [
      { name: "cpu", used: node.requested.cpu, total: parseQuantity(node.allocatable.cpu), fmt: formatCpu },
      { name: "memory", used: node.requested.memory, total: parseQuantity(node.allocatable.memory), fmt: formatMemory },
      { name: "pods", used: node.requested.pods, total: parseQuantity(node.allocatable.pods), fmt: (n: number) => String(n) },
    ];
    const full = checks.filter((c) => c.total && c.used / c.total >= THRESHOLDS.nodeRequestRatio);
    if (full.length > 0) {
      issues.push({
        id: `node/${node.name}:capacity`,
        severity: "warning",
        category: "node-capacity",
        resource,
        title: `Node ${node.name} is nearly full (${full.map((c) => `${c.name} ${pct(c.used / c.total!)}`).join(", ")} requested)`,
        evidence: full.map((c) => `${c.name}: ${c.fmt(c.used)} requested of ${c.fmt(c.total!)} allocatable`),
        hint: "New pods may not fit on this node even if actual usage is low. Right-size requests of the pods on it, or add nodes.",
      });
    }
  }

  const server = parseMinorVersion(serverVersion);
  const kubelet = parseMinorVersion(node.kubeletVersion);
  if (server && kubelet) {
    const behind = (server.major - kubelet.major) * 100 + (server.minor - kubelet.minor);
    if (behind < 0 || behind > THRESHOLDS.maxKubeletMinorsBehind) {
      issues.push({
        id: `node/${node.name}:version-skew`,
        severity: "critical",
        category: "version-skew",
        resource,
        title:
          behind < 0
            ? `Node ${node.name} kubelet ${node.kubeletVersion} is newer than the API server ${serverVersion}`
            : `Node ${node.name} kubelet ${node.kubeletVersion} is ${behind} minor versions behind the API server ${serverVersion}`,
        evidence: [`kubelet ${node.kubeletVersion}, API server ${serverVersion}; supported: kubelet up to ${THRESHOLDS.maxKubeletMinorsBehind} minor versions older, never newer`],
        hint: "Finish the upgrade: upgrade the control plane first, then the nodes, one minor version at a time.",
      });
    }
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
  etcd: "Check the etcd logs for slow disk warnings (\"apply request took too long\"), leader elections or a NOSPACE alarm. etcd needs fast, uncontended disks.",
  "kube-scheduler":
    "The scheduler exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for \"leaderelection lost\", then check kube-apiserver health first.",
  "kube-controller-manager":
    "The controller-manager exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for \"leaderelection lost\", then check kube-apiserver health first.",
};

function minutesAgo(iso: string, now: Date): number {
  return Math.round((now.getTime() - Date.parse(iso)) / 60_000);
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
      pod.probeFailures && pod.probeFailures.count >= THRESHOLDS.probeFailureWarning ? pod.probeFailures : undefined;
    if (!down && !recentRestart && !probes) continue;

    const evidence: string[] = [];
    if (down) evidence.push(`${pod.component} is ${pod.phase}${pod.stateReason ? ` (${pod.stateReason})` : ""} and not ready on node ${pod.nodeName ?? "?"}`);
    if (recentRestart) {
      const how = [recentRestart.reason, recentRestart.exitCode !== undefined ? `exit code ${recentRestart.exitCode}` : undefined].filter(Boolean).join(", ");
      evidence.push(`last restart ${minutesAgo(recentRestart.finishedAt, now)} min ago${how ? ` (${how})` : ""}; ${pod.restarts} restart(s) in total`);
    }
    if (probes) {
      evidence.push(
        `up to ${probes.count} ${probes.kinds.join("/") || "probe"} probe failure(s) in the last ${windowMinutes} min, last ${minutesAgo(probes.lastSeen, now)} min ago: ${probes.lastMessage}`,
      );
    }

    const category = down ? "controlplane-pod-down" : recentRestart ? "controlplane-restart" : "controlplane-probe-failures";
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

