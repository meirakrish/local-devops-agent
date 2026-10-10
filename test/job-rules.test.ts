import type { V1CronJob, V1Job } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { detectIssues } from "../src/scan/detect.js";
import { jobIssues, jobPodTreatment } from "../src/scan/job-rules.js";
import { summarizeCronJob, summarizeJob } from "../src/scan/summarize.js";
import type { ClusterOverview, CronJobSummary, JobSummary, PodSummary } from "../src/scan/types.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function job(name: string, opts: Partial<JobSummary> & { createdMinutesAgo?: number } = {}): JobSummary {
  const { createdMinutesAgo = 30, ...rest } = opts;
  return {
    namespace: "ops",
    name,
    createdAt: minutesAgo(createdMinutesAgo),
    active: 0,
    succeeded: 0,
    failed: 0,
    complete: false,
    ...rest,
  };
}

const failed = (reason = "BackoffLimitExceeded", message = "Job has reached the specified backoff limit") => ({
  failedCondition: { reason, message, since: minutesAgo(10) },
  failed: 3,
  backoffLimit: 2,
});

function cronJob(name: string, opts: Partial<CronJobSummary> = {}): CronJobSummary {
  return { namespace: "ops", name, schedule: "*/5 * * * *", suspended: false, active: 0, ...opts };
}

describe("summarizeJob / summarizeCronJob", () => {
  it("reads the Failed condition, counts and the owning CronJob", () => {
    const raw: V1Job = {
      metadata: {
        name: "report-29400",
        namespace: "ops",
        creationTimestamp: new Date(minutesAgo(20)),
        ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "report", uid: "1", controller: true }],
      },
      spec: { backoffLimit: 2, template: {} },
      status: {
        failed: 3,
        conditions: [
          { type: "FailureTarget", status: "True", reason: "BackoffLimitExceeded" },
          {
            type: "Failed",
            status: "True",
            reason: "BackoffLimitExceeded",
            message: "Job has reached the specified backoff limit",
            lastTransitionTime: new Date(minutesAgo(15)),
          },
        ],
      },
    };
    expect(summarizeJob(raw)).toEqual({
      namespace: "ops",
      name: "report-29400",
      cronJob: "report",
      createdAt: minutesAgo(20),
      completionTime: undefined,
      active: 0,
      succeeded: 0,
      failed: 3,
      complete: false,
      failedCondition: {
        reason: "BackoffLimitExceeded",
        message: "Job has reached the specified backoff limit",
        since: minutesAgo(15),
      },
      backoffLimit: 2,
    });
  });

  it("reads schedule, suspension and last run times of a CronJob", () => {
    const raw: V1CronJob = {
      metadata: { name: "report", namespace: "ops" },
      spec: { schedule: "0 * * * *", suspend: true, jobTemplate: {} },
      status: { lastScheduleTime: new Date(minutesAgo(60)), active: [{ name: "x" }] },
    };
    expect(summarizeCronJob(raw)).toEqual({
      namespace: "ops",
      name: "report",
      schedule: "0 * * * *",
      suspended: true,
      lastScheduleTime: minutesAgo(60),
      lastSuccessfulTime: undefined,
      active: 1,
    });
  });
});

describe("Job rules", () => {
  it("flags a failed standalone Job with its reason and ties it to the Job's pods", () => {
    const [issue, ...rest] = jobIssues([job("migrate", failed())], [], NOW);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      id: "job/ops/migrate:failed",
      severity: "warning",
      category: "job-failed",
      resource: { kind: "Job", namespace: "ops", name: "migrate" },
      title: "Job ops/migrate failed (BackoffLimitExceeded)",
      workload: "ops/migrate",
    });
    expect(issue?.evidence[0]).toBe(
      "Job migrate failed (BackoffLimitExceeded: Job has reached the specified backoff limit; 3 failed pod(s), backoffLimit=2), 10 min ago",
    );
    expect(issue?.hint).toContain("backoffLimit");
  });

  it("explains a DeadlineExceeded failure", () => {
    const [issue] = jobIssues(
      [job("slow", failed("DeadlineExceeded", "Job was active longer than specified deadline"))],
      [],
      NOW,
    );
    expect(issue?.title).toContain("DeadlineExceeded");
    expect(issue?.hint).toContain("activeDeadlineSeconds");
  });

  it("ignores Jobs that completed, are running or have not failed", () => {
    const jobs = [job("done", { complete: true, succeeded: 1, failed: 2 }), job("running", { active: 1 }), job("new")];
    expect(jobIssues(jobs, [], NOW)).toEqual([]);
  });

  it("treats a Job whose CronJob no longer exists as standalone", () => {
    const issues = jobIssues([job("gone-123", { ...failed(), cronJob: "gone" })], [], NOW);
    expect(issues.map((i) => i.id)).toEqual(["job/ops/gone-123:failed"]);
  });
});

describe("CronJob rules", () => {
  it("flags a CronJob whose most recent run failed, once, on the CronJob", () => {
    const jobs = [
      job("report-1", { cronJob: "report", complete: true, succeeded: 1, createdMinutesAgo: 70 }),
      job("report-2", { cronJob: "report", ...failed(), createdMinutesAgo: 10 }),
    ];
    const issues = jobIssues(jobs, [cronJob("report", { lastSuccessfulTime: minutesAgo(65) })], NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "cronjob/ops/report:last-run-failed",
      severity: "warning",
      category: "cronjob-failed",
      resource: { kind: "CronJob", namespace: "ops", name: "report" },
      workload: "ops/report",
    });
    expect(issues[0]?.evidence[0]).toContain("Job report-2 failed (BackoffLimitExceeded");
    expect(issues[0]?.evidence[1]).toBe(
      "1 of the 2 Job(s) still kept for this CronJob failed; last successful run: 65 min ago",
    );
  });

  it("keeps the same id when the failing Job changes, so --compare sees one ongoing issue", () => {
    const run = (name: string) =>
      jobIssues([job(name, { cronJob: "report", ...failed() })], [cronJob("report")], NOW)[0]?.id;
    expect(run("report-100")).toBe(run("report-200"));
  });

  it("does not flag an old failure once a newer run succeeded", () => {
    const jobs = [
      job("report-1", { cronJob: "report", ...failed(), createdMinutesAgo: 70 }),
      job("report-2", { cronJob: "report", complete: true, succeeded: 1, createdMinutesAgo: 10 }),
    ];
    expect(jobIssues(jobs, [cronJob("report")], NOW)).toEqual([]);
  });

  it("still flags the last finished failure while a newer run is in progress", () => {
    const jobs = [
      job("report-1", { cronJob: "report", ...failed(), createdMinutesAgo: 20 }),
      job("report-2", { cronJob: "report", active: 1, createdMinutesAgo: 1 }),
    ];
    const [issue] = jobIssues(jobs, [cronJob("report", { active: 1 })], NOW);
    expect(issue?.evidence).toContain("a newer run is in progress: Job report-2");
  });

  it("reports a suspended CronJob as info only, even when its last run failed", () => {
    const jobs = [job("report-1", { cronJob: "report", ...failed() })];
    const issues = jobIssues(jobs, [cronJob("report", { suspended: true })], NOW);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([["cronjob/ops/report:suspended", "info"]]);
    expect(issues[0]?.evidence[1]).toContain("its most recent run failed");
  });

  it("uses CronJob status when no Job is kept, as info since the outcome is not visible", () => {
    const unconfirmed = cronJob("cleanup", { lastScheduleTime: minutesAgo(30), lastSuccessfulTime: minutesAgo(90) });
    expect(jobIssues([], [unconfirmed], NOW).map((i) => [i.id, i.severity])).toEqual([
      ["cronjob/ops/cleanup:last-run-unconfirmed", "info"],
    ]);
    // Not when the last run succeeded, is running, or was scheduled moments ago.
    const fine = [
      cronJob("a", { lastScheduleTime: minutesAgo(30), lastSuccessfulTime: minutesAgo(29) }),
      cronJob("b", { lastScheduleTime: minutesAgo(30), active: 1 }),
      cronJob("c", { lastScheduleTime: minutesAgo(1) }),
      cronJob("d"),
    ];
    expect(jobIssues([], fine, NOW)).toEqual([]);
  });
});

describe("Job pods", () => {
  it("resolves pods of completed Jobs and of failures a newer run fixed; maps CronJob Jobs to the CronJob", () => {
    const jobs = [
      job("migrate", { complete: true, succeeded: 1, failed: 1 }),
      job("report-1", { cronJob: "report", ...failed(), createdMinutesAgo: 70 }),
      job("report-2", { cronJob: "report", complete: true, createdMinutesAgo: 10 }),
      job("sync-1", { cronJob: "sync", ...failed() }),
    ];
    const { resolved, workloadOf } = jobPodTreatment(jobs, [cronJob("report"), cronJob("sync")]);
    expect([...resolved].sort()).toEqual(["ops/migrate", "ops/report-1", "ops/report-2"]);
    expect(workloadOf.get("ops/sync-1")).toBe("ops/sync");
  });

  const base: ClusterOverview = {
    context: "test",
    scannedAt: NOW.toISOString(),
    namespaces: ["ops"],
    nodes: [],
    pods: [],
    deployments: [],
    workloads: [],
    services: [],
    dns: {},
    warningEvents: [],
    podCreateFailures: [],
    controlPlane: { notVisible: [] },
    webhooks: [],
    jobs: [],
    cronJobs: [],
    persistentVolumeClaims: [],
    storageEvents: [],
    apiHealth: { notVisible: [] },
    errors: [],
  };
  const failedPod = (name: string, jobName: string): PodSummary => ({
    namespace: "ops",
    name,
    phase: "Failed",
    owner: { kind: "Job", name: jobName },
    workload: jobName,
    createdAt: minutesAgo(30),
    readyContainers: 0,
    totalContainers: 1,
    restarts: 0,
    containers: [
      { name: "main", init: false, ready: false, restarts: 0, state: "terminated", reason: "Error", exitCode: 1 },
    ],
    requests: {},
  });

  it("groups failed pods with their CronJob and drops pods of resolved Jobs", () => {
    const issues = detectIssues(
      {
        ...base,
        jobs: [
          job("report-1", { cronJob: "report", ...failed() }),
          job("migrate", { complete: true, succeeded: 1, failed: 1 }),
        ],
        cronJobs: [cronJob("report")],
        pods: [failedPod("report-1-abcde", "report-1"), failedPod("migrate-xyz12", "migrate")],
      },
      { restartThreshold: 5, now: NOW, windowMinutes: 60 },
    );
    expect(issues.map((i) => [i.id, i.workload])).toEqual([
      ["cronjob/ops/report:last-run-failed", "ops/report"],
      ["pod/ops/report-1-abcde:pod-failed", "ops/report"],
    ]);
  });
});
