import {
  apiServiceIssues,
  controlPlaneIssues,
  controlPlanePodIssues,
  leaderLeaseIssues,
  terminatingNamespaceIssues,
  webhookIssues,
} from "./cluster-rules.js";
import { jobIssues, jobPodTreatment } from "./job-rules.js";
import { nodeCapacityIssues, nodeIssues } from "./node-rules.js";
import { podIssues, type PodRuleOptions } from "./pod-rules.js";
import { compareSeverity } from "./severity.js";
import { podVolumeIssues, pvcIssues } from "./storage-rules.js";
import type { ClusterOverview, Issue } from "./types.js";
import {
  deploymentIssues,
  dnsIssues,
  podCreateFailureIssues,
  serviceIssues,
  workloadIssues,
} from "./workload-rules.js";

/**
 * Deterministic, rule-based problem detection: runs every rule over a cluster overview.
 * The issues found here decide severity and the exit code, and are the candidates the
 * LLM triage step chooses from.
 */

export interface RuleOptions extends PodRuleOptions {
  /** How far back restarts and probe failures count as recent (EVENT_WINDOW_MINUTES). */
  windowMinutes: number;
}

export function detectIssues(overview: ClusterOverview, opts: RuleOptions): Issue[] {
  const cpPodIssues = controlPlanePodIssues(overview.controlPlane.pods ?? [], opts.now, opts.windowMinutes);
  // A control-plane pod gets one issue from the control-plane rule, which includes its
  // current state, instead of a second one from the generic pod rules.
  const covered = new Set(cpPodIssues.map((i) => i.resource.name));
  const coveredByControlPlane = (i: Issue) =>
    i.resource.kind === "Pod" && i.resource.namespace === "kube-system" && covered.has(i.resource.name);

  // Services behind a webhook, an aggregated API or cluster DNS get their own, more specific rules.
  const apiServices = overview.apiHealth.apiServices ?? [];
  const coveredServices = new Set([
    ...overview.webhooks.flatMap((w) => (w.service ? [`${w.service.namespace}/${w.service.name}`] : [])),
    ...apiServices.filter((a) => !a.available).map((a) => `${a.service.namespace}/${a.service.name}`),
    ...(overview.dns.service ? [`${overview.dns.service.namespace}/${overview.dns.service.name}`] : []),
  ]);
  // A FailedCreate event outlives the failure; skip it once its workload is fully ready.
  const fullyReady = new Set(
    [...overview.deployments, ...overview.workloads]
      .filter((w) => w.ready >= w.desired)
      .map((w) => `${w.namespace}/${w.name}`),
  );

  const grace = opts.gracePeriodMinutes;
  const apiIssues = apiServices.flatMap((a) => apiServiceIssues(a, opts.now, grace));
  const unavailableApis = apiServices.filter((a) => apiIssues.some((i) => i.resource.name === a.name));

  // A pod stuck on a volume gets the storage explanation instead of the generic "pending".
  const volumeIssues = overview.pods.flatMap((p) => podVolumeIssues(p, overview.storageEvents, opts.now, grace));
  const stuckOnVolume = new Set(volumeIssues.map((i) => `${i.resource.namespace}/${i.resource.name}`));
  // Failed pods of a Job that later succeeded (or whose CronJob ran successfully since)
  // are resolved; pods of a CronJob's Jobs belong to the CronJob.
  const jobPods = jobPodTreatment(overview.jobs, overview.cronJobs);
  const podIssuesFor = (p: (typeof overview.pods)[number]): Issue[] => {
    if (p.workload && jobPods.resolved.has(`${p.namespace}/${p.workload}`)) return [];
    const found = podIssues(p, { ...opts, nodes: opts.nodes ?? overview.nodes }).filter(
      (i) => !(i.category === "pending" && stuckOnVolume.has(`${p.namespace}/${p.name}`)),
    );
    const cronJob = p.workload ? jobPods.workloadOf.get(`${p.namespace}/${p.workload}`) : undefined;
    return cronJob ? found.map((i) => ({ ...i, workload: cronJob })) : found;
  };

  const issues = [
    ...controlPlaneIssues(overview.controlPlane, opts.now),
    ...leaderLeaseIssues(overview.controlPlane.leaderLeases ?? [], opts.now),
    ...apiIssues,
    ...(overview.apiHealth.terminatingNamespaces ?? []).flatMap((n) =>
      terminatingNamespaceIssues(n, unavailableApis, opts.now, grace),
    ),
    ...cpPodIssues,
    ...overview.webhooks.flatMap(webhookIssues),
    ...overview.nodes.flatMap(nodeIssues),
    ...overview.nodes.flatMap((n) => nodeCapacityIssues(n, opts.now, overview.controlPlane.serverVersion)),
    ...overview.pods.flatMap(podIssuesFor).filter((i) => !coveredByControlPlane(i)),
    ...volumeIssues,
    ...overview.persistentVolumeClaims.flatMap((c) =>
      pvcIssues(c, overview.pods, overview.storageEvents, opts.now, grace),
    ),
    ...jobIssues(overview.jobs, overview.cronJobs, opts.now, grace),
    ...overview.deployments.flatMap(deploymentIssues),
    ...overview.workloads.flatMap(workloadIssues),
    ...overview.services
      .filter((s) => !coveredServices.has(`${s.namespace}/${s.name}`))
      .flatMap((s) => serviceIssues(s, opts.now, opts.gracePeriodMinutes)),
    ...dnsIssues(overview.dns),
    ...podCreateFailureIssues(overview.podCreateFailures).filter((i) => !i.workload || !fullyReady.has(i.workload)),
  ];
  return issues.sort((a, b) => compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id));
}
