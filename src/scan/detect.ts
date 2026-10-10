import { controlPlaneIssues, controlPlanePodIssues, webhookIssues } from "./cluster-rules.js";
import { nodeCapacityIssues, nodeIssues } from "./node-rules.js";
import { podIssues, type PodRuleOptions } from "./pod-rules.js";
import { compareSeverity } from "./severity.js";
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

  // Services behind a webhook or cluster DNS get their own, more specific rules.
  const coveredServices = new Set([
    ...overview.webhooks.flatMap((w) => (w.service ? [`${w.service.namespace}/${w.service.name}`] : [])),
    ...(overview.dns.service ? [`${overview.dns.service.namespace}/${overview.dns.service.name}`] : []),
  ]);
  // A FailedCreate event outlives the failure; skip it once its workload is fully ready.
  const fullyReady = new Set(
    [...overview.deployments, ...overview.workloads]
      .filter((w) => w.ready >= w.desired)
      .map((w) => `${w.namespace}/${w.name}`),
  );

  const issues = [
    ...controlPlaneIssues(overview.controlPlane, opts.now),
    ...cpPodIssues,
    ...overview.webhooks.flatMap(webhookIssues),
    ...overview.nodes.flatMap(nodeIssues),
    ...overview.nodes.flatMap((n) => nodeCapacityIssues(n, opts.now, overview.controlPlane.serverVersion)),
    ...overview.pods
      .flatMap((p) => podIssues(p, { ...opts, nodes: opts.nodes ?? overview.nodes }))
      .filter((i) => !coveredByControlPlane(i)),
    ...overview.deployments.flatMap(deploymentIssues),
    ...overview.workloads.flatMap(workloadIssues),
    ...overview.services
      .filter((s) => !coveredServices.has(`${s.namespace}/${s.name}`))
      .flatMap((s) => serviceIssues(s, opts.now, opts.gracePeriodMinutes)),
    ...dnsIssues(overview.dns),
    ...podCreateFailureIssues(overview.podCreateFailures).filter((i) => !i.workload || !fullyReady.has(i.workload)),
  ];
  return issues.sort(
    (a, b) => compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id),
  );
}
