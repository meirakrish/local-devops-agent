import type { Confidence } from "../agent/types.js";
import { addUsage, emptyUsage, type LlmUsage } from "../llm/model.js";
import type { Issue, Severity } from "../scan/types.js";
import { changeCounts, issueKey, type IssueChange, type PreviousIssue } from "./compare.js";
import { overallStatus, type OverallStatus, type ReportInput } from "./markdown.js";

/**
 * Machine-readable report for CI, dashboards and `--compare`. Bump the schema version on
 * breaking changes; `--compare` only reads reports of the same version.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonIssue extends Issue {
  /** Identity across runs (see issueKey); what `--compare` matches on. */
  key: string;
  /** Present when the run was compared with a previous report. */
  change?: IssueChange;
}

export interface JsonFinding {
  primaryIssueId: string;
  relatedIssueIds: string[];
  severity: Severity;
  summary?: string;
  rootCause?: string;
  evidence: string[];
  suggestedFix: string[];
  confidence?: Confidence;
  toolCalls: number;
  /** Set when the investigation failed. */
  error?: string;
}

const ratio = (ready: number, total: number) => ({ ready, total });
const ratioOf = (bound: number, total: number) => ({ bound, total });

export interface JsonReport {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  context: string;
  /** null when all namespaces were checked. */
  namespace: string | null;
  scannedAt: string;
  status: OverallStatus;
  counts: Record<Severity, number>;
  summary: {
    nodes: { ready: number; total: number };
    pods: { running: number; total: number };
    deployments: { ready: number; total: number };
    daemonSetsAndStatefulSets: { ready: number; total: number };
    services: { withoutReadyEndpoints: number; total: number };
    clusterDns: { ready: number; total: number } | null;
    controlPlanePods: { ready: number; total: number } | null;
    apiServerChecks: { passing: number; total: number } | null;
    etcd: { dbSizeBytes: number; quotaBytes: number } | null;
    apiServerCertificateExpiresAt: string | null;
    admissionWebhooks: { unreachable: number; total: number };
    recentWarningEvents: number;
    jobs: { failed: number; total: number };
    cronJobs: { suspended: number; total: number };
    persistentVolumeClaims: { bound: number; total: number };
    /** null when not visible. */
    aggregatedApis: { unavailable: number; total: number } | null;
    /** Names of namespaces being deleted; null when not visible. */
    terminatingNamespaces: string[] | null;
    /** Scheduler and controller-manager leader-election leases; null when none is visible. */
    leaderElection: { component: string; holder: string | null; renewTime: string | null }[] | null;
  };
  issues: JsonIssue[];
  findings: JsonFinding[];
  comparison: {
    previousScannedAt: string;
    new: number;
    escalated: number;
    ongoing: number;
    resolved: PreviousIssue[];
  } | null;
  notes: {
    scanErrors: string[];
    notChecked: string[];
    /** Why changes since the last run are not shown, when --compare was given. */
    comparison?: string;
    llm: { model?: string; skipped?: string; usage?: LlmUsage };
  };
}

export function buildJsonReport({
  overview,
  issues,
  ollama,
  findings = [],
  triageUsage,
  llmSkipped,
  comparison,
  comparisonNote,
}: ReportInput): JsonReport {
  const cp = overview.controlPlane;
  const apis = overview.apiHealth.apiServices;
  const dns = overview.dns.service;
  const usage = [triageUsage, ...findings.map((f) => f.usage)].reduce<LlmUsage>(
    (sum, u) => (u ? addUsage(sum, u) : sum),
    emptyUsage(),
  );
  const unreachable = overview.webhooks.filter(
    (w) => w.status === "service-missing" || w.status === "no-ready-endpoints",
  ).length;

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    context: overview.context,
    namespace: overview.namespaceFilter ?? null,
    scannedAt: overview.scannedAt,
    status: overallStatus(issues),
    counts: {
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
    summary: {
      nodes: ratio(overview.nodes.filter((n) => n.ready).length, overview.nodes.length),
      pods: { running: overview.pods.filter((p) => p.phase === "Running").length, total: overview.pods.length },
      deployments: ratio(overview.deployments.filter((d) => d.ready >= d.desired).length, overview.deployments.length),
      daemonSetsAndStatefulSets: ratio(
        overview.workloads.filter((w) => w.ready >= w.desired).length,
        overview.workloads.length,
      ),
      services: {
        withoutReadyEndpoints: overview.services.filter((s) => s.readyEndpoints === 0).length,
        total: overview.services.length,
      },
      clusterDns: dns ? ratio(dns.readyEndpoints, dns.readyEndpoints + dns.notReadyEndpoints) : null,
      controlPlanePods: cp.pods ? ratio(cp.pods.filter((p) => p.ready).length, cp.pods.length) : null,
      apiServerChecks: cp.readyz ? { passing: cp.readyz.filter((c) => c.ok).length, total: cp.readyz.length } : null,
      etcd:
        cp.etcd?.dbSizeBytes !== undefined
          ? { dbSizeBytes: cp.etcd.dbSizeBytes, quotaBytes: cp.etcd.quotaBytes }
          : null,
      apiServerCertificateExpiresAt: cp.certificate?.notAfter ?? null,
      admissionWebhooks: { unreachable, total: overview.webhooks.length },
      recentWarningEvents: overview.warningEvents.length,
      jobs: { failed: overview.jobs.filter((j) => j.failedCondition).length, total: overview.jobs.length },
      cronJobs: { suspended: overview.cronJobs.filter((c) => c.suspended).length, total: overview.cronJobs.length },
      persistentVolumeClaims: ratioOf(
        overview.persistentVolumeClaims.filter((c) => c.phase === "Bound").length,
        overview.persistentVolumeClaims.length,
      ),
      aggregatedApis: apis ? { unavailable: apis.filter((a) => !a.available).length, total: apis.length } : null,
      terminatingNamespaces: overview.apiHealth.terminatingNamespaces?.map((n) => n.name) ?? null,
      leaderElection: cp.leaderLeases
        ? cp.leaderLeases.map((l) => ({
            component: l.component,
            holder: l.holder ?? null,
            renewTime: l.renewTime ?? null,
          }))
        : null,
    },
    issues: issues.map((i) => ({
      ...i,
      key: issueKey(i),
      ...(comparison ? { change: comparison.changes[i.id] } : {}),
    })),
    findings: findings.map((f) => ({
      primaryIssueId: f.problem.primary.id,
      relatedIssueIds: f.problem.related.map((i) => i.id),
      severity: f.problem.severity,
      ...(f.error ? { error: f.error } : { summary: f.summary, rootCause: f.rootCause, confidence: f.confidence }),
      evidence: f.error ? [] : f.evidence,
      suggestedFix: f.error ? [] : f.suggestedFix,
      toolCalls: f.toolCalls,
    })),
    comparison: comparison
      ? { previousScannedAt: comparison.previousScannedAt, ...changeCounts(comparison), resolved: comparison.resolved }
      : null,
    notes: {
      scanErrors: overview.errors,
      notChecked: [
        ...cp.notVisible,
        ...overview.apiHealth.notVisible,
        ...(overview.dns.notVisible ? [`cluster DNS: ${overview.dns.notVisible}`] : []),
      ],
      ...(comparisonNote ? { comparison: comparisonNote } : {}),
      llm: {
        ...(ollama?.reachable && ollama.modelAvailable ? { model: ollama.model } : {}),
        ...(llmSkipped ? { skipped: llmSkipped } : {}),
        ...(usage.calls > 0 ? { usage } : {}),
      },
    },
  };
}
