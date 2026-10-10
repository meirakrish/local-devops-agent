import { byNewest } from "./summarize.js";
import { minutesSince } from "./time.js";
import type { EventSummary, Issue, PodSummary, PvcSummary } from "./types.js";

/**
 * Rules for storage: PersistentVolumeClaims that do not bind, and pods that cannot start
 * because a volume cannot be attached or mounted. Storage issues carry the workload of the
 * pods that use the volume, so triage groups them with those pods.
 */

const isLive = (p: PodSummary) => p.phase !== "Succeeded" && p.phase !== "Failed";

/** "namespace/workload" when every pod belongs to the same workload. */
function singleWorkload(namespace: string, pods: PodSummary[]): string | undefined {
  const names = [...new Set(pods.map((p) => p.workload).filter((w): w is string => w !== undefined))];
  return names.length === 1 ? `${namespace}/${names[0]}` : undefined;
}

const clean = (message: string | undefined) =>
  (message ?? "").replace(/^\(combined from similar events\): /, "").slice(0, 400);

function eventEvidence(e: EventSummary, now: Date): string {
  return `${e.reason} x${e.count}, last ${Math.max(0, Math.round(minutesSince(e.lastSeen, now)))} min ago: ${clean(e.message)}`;
}

export function pvcIssues(
  pvc: PvcSummary,
  pods: PodSummary[],
  events: EventSummary[],
  now: Date,
  graceMinutes = 5,
): Issue[] {
  const { namespace, name } = pvc;
  const users = pods.filter((p) => p.namespace === namespace && isLive(p) && p.claims?.includes(name));
  const resource = { kind: "PersistentVolumeClaim", namespace, name };
  const workload = singleWorkload(namespace, users);
  const usedBy =
    users.length > 0
      ? `used by pod(s) ${users
          .slice(0, 5)
          .map((p) => p.name)
          .join(", ")}${users.length > 5 ? ` and ${users.length - 5} more` : ""}, which cannot start without it`
      : "not used by any pod";

  if (pvc.phase === "Lost") {
    return [
      {
        id: `pvc/${namespace}/${name}:lost`,
        severity: "critical",
        category: "pvc-lost",
        resource,
        title: `PersistentVolumeClaim ${namespace}/${name} is Lost: its volume is gone`,
        evidence: [`phase=Lost; bound PersistentVolume ${pvc.volumeName ?? "?"} no longer exists`, usedBy],
        hint: "The PersistentVolume behind the claim was deleted, so its data may be gone. Restore the volume (from a backup or snapshot) as a PersistentVolume with the same name, or delete and recreate the claim if the data is not needed.",
        workload,
      },
    ];
  }

  if (pvc.phase !== "Pending" || minutesSince(pvc.createdAt, now) < graceMinutes) return [];
  // WaitForFirstConsumer: a claim no pod uses yet stays Pending by design.
  if (pvc.waitForFirstConsumer && users.length === 0 && !pvc.storageClassProblem) return [];

  const provisioning = events
    .filter(
      (e) =>
        e.reason === "ProvisioningFailed" &&
        e.involvedKind === "PersistentVolumeClaim" &&
        e.namespace === namespace &&
        e.involvedName === name,
    )
    .sort(byNewest)[0];
  const minutes = Math.round(minutesSince(pvc.createdAt, now));
  const evidence = [
    `Pending for ${Number.isFinite(minutes) ? `${minutes} min` : "an unknown time"} (storageClass ${pvc.storageClass ?? "(none)"}${pvc.requested ? `, requests ${pvc.requested}` : ""})`,
    ...(pvc.storageClassProblem ? [pvc.storageClassProblem] : []),
    ...(provisioning ? [eventEvidence(provisioning, now)] : []),
    usedBy,
  ];
  const hint = pvc.storageClassProblem?.includes("does not exist")
    ? "Create the missing StorageClass, or recreate the claim with an existing storageClassName (it cannot be changed on an existing claim; StatefulSet claims come from volumeClaimTemplates)."
    : pvc.storageClassProblem
      ? "Nothing can provision this claim: create a matching PersistentVolume, set a default StorageClass, or recreate the claim with a storageClassName."
      : provisioning
        ? "The provisioner says why it cannot create the volume (see the ProvisioningFailed message); fix the StorageClass parameters, quota or credentials it names."
        : "No volume was provisioned or bound. Check that the StorageClass's provisioner (CSI controller) is running, and that a PersistentVolume matching the requested size and access mode can be created.";
  return [
    {
      id: `pvc/${namespace}/${name}:pending`,
      severity: users.length > 0 ? "critical" : "warning",
      category: "pvc-pending",
      resource,
      title: `PersistentVolumeClaim ${namespace}/${name} is not bound${pvc.storageClassProblem ? `: ${pvc.storageClassProblem}` : ""}`,
      evidence,
      hint,
      workload,
    },
  ];
}

const MOUNT_REASONS = new Set(["FailedMount", "FailedAttachVolume"]);

/** Known volume mount/attach failures, most specific first. */
const MOUNT_CAUSES: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /(configmap|secret)s? "?[^"\s]*"? not found/i,
    hint: "A ConfigMap or Secret mounted as a volume does not exist in the namespace. Create it, fix the name in the pod template, or mark the volume optional.",
  },
  {
    pattern: /Multi-Attach/i,
    hint: "The volume is still attached to another node (ReadWriteOnce allows one node). It usually clears once the old pod is gone; if not, look for a pod stuck terminating on the other node or a stale VolumeAttachment.",
  },
  {
    pattern: /persistentvolumeclaim "?[^"\s]*"? not found/i,
    hint: "The pod references a PersistentVolumeClaim that does not exist; create it or fix the claim name.",
  },
];

/**
 * A pod stuck before its containers start (Pending, usually ContainerCreating) with
 * FailedMount or FailedAttachVolume events: the events explain what the generic
 * "Pending" rule cannot.
 */
export function podVolumeIssues(pod: PodSummary, events: EventSummary[], now: Date, graceMinutes = 5): Issue[] {
  if (pod.phase !== "Pending" || pod.unschedulable) return [];
  if (minutesSince(pod.createdAt, now) < graceMinutes) return [];
  const mine = events
    .filter(
      (e) =>
        MOUNT_REASONS.has(e.reason ?? "") &&
        e.involvedKind === "Pod" &&
        e.namespace === pod.namespace &&
        e.involvedName === pod.name,
    )
    .sort(byNewest);
  if (mine.length === 0) return [];

  // The newest event of each reason (`mine` is newest first).
  const latestPerReason = mine.filter((e, i) => mine.findIndex((x) => x.reason === e.reason) === i);
  const latest = mine[0]!;
  const cause = MOUNT_CAUSES.find((c) => c.pattern.test(latest.message ?? ""));
  return [
    {
      id: `pod/${pod.namespace}/${pod.name}:volume-mount-failed`,
      severity: "critical",
      category: "volume-mount-failed",
      resource: { kind: "Pod", namespace: pod.namespace, name: pod.name },
      title: `Pod ${pod.namespace}/${pod.name} cannot start: a volume cannot be ${latest.reason === "FailedAttachVolume" ? "attached" : "mounted"}`,
      evidence: [
        ...latestPerReason.map((e) => eventEvidence(e, now)),
        ...(pod.claims ? [`PersistentVolumeClaims: ${pod.claims.join(", ")}`] : []),
      ],
      hint:
        cause?.hint ??
        "Check that the pod's PersistentVolumeClaims are Bound and that the storage (CSI) driver runs on the pod's node; the event message names the volume and the error.",
      workload: pod.workload ? `${pod.namespace}/${pod.workload}` : undefined,
    },
  ];
}
