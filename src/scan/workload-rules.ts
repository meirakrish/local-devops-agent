import type { DnsSummary, EventSummary, Issue, ServicePod, ServiceSummary, WorkloadSummary } from "./types.js";

/** Rules for DaemonSets, StatefulSets, Services, cluster DNS and pod creation failures. */

function ageMinutes(createdAt: string | undefined, now: Date): number {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  return (now.getTime() - new Date(createdAt).getTime()) / 60_000;
}

const formatSelector = (selector: Record<string, string>) =>
  Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

function podState(p: ServicePod): string {
  return `${p.name} (${p.ready ? "ready" : (p.reason ?? p.phase)})`;
}

/** "namespace/name" of the one workload all pods belong to, if there is exactly one. */
function singleWorkload(namespace: string, pods: ServicePod[]): string | undefined {
  const names = [...new Set(pods.map((p) => p.workload).filter((w): w is string => w !== undefined))];
  return names.length === 1 ? `${namespace}/${names[0]}` : undefined;
}

export function workloadIssues(w: WorkloadSummary): Issue[] {
  if (w.desired === 0 || w.ready >= w.desired) return [];
  const evidence = [`desired=${w.desired} ready=${w.ready} updated=${w.updated}`];
  if (w.kind === "StatefulSet" && w.updateRevision && w.currentRevision !== w.updateRevision) {
    evidence.push(`rollout in progress: ${w.updated}/${w.desired} pods on revision ${w.updateRevision} (current ${w.currentRevision ?? "?"})`);
  }
  const hint =
    w.kind === "DaemonSet"
      ? "A DaemonSet runs one pod per eligible node. Find the nodes without a ready pod (k8s_get_workload lists the pods with their nodes): either the pod there is failing, or the node has a problem (NotReady, pressure, taints)." +
        (w.namespace === "kube-system" ? " In kube-system this is often the CNI or kube-proxy, so pods on those nodes may lose networking." : "")
      : "StatefulSet pods start one at a time, in order, so one failing pod blocks the ones after it. Start with the lowest-numbered pod that is not ready, and check that its PersistentVolumeClaim is Bound.";
  return [
    {
      id: `${w.kind.toLowerCase()}/${w.namespace}/${w.name}:unavailable`,
      severity: w.ready === 0 ? "critical" : "warning",
      category: "replicas-unavailable",
      resource: { kind: w.kind, namespace: w.namespace, name: w.name },
      title: `${w.kind} ${w.namespace}/${w.name} has ${w.ready}/${w.desired} pods ready`,
      evidence,
      hint,
      workload: `${w.namespace}/${w.name}`,
    },
  ];
}

/**
 * A Service without ready endpoints drops every request sent to it. Pods that are still
 * starting (younger than the grace period) are given time before this counts.
 */
export function serviceIssues(svc: ServiceSummary, now: Date, graceMinutes = 5): Issue[] {
  if (svc.readyEndpoints > 0) return [];
  const { namespace, name } = svc;
  const resource = { kind: "Service", namespace, name };
  const selector = formatSelector(svc.selector);

  if (svc.pods.length === 0) {
    const values = Object.entries(svc.podLabelValues).map(
      ([k, vs]) => `${k}: ${vs.length > 0 ? vs.join(", ") : "(no pod has this label)"}`,
    );
    return [
      {
        id: `service/${namespace}/${name}:no-pods`,
        severity: "warning",
        category: "service-no-pods",
        resource,
        title: `Service ${namespace}/${name} selects no pods, so requests to it fail`,
        evidence: [
          `selector ${selector} matches no running pods in namespace ${namespace}`,
          `label values on running pods in ${namespace}: ${values.join("; ")}`,
        ],
        hint: "Compare the selector with the labels of the pod template it is meant for. A typo or a renamed label means the selector must be fixed; if its workload was scaled to zero or removed on purpose, scale it up or delete the Service.",
      },
    ];
  }

  if (svc.pods.every((p) => ageMinutes(p.createdAt, now) < graceMinutes)) return [];
  const readyPods = svc.pods.filter((p) => p.ready);
  const workload = singleWorkload(namespace, svc.pods);
  if (readyPods.length > 0) {
    // Ready pods but no ready endpoints: the endpoint controller is behind or not running.
    return [
      {
        id: `service/${namespace}/${name}:no-ready-endpoints`,
        severity: "warning",
        category: "service-no-ready-endpoints",
        resource,
        title: `Service ${namespace}/${name} has no ready endpoints although ${readyPods.length} of its pods are ready`,
        evidence: [`selector ${selector} matches: ${svc.pods.map(podState).join(", ")}`, `endpoints: ${svc.readyEndpoints} ready, ${svc.notReadyEndpoints} not ready`],
        hint: "The endpoint controller (part of kube-controller-manager) may be behind or down; check control-plane health.",
        workload,
      },
    ];
  }
  return [
    {
      id: `service/${namespace}/${name}:no-ready-endpoints`,
      severity: "critical",
      category: "service-no-ready-endpoints",
      resource,
      title: `Service ${namespace}/${name} has no ready endpoints: none of its ${svc.pods.length} pod(s) is ready`,
      evidence: [`selector ${selector} matches ${svc.pods.length} pod(s), none ready: ${svc.pods.map(podState).join(", ")}`],
      hint: "Requests to this Service fail until at least one of its pods passes its readiness probe. The cause is in the pods; see the pod issues of the same workload.",
      workload,
    },
  ];
}

/** Cluster DNS gets its own rule: when it is down, almost every app fails in confusing ways. */
export function dnsIssues(dns: DnsSummary): Issue[] {
  const svc = dns.service;
  if (!svc) return [];
  const resource = { kind: "Service", namespace: svc.namespace, name: svc.name };
  const pods = svc.pods.length > 0 ? svc.pods.map(podState).join(", ") : `none (selector ${formatSelector(svc.selector)} matches no running pods)`;
  const workload = singleWorkload(svc.namespace, svc.pods);
  const total = svc.readyEndpoints + svc.notReadyEndpoints;

  if (svc.readyEndpoints === 0) {
    return [
      {
        id: `service/${svc.namespace}/${svc.name}:dns-down`,
        severity: "critical",
        category: "dns-down",
        resource,
        title: `Cluster DNS is down: Service ${svc.namespace}/${svc.name} has no ready endpoints`,
        evidence: [`DNS pods: ${pods}`, `endpoints: 0 ready, ${svc.notReadyEndpoints} not ready`],
        hint: "Every pod that resolves a name fails: lookups time out or return errors, which often shows up as connection errors in unrelated apps. Check the DNS (CoreDNS) pods' logs and events; common causes are a bad Corefile in the coredns ConfigMap, a forwarding loop, or the pods being unschedulable.",
        workload,
      },
    ];
  }
  if (svc.notReadyEndpoints > 0) {
    return [
      {
        id: `service/${svc.namespace}/${svc.name}:dns-degraded`,
        severity: "warning",
        category: "dns-degraded",
        resource,
        title: `Cluster DNS is degraded: ${svc.readyEndpoints} of ${total} endpoints of ${svc.namespace}/${svc.name} are ready`,
        evidence: [`DNS pods: ${pods}`],
        hint: "DNS still answers, with less capacity and no redundancy. Check the DNS (CoreDNS) pods that are not ready: their logs and events.",
        workload,
      },
    ];
  }
  return [];
}

/** Known reasons the API server rejects a controller's pod, most specific first. */
const CREATE_FAILURE_CAUSES: { pattern: RegExp; label: string; hint: string }[] = [
  {
    pattern: /exceeded quota/i,
    label: "ResourceQuota exceeded",
    hint: "The namespace's ResourceQuota is used up. Compare the quota's used and hard values (`kubectl describe resourcequota`) with the pod's requests; raise the quota, lower the requests, or free capacity in the namespace.",
  },
  {
    pattern: /must specify (limits|requests)|failed quota/i,
    label: "ResourceQuota requires requests/limits",
    hint: "The namespace's ResourceQuota covers CPU or memory, so every container must set those requests/limits. Add them to the pod template (or add a LimitRange with defaults).",
  },
  {
    pattern: /violates PodSecurity/i,
    label: "rejected by Pod Security admission",
    hint: "The pod template violates the namespace's Pod Security level (label pod-security.kubernetes.io/enforce). The message lists the offending fields; remove them from the pod template, or change the namespace's level if the workload really needs them.",
  },
  {
    pattern: /failed calling webhook/i,
    label: "admission webhook unreachable",
    hint: "An admission webhook that matches pods could not be called and has failurePolicy=Fail. Restore the webhook's backend (see the webhook issues).",
  },
  {
    pattern: /admission webhook .* denied/i,
    label: "denied by an admission webhook",
    hint: "A policy webhook rejected the pod; the message names the webhook and the rule. Fix the pod template to satisfy the policy, or change the policy.",
  },
  {
    pattern: /LimitRange|maximum .* usage per|minimum .* usage per/i,
    label: "rejected by a LimitRange",
    hint: "The pod's requests or limits are outside the namespace's LimitRange; adjust the pod template's resources or the LimitRange.",
  },
  {
    pattern: /serviceaccount .* not found/i,
    label: "ServiceAccount missing",
    hint: "The pod template's serviceAccountName does not exist in the namespace; create the ServiceAccount or fix the name.",
  },
];

/** "web-7db8d69f68" is a ReplicaSet of Deployment "web". */
function workloadOf(kind: string, name: string): string {
  if (kind !== "ReplicaSet") return name;
  return /^(.+)-[a-z0-9]{6,10}$/.exec(name)?.[1] ?? name;
}

/**
 * One issue per controller that failed to create pods. Without this, a Deployment whose
 * pods are rejected (quota, Pod Security, webhook) shows 0 ready replicas but no pod
 * issue that explains why, since there are no pods.
 */
export function podCreateFailureIssues(events: EventSummary[]): Issue[] {
  const byObject = new Map<string, EventSummary[]>();
  for (const e of events) {
    const key = `${e.involvedKind}/${e.namespace}/${e.involvedName}`;
    byObject.set(key, [...(byObject.get(key) ?? []), e]);
  }
  return [...byObject.values()].map((group) => {
    const latest = [...group].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))[0]!;
    const kind = latest.involvedKind ?? "?";
    const namespace = latest.namespace ?? "default";
    const name = latest.involvedName ?? "?";
    const message = (latest.message ?? "").replace(/^\(combined from similar events\): /, "");
    const cause = CREATE_FAILURE_CAUSES.find((c) => c.pattern.test(message));
    const count = group.reduce((sum, e) => sum + e.count, 0);
    return {
      id: `${kind.toLowerCase()}/${namespace}/${name}:create-failed`,
      severity: "critical" as const,
      category: "pod-create-failed",
      resource: { kind, namespace, name },
      title: `${kind} ${namespace}/${name} cannot create pods: ${cause?.label ?? "the API server rejected them"}`,
      evidence: [`FailedCreate x${count}, last at ${latest.lastSeen ?? "?"}: ${message.slice(0, 500)}`],
      hint: cause?.hint ?? "The event message says why the API server rejected the pod; fix the pod template or the policy it violates.",
      workload: `${namespace}/${workloadOf(kind, name)}`,
    };
  });
}
