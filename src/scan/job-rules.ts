import { minutesSince } from "./time.js";
import type { CronJobSummary, Issue, JobSummary } from "./types.js";

/**
 * Rules for Jobs and CronJobs, based only on Job conditions and CronJob status (no cron
 * expression parsing). A CronJob's Jobs get one issue on the CronJob, and only for its
 * most recent finished run: an old failure followed by a successful run is resolved.
 */

const key = (namespace: string, name: string) => `${namespace}/${name}`;

/** Newest first, by creation time. */
function byCreatedDesc(a: JobSummary, b: JobSummary): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

const finished = (j: JobSummary) => j.complete || j.failedCondition !== undefined;

/** "12 min ago" / "3 h ago" / "2 days ago". */
function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "unknown";
  const minutes = Math.max(0, Math.round(minutesSince(iso, now)));
  if (minutes < 120) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}

function failureText(j: JobSummary): string {
  const c = j.failedCondition!;
  const pods = `${j.failed} failed pod(s)${j.backoffLimit !== undefined ? `, backoffLimit=${j.backoffLimit}` : ""}`;
  return `Job ${j.name} failed (${c.reason ?? "Failed"}${c.message ? `: ${c.message}` : ""}; ${pods})`;
}

function failureHint(j: JobSummary, kind: "Job" | "CronJob"): string {
  const inspect = `k8s_get_workload with kind="Job" name="${j.name}" lists its pods; read the logs of a failed pod to see why it exited.`;
  if (j.failedCondition?.reason === "DeadlineExceeded") {
    return `The Job ran longer than its activeDeadlineSeconds and was stopped. ${inspect} If the work is slow but healthy, raise activeDeadlineSeconds${kind === "CronJob" ? " in the CronJob's jobTemplate" : ""}.`;
  }
  return `Its pods kept failing until the backoffLimit was reached. ${inspect}${kind === "CronJob" ? " The next scheduled run fails the same way until the cause is fixed." : ""}`;
}

/** A standalone Job (not created by a CronJob that still exists) with Failed=True. */
function failedJobIssue(j: JobSummary, now: Date): Issue {
  return {
    id: `job/${j.namespace}/${j.name}:failed`,
    severity: "warning",
    category: "job-failed",
    resource: { kind: "Job", namespace: j.namespace, name: j.name },
    title: `Job ${j.namespace}/${j.name} failed (${j.failedCondition?.reason ?? "Failed"})`,
    evidence: [
      `${failureText(j)}, ${ago(j.failedCondition?.since ?? j.createdAt, now)}`,
      `succeeded=${j.succeeded} failed=${j.failed} active=${j.active}`,
    ],
    hint: failureHint(j, "Job"),
    workload: key(j.namespace, j.name),
  };
}

function cronJobIssues(cj: CronJobSummary, jobs: JobSummary[], now: Date, graceMinutes: number): Issue[] {
  const resource = { kind: "CronJob", namespace: cj.namespace, name: cj.name };
  const workload = key(cj.namespace, cj.name);
  const lastSuccess = cj.lastSuccessfulTime ? ago(cj.lastSuccessfulTime, now) : "never (per CronJob status)";
  const latestFinished = jobs.find(finished);
  const latestFailed = latestFinished?.failedCondition ? latestFinished : undefined;

  if (cj.suspended) {
    return [
      {
        id: `cronjob/${cj.namespace}/${cj.name}:suspended`,
        severity: "info",
        category: "cronjob-suspended",
        resource,
        title: `CronJob ${cj.namespace}/${cj.name} is suspended and does not run`,
        evidence: [
          `suspend=true; schedule "${cj.schedule}"; last scheduled ${ago(cj.lastScheduleTime, now)}, last success ${lastSuccess}`,
          ...(latestFailed ? [`its most recent run failed: ${failureText(latestFailed)}`] : []),
        ],
        hint: 'If the suspension is not intentional, resume it (`kubectl patch cronjob <name> -p \'{"spec":{"suspend":false}}\'`).',
        workload,
      },
    ];
  }

  if (latestFailed) {
    const failedCount = jobs.filter((j) => j.failedCondition).length;
    const running = jobs.filter((j) => j.active > 0 && !finished(j));
    return [
      {
        id: `cronjob/${cj.namespace}/${cj.name}:last-run-failed`,
        severity: "warning",
        category: "cronjob-failed",
        resource,
        title: `CronJob ${cj.namespace}/${cj.name}: its most recent run failed (${latestFailed.failedCondition?.reason ?? "Failed"})`,
        evidence: [
          `${failureText(latestFailed)}, ${ago(latestFailed.failedCondition?.since ?? latestFailed.createdAt, now)}`,
          `${failedCount} of the ${jobs.length} Job(s) still kept for this CronJob failed; last successful run: ${lastSuccess}`,
          `schedule "${cj.schedule}"; last scheduled ${ago(cj.lastScheduleTime, now)}`,
          ...(running.length > 0 ? [`a newer run is in progress: Job ${running.map((j) => j.name).join(", ")}`] : []),
        ],
        hint: failureHint(latestFailed, "CronJob"),
        workload,
      },
    ];
  }

  // No finished Job is kept (history limits or ttlSecondsAfterFinished removed it), so
  // only the CronJob status is left. It cannot say the run failed, only that it was not
  // recorded as successful, so this stays informational.
  if (
    !latestFinished &&
    cj.active === 0 &&
    jobs.length === 0 &&
    cj.lastScheduleTime &&
    (!cj.lastSuccessfulTime || cj.lastSuccessfulTime < cj.lastScheduleTime) &&
    minutesSince(cj.lastScheduleTime, now) >= graceMinutes
  ) {
    return [
      {
        id: `cronjob/${cj.namespace}/${cj.name}:last-run-unconfirmed`,
        severity: "info",
        category: "cronjob-unconfirmed",
        resource,
        title: `CronJob ${cj.namespace}/${cj.name}: its last run is not recorded as successful`,
        evidence: [
          `last scheduled ${ago(cj.lastScheduleTime, now)}, last success ${lastSuccess}; no Job of this CronJob is kept, so the outcome is not visible`,
        ],
        hint: "Check the CronJob's events (`kubectl describe cronjob`). Raising failedJobsHistoryLimit keeps failed Jobs around for inspection.",
        workload,
      },
    ];
  }
  return [];
}

/** Jobs by the CronJob (still present) that created them, newest first. */
function jobsByCronJob(jobs: JobSummary[], cronJobs: CronJobSummary[]): Map<string, JobSummary[]> {
  const byCronJob = new Map<string, JobSummary[]>(cronJobs.map((c) => [key(c.namespace, c.name), []]));
  for (const j of jobs) {
    if (j.cronJob) byCronJob.get(key(j.namespace, j.cronJob))?.push(j);
  }
  for (const list of byCronJob.values()) list.sort(byCreatedDesc);
  return byCronJob;
}

export function jobIssues(jobs: JobSummary[], cronJobs: CronJobSummary[], now: Date, graceMinutes = 5): Issue[] {
  const byCronJob = jobsByCronJob(jobs, cronJobs);
  const standalone = jobs.filter((j) => !j.cronJob || !byCronJob.has(key(j.namespace, j.cronJob)));
  return [
    ...standalone.filter((j) => j.failedCondition).map((j) => failedJobIssue(j, now)),
    ...cronJobs.flatMap((c) => cronJobIssues(c, byCronJob.get(key(c.namespace, c.name)) ?? [], now, graceMinutes)),
  ];
}

/**
 * How the pod issues of Job pods should be treated, as "namespace/job" keys:
 * - `resolved`: Jobs whose failed pods no longer matter: the Job completed after retries,
 *   a newer run of its CronJob succeeded, or its CronJob is suspended (info at most).
 * - `workloadOf`: Jobs of a CronJob, mapped to the CronJob, so pods of every run group
 *   with the CronJob's issue.
 */
export function jobPodTreatment(
  jobs: JobSummary[],
  cronJobs: CronJobSummary[],
): { resolved: Set<string>; workloadOf: Map<string, string> } {
  const resolved = new Set<string>();
  const workloadOf = new Map<string, string>();
  const suspended = new Set(cronJobs.filter((c) => c.suspended).map((c) => key(c.namespace, c.name)));

  for (const j of jobs) if (j.complete) resolved.add(key(j.namespace, j.name));
  for (const [cronJob, list] of jobsByCronJob(jobs, cronJobs)) {
    const latestFinished = list.find(finished);
    for (const j of list) {
      workloadOf.set(key(j.namespace, j.name), cronJob);
      const superseded = latestFinished && !latestFinished.failedCondition && j !== latestFinished && finished(j);
      if (superseded || (suspended.has(cronJob) && j.active === 0)) resolved.add(key(j.namespace, j.name));
    }
  }
  return { resolved, workloadOf };
}
