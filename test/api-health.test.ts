import type { V1APIService, V1Namespace } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { K8sClients } from "../src/k8s/client.js";
import {
  apiServiceGroupVersion,
  apiServiceIssues,
  leaderLeaseIssues,
  terminatingNamespaceIssues,
} from "../src/scan/cluster-rules.js";
import { collectApiHealth, collectLeaderLeases } from "../src/scan/collect-cluster.js";
import { detectIssues } from "../src/scan/detect.js";
import { summarizeApiService, summarizeTerminatingNamespace } from "../src/scan/summarize.js";
import type { ApiServiceSummary, ClusterOverview, LeaderLease, TerminatingNamespace } from "../src/scan/types.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const minutesAgo = (m: number) => secondsAgo(m * 60);

const notFound = () => Object.assign(new Error("HTTP-Code: 404"), { code: 404 });

const metricsApi = (opts: Partial<ApiServiceSummary> = {}): ApiServiceSummary => ({
  name: "v1beta1.metrics.k8s.io",
  service: { namespace: "kube-system", name: "metrics-server" },
  available: false,
  reason: "MissingEndpoints",
  message: 'endpoints for service/metrics-server in "kube-system" have no addresses with port name "https"',
  since: minutesAgo(20),
  ...opts,
});

const DISCOVERY_FAILURE = {
  type: "NamespaceDeletionDiscoveryFailure",
  reason: "DiscoveryFailed",
  message:
    "Discovery failed for some groups, 1 failing: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: stale GroupVersion discovery: metrics.k8s.io/v1beta1",
};

describe("leader-election leases", () => {
  const lease = (renewedSecondsAgo: number | undefined, component = "kube-scheduler"): LeaderLease => ({
    component,
    holder: "cp-1_abc",
    renewTime: renewedSecondsAgo === undefined ? undefined : secondsAgo(renewedSecondsAgo),
    leaseDurationSeconds: 15,
  });

  it("flags a lease not renewed for longer than its duration plus slack as critical", () => {
    const [issue, ...rest] = leaderLeaseIssues([lease(600)], NOW);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      id: "controlplane/kube-scheduler:leader-stale",
      severity: "critical",
      category: "leader-election-stale",
      resource: { kind: "ControlPlane", name: "kube-scheduler" },
      title: "kube-scheduler has no active leader: its leader-election Lease was last renewed 10 min ago",
    });
    expect(issue?.evidence[0]).toBe(
      `Lease kube-system/kube-scheduler: holder cp-1_abc, last renewed 10 min ago (${secondsAgo(600)}), leaseDurationSeconds=15`,
    );
    expect(issue?.evidence[1]).toContain("nothing schedules new pods");
  });

  it("explains what stops for the controller-manager", () => {
    const [issue] = leaderLeaseIssues([lease(300, "kube-controller-manager")], NOW);
    expect(issue?.evidence[1]).toContain("controllers do not reconcile");
  });

  it("allows the lease duration plus slack (clock skew, leader handover)", () => {
    expect(leaderLeaseIssues([lease(2), lease(15 + 60, "kube-controller-manager")], NOW)).toEqual([]);
    expect(leaderLeaseIssues([lease(15 + 61)], NOW)).toHaveLength(1);
  });

  it("treats a lease that was never renewed as stale", () => {
    expect(leaderLeaseIssues([lease(undefined)], NOW)[0]?.evidence[0]).toContain("never renewed");
  });

  it("reports a missing or unreadable Lease as not visible, never as an issue", async () => {
    const k8s = {
      coordination: {
        readNamespacedLease: async ({ name }: { name: string }) => {
          if (name === "kube-scheduler") throw notFound();
          return { spec: { holderIdentity: "cm-1", renewTime: new Date(secondsAgo(3)), leaseDurationSeconds: 15 } };
        },
      },
    } as unknown as K8sClients;
    const result = await collectLeaderLeases(k8s);
    expect(result.leases).toEqual([
      { component: "kube-controller-manager", holder: "cm-1", renewTime: secondsAgo(3), leaseDurationSeconds: 15 },
    ]);
    expect(result.notVisible).toEqual([
      "kube-scheduler leader election: no Lease kube-system/kube-scheduler (managed control plane, or leader election disabled)",
    ]);
  });
});

describe("aggregated APIs", () => {
  it("summarizes only Service-backed APIServices", () => {
    const local: V1APIService = {
      metadata: { name: "v1.apps" },
      spec: { groupPriorityMinimum: 1, versionPriority: 1 },
    };
    const remote: V1APIService = {
      metadata: { name: "v1beta1.metrics.k8s.io" },
      spec: {
        groupPriorityMinimum: 100,
        versionPriority: 100,
        service: { namespace: "kube-system", name: "metrics-server" },
      },
      status: {
        conditions: [
          {
            type: "Available",
            status: "False",
            reason: "MissingEndpoints",
            message: "no addresses",
            lastTransitionTime: new Date(minutesAgo(20)),
          },
        ],
      },
    };
    expect(summarizeApiService(local)).toBeUndefined();
    expect(summarizeApiService(remote)).toEqual(metricsApi({ message: "no addresses" }));
  });

  it("names the group/version", () => {
    expect(apiServiceGroupVersion("v1beta1.metrics.k8s.io")).toBe("metrics.k8s.io/v1beta1");
    expect(apiServiceGroupVersion("v1")).toBe("v1");
  });

  it("flags an unavailable APIService as critical with its effects", () => {
    const [issue] = apiServiceIssues(metricsApi(), NOW);
    expect(issue).toMatchObject({
      id: "apiservice/v1beta1.metrics.k8s.io:unavailable",
      severity: "critical",
      category: "apiservice-unavailable",
      resource: { kind: "APIService", name: "v1beta1.metrics.k8s.io" },
      title: "Aggregated API metrics.k8s.io/v1beta1 is unavailable (MissingEndpoints)",
    });
    expect(issue?.evidence[0]).toContain("Available=False for 20 min (MissingEndpoints)");
    expect(issue?.evidence[1]).toBe("backed by Service kube-system/metrics-server");
    expect(issue?.evidence[2]).toContain("namespace deletion");
    expect(issue?.evidence[2]).toContain("kubectl top");
  });

  it("skips available APIServices and short outages", () => {
    expect(apiServiceIssues(metricsApi({ available: true }), NOW)).toEqual([]);
    expect(apiServiceIssues(metricsApi({ since: minutesAgo(2) }), NOW)).toEqual([]);
  });

  it("collects APIServices and terminating namespaces, or says what is not visible", async () => {
    const forbidden = Object.assign(new Error("HTTP-Code: 403"), { code: 403 });
    const k8s = {
      apiregistration: {
        listAPIService: async () => {
          throw forbidden;
        },
      },
      core: {
        listNamespace: async () => ({
          items: [
            { metadata: { name: "default" }, status: { phase: "Active" } },
            {
              metadata: { name: "old-app", deletionTimestamp: new Date(minutesAgo(30)) },
              spec: { finalizers: ["kubernetes"] },
              status: {
                phase: "Terminating",
                conditions: [
                  { ...DISCOVERY_FAILURE, status: "True" },
                  { type: "NamespaceContentRemaining", status: "False" },
                ],
              },
            },
          ],
        }),
      },
    } as unknown as K8sClients;
    const health = await collectApiHealth(k8s);
    expect(health.apiServices).toBeUndefined();
    expect(health.notVisible).toHaveLength(1);
    expect(health.notVisible[0]).toMatch(/^aggregated APIs \(APIServices\): /);
    expect(health.terminatingNamespaces).toEqual([
      {
        name: "old-app",
        deletionTimestamp: minutesAgo(30),
        conditions: [DISCOVERY_FAILURE],
        finalizers: ["kubernetes"],
      },
    ]);
  });
});

describe("namespaces stuck terminating", () => {
  const stuck = (opts: Partial<TerminatingNamespace> = {}): TerminatingNamespace => ({
    name: "old-app",
    deletionTimestamp: minutesAgo(30),
    conditions: [DISCOVERY_FAILURE],
    finalizers: ["kubernetes"],
    ...opts,
  });

  it("ties a namespace blocked by discovery to the unavailable APIService", () => {
    const [issue] = terminatingNamespaceIssues(stuck(), [metricsApi()], NOW);
    expect(issue).toMatchObject({
      id: "namespace/old-app:stuck-terminating",
      severity: "warning",
      category: "namespace-terminating-api",
      resource: { kind: "Namespace", name: "old-app" },
      title: "Namespace old-app is stuck Terminating for 30 min",
    });
    expect(issue?.evidence).toContain(
      "unavailable aggregated API(s): v1beta1.metrics.k8s.io; deletion waits until every API group can be listed",
    );
    expect(issue?.hint).toContain("Fix or delete that APIService");
  });

  it("treats a namespace blocked by finalizers as a separate problem", () => {
    const finalizers = stuck({
      conditions: [
        {
          type: "NamespaceFinalizersRemaining",
          reason: "SomeFinalizersRemain",
          message:
            "Some content in the namespace has finalizers remaining: example.com/cleanup in 2 resource instances",
        },
      ],
    });
    const [issue] = terminatingNamespaceIssues(finalizers, [metricsApi()], NOW);
    expect(issue?.category).toBe("namespace-terminating");
    expect(issue?.evidence.join("\n")).not.toContain("aggregated API");
    expect(issue?.hint).toContain("finalizers");
  });

  it("gives a namespace time to finish deleting", () => {
    expect(terminatingNamespaceIssues(stuck({ deletionTimestamp: minutesAgo(1) }), [], NOW)).toEqual([]);
  });

  it("ignores namespaces that are not terminating", () => {
    expect(summarizeTerminatingNamespace({ metadata: { name: "a" }, status: { phase: "Active" } } as V1Namespace)).toBe(
      undefined,
    );
  });

  it("runs from detectIssues regardless of the namespace filter, and covers the APIService's Service", () => {
    const overview: ClusterOverview = {
      context: "test",
      scannedAt: NOW.toISOString(),
      namespaceFilter: "shop",
      namespaces: ["shop"],
      nodes: [],
      pods: [],
      deployments: [],
      workloads: [],
      services: [
        {
          namespace: "kube-system",
          name: "metrics-server",
          type: "ClusterIP",
          selector: { k8s: "metrics-server" },
          readyEndpoints: 0,
          notReadyEndpoints: 0,
          pods: [],
          podLabelValues: { k8s: [] },
        },
      ],
      dns: {},
      warningEvents: [],
      podCreateFailures: [],
      controlPlane: {
        notVisible: [],
        leaderLeases: [{ component: "kube-scheduler", renewTime: secondsAgo(900), leaseDurationSeconds: 15 }],
      },
      webhooks: [],
      jobs: [],
      cronJobs: [],
      persistentVolumeClaims: [],
      storageEvents: [],
      apiHealth: { apiServices: [metricsApi()], terminatingNamespaces: [stuck()], notVisible: [] },
      errors: [],
    };
    const issues = detectIssues(overview, { restartThreshold: 5, now: NOW, windowMinutes: 60 });
    expect(issues.map((i) => i.id)).toEqual([
      "apiservice/v1beta1.metrics.k8s.io:unavailable",
      "controlplane/kube-scheduler:leader-stale",
      "namespace/old-app:stuck-terminating",
    ]);
  });
});
