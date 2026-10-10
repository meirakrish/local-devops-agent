import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { K8sClients } from "../src/k8s/client.js";
import { createK8sTools } from "../src/tools/k8s-tools.js";
import { truncateMiddle } from "../src/tools/truncate.js";

describe("truncateMiddle", () => {
  it("leaves short text alone", () => {
    expect(truncateMiddle("hello", 100)).toBe("hello");
  });

  it("keeps head and tail, favors the tail, and stays within the limit", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = truncateMiddle(lines, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith("line 0\n")).toBe(true);
    expect(out.endsWith("line 499")).toBe(true);
    expect(out).toMatch(/\[\d+ characters truncated\]/);
    // Cuts at line boundaries: no partial "ine 2" fragments right after the marker.
    expect(out.split("...\n")[1]).toMatch(/^line \d+/);
  });
});

const crashingPod: V1Pod = {
  metadata: { name: "web-1", namespace: "shop" },
  spec: {
    containers: [
      {
        name: "app",
        image: "busybox:1.36",
        env: [
          { name: "LOG_LEVEL", value: "debug" },
          { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "password" } } },
        ],
      },
    ],
  },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "app",
        image: "busybox:1.36",
        imageID: "",
        ready: false,
        restartCount: 3,
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { reason: "Error", exitCode: 1 } },
      },
    ],
  },
};

function fakeK8s(logCalls: unknown[] = []): K8sClients {
  const notFound = () => Object.assign(new Error("HTTP-Code: 404"), { code: 404 });
  const core = {
    readNamespace: async ({ name }: { name: string }) => {
      if (name !== "shop") throw notFound();
      return { metadata: { name } };
    },
    listNamespace: async () => ({ items: [{ metadata: { name: "default" } }, { metadata: { name: "shop" } }] }),
    listNamespacedPod: async () => ({ items: [] }),
    readNamespacedPod: async ({ namespace, name }: { namespace: string; name: string }) => {
      if (namespace !== "shop" || name !== "web-1") throw notFound();
      return crashingPod;
    },
    listNamespacedEvent: async () => ({
      items: [
        {
          metadata: { namespace: "shop" },
          involvedObject: { kind: "Pod", name: "web-1", namespace: "shop" },
          reason: "BackOff",
          message: "Back-off restarting failed container",
          count: 4,
          lastTimestamp: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    }),
    readNamespacedPodLog: async (args: { previous?: boolean }) => {
      logCalls.push(args);
      return args.previous ? "FATAL: DATABASE_URL is not set\n" : "";
    },
  };
  return { context: "test", core, apps: {} } as unknown as K8sClients;
}

function getTool(k8s: K8sClients, name: string) {
  const t = createK8sTools(k8s, { maxChars: 4000, windowMinutes: 60 }).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("k8s tools", () => {
  it("exposes exactly the eight read-only tools", () => {
    expect(createK8sTools(fakeK8s(), { maxChars: 4000, windowMinutes: 60 }).map((t) => t.name)).toEqual([
      "k8s_list_nodes",
      "k8s_list_pods",
      "k8s_describe_pod",
      "k8s_get_logs",
      "k8s_list_events",
      "k8s_get_workload",
      "k8s_get_service",
      "k8s_cluster_health",
    ]);
  });

  it("describe_pod shows state and events but never env values", async () => {
    const out = String(await getTool(fakeK8s(), "k8s_describe_pod").invoke({ namespace: "shop", name: "web-1" }));
    expect(out).toContain("state: waiting CrashLoopBackOff");
    expect(out).toContain("last termination: Error exitCode=1");
    expect(out).toContain("LOG_LEVEL, DB_PASSWORD (from secret db)");
    expect(out).not.toContain("debug");
    expect(out).toContain("BackOff (x4)");
  });

  it("get_logs includes the previous run automatically for a restarted container", async () => {
    const logCalls: { previous?: boolean }[] = [];
    const out = String(await getTool(fakeK8s(logCalls), "k8s_get_logs").invoke({ namespace: "shop", pod: "web-1" }));
    expect(logCalls.map((c) => c.previous)).toEqual([true, false]);
    expect(out).toContain("=== previous run of app");
    expect(out).toContain("FATAL: DATABASE_URL is not set");
    expect(out).toContain("(empty)");
  });

  it("falls back to the current run when the previous run's logs are gone", async () => {
    // Between restarts the crashed run is the current one, and the run before it has
    // already been garbage-collected; the kubelet answers with this text.
    const k8s = fakeK8s();
    const core = k8s.core as unknown as Record<string, unknown>;
    core["readNamespacedPodLog"] = async (args: { previous?: boolean }) =>
      args.previous ? "unable to retrieve container logs for containerd://abc" : "FATAL: DATABASE_URL is not set\n";
    core["readNamespacedPod"] = async () => ({
      ...crashingPod,
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "app",
            image: "busybox:1.36",
            imageID: "",
            ready: false,
            restartCount: 4,
            state: { terminated: { reason: "Error", exitCode: 1 } },
          },
        ],
      },
    });
    const out = String(await getTool(k8s, "k8s_get_logs").invoke({ namespace: "shop", pod: "web-1", previous: true }));
    expect(out).toContain("unable to retrieve container logs");
    expect(out).toContain("current run of app, already exited with code 1");
    expect(out).toContain("previous run's logs are not available");
    expect(out).toContain("FATAL: DATABASE_URL is not set");
  });

  it("returns only the previous run when asked and it is available", async () => {
    const logCalls: { previous?: boolean }[] = [];
    await getTool(fakeK8s(logCalls), "k8s_get_logs").invoke({ namespace: "shop", pod: "web-1", previous: true });
    expect(logCalls.map((c) => c.previous)).toEqual([true]);
  });

  it("returns API errors as text instead of throwing", async () => {
    const out = await getTool(fakeK8s(), "k8s_describe_pod").invoke({ namespace: "shop", name: "nope" });
    expect(out).toBe('Error: "nope" not found in namespace "shop". Check the exact name with a list tool.');
  });

  it("says when a namespace does not exist and lists the real ones", async () => {
    const k8s = fakeK8s();
    const describe = await getTool(k8s, "k8s_describe_pod").invoke({ namespace: "batch", name: "web-1" });
    expect(describe).toBe('Error: namespace "batch" does not exist. Existing namespaces: default, shop');
    // An empty list in a missing namespace is an error, not "no pods".
    const list = await getTool(k8s, "k8s_list_pods").invoke({ namespace: "batch" });
    expect(list).toContain('namespace "batch" does not exist');
    expect(await getTool(k8s, "k8s_list_pods").invoke({ namespace: "shop" })).toBe("No matching pods.");
  });

  it("rejects namespace/name in a name field with a helpful message", async () => {
    await expect(
      getTool(fakeK8s(), "k8s_describe_pod").invoke({ namespace: "shop", name: "shop/web-1" }),
    ).rejects.toThrow(/without a "namespace\/" prefix/);
  });
});

describe("service and workload tools", () => {
  const frontendPod: V1Pod = {
    metadata: { name: "frontend-1", namespace: "shop", labels: { app: "frontend" } },
    spec: { containers: [{ name: "nginx", ports: [{ containerPort: 80, name: "http" }] }] },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "nginx", image: "nginx", imageID: "", ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  };

  function serviceK8s(selector: Record<string, string>, targetPort: number | string): K8sClients {
    const core = {
      readNamespacedService: async () => ({
        metadata: { name: "frontend", namespace: "shop" },
        spec: { type: "ClusterIP", clusterIP: "10.96.0.10", selector, ports: [{ port: 80, targetPort }] },
      }),
      listNamespacedPod: async () => ({ items: [frontendPod] }),
    };
    const discovery = { listNamespacedEndpointSlice: async () => ({ items: [] }) };
    return { context: "test", core, discovery, apps: {} } as unknown as K8sClients;
  }

  it("get_service shows the label values pods have when the selector matches none", async () => {
    const out = String(
      await getTool(serviceK8s({ app: "fronted" }, 80), "k8s_get_service").invoke({
        namespace: "shop",
        name: "frontend",
      }),
    );
    expect(out).toContain("Selector: app=fronted");
    expect(out).toContain("Endpoints: 0 ready, 0 not ready");
    expect(out).toContain("Pods matching the selector: (none)");
    expect(out).toContain("Label values on running pods in shop: app: frontend");
  });

  it("get_service notes a targetPort that no container declares", async () => {
    const out = String(
      await getTool(serviceK8s({ app: "frontend" }, 8080), "k8s_get_service").invoke({
        namespace: "shop",
        name: "frontend",
      }),
    );
    expect(out).toContain("- shop/frontend-1 Running ready=1/1");
    expect(out).toContain("Note: targetPort 8080 of port 80 is not a declared container port");
    const named = String(
      await getTool(serviceK8s({ app: "frontend" }, "http"), "k8s_get_service").invoke({
        namespace: "shop",
        name: "frontend",
      }),
    );
    expect(named).not.toContain("Note:");
  });

  it("get_workload shows a DaemonSet with its pods and controller events", async () => {
    const eventQueries: unknown[] = [];
    const apps = {
      readNamespacedDaemonSet: async () => ({
        metadata: { name: "log-agent", namespace: "ops" },
        spec: {
          selector: { matchLabels: { app: "log-agent" } },
          template: { spec: { containers: [{ name: "agent", image: "agent:1" }] } },
        },
        status: {
          desiredNumberScheduled: 2,
          currentNumberScheduled: 2,
          numberReady: 1,
          updatedNumberScheduled: 2,
          numberAvailable: 1,
          numberMisscheduled: 0,
        },
      }),
    };
    const core = {
      listNamespacedPod: async () => ({ items: [] }),
      listNamespacedEvent: async (args: unknown) => {
        eventQueries.push(args);
        return {
          items: [
            {
              metadata: {},
              involvedObject: { kind: "DaemonSet", name: "log-agent", namespace: "ops" },
              reason: "FailedCreate",
              message: "violates PodSecurity",
              count: 2,
            },
            {
              metadata: {},
              involvedObject: { kind: "DaemonSet", name: "other", namespace: "ops" },
              reason: "FailedCreate",
              message: "unrelated",
              count: 1,
            },
          ],
        };
      },
    };
    const k8s = { context: "test", core, apps } as unknown as K8sClients;
    const out = String(
      await getTool(k8s, "k8s_get_workload").invoke({ kind: "DaemonSet", namespace: "ops", name: "log-agent" }),
    );
    expect(out).toContain("DaemonSet ops/log-agent");
    expect(out).toContain("Pods: desired=2 current=2 ready=1");
    expect(out).toContain("DaemonSet/log-agent FailedCreate (x2): violates PodSecurity");
    expect(out).not.toContain("unrelated");
    expect(eventQueries).toEqual([{ namespace: "ops", fieldSelector: "type=Warning" }]);
  });
});

describe("job, storage and API health tools", () => {
  const ts = (iso: string) => new Date(iso);

  it("get_workload shows a CronJob with its Jobs, the newest Job's pods and Job events", async () => {
    const owner = [{ apiVersion: "batch/v1", kind: "CronJob", name: "report", uid: "1", controller: true }];
    const podQueries: unknown[] = [];
    const batch = {
      readNamespacedCronJob: async () => ({
        metadata: { name: "report", namespace: "ops" },
        spec: {
          schedule: "*/5 * * * *",
          jobTemplate: { spec: { template: { spec: { containers: [{ name: "main", image: "busybox:1.36" }] } } } },
        },
        status: { lastScheduleTime: ts("2026-01-01T11:55:00Z"), lastSuccessfulTime: ts("2026-01-01T10:00:00Z") },
      }),
      listNamespacedJob: async () => ({
        items: [
          {
            metadata: {
              name: "report-1",
              namespace: "ops",
              ownerReferences: owner,
              creationTimestamp: ts("2026-01-01T11:00:00Z"),
            },
            spec: { selector: { matchLabels: { "job-name": "report-1" } }, template: {} },
            status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
          },
          {
            metadata: {
              name: "report-2",
              namespace: "ops",
              ownerReferences: owner,
              creationTimestamp: ts("2026-01-01T11:55:00Z"),
            },
            spec: { selector: { matchLabels: { "job-name": "report-2" } }, template: {} },
            status: {
              failed: 3,
              conditions: [
                { type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "backoff limit" },
              ],
            },
          },
          { metadata: { name: "unrelated", namespace: "ops" }, spec: { template: {} }, status: {} },
        ],
      }),
    };
    const core = {
      listNamespacedPod: async (args: unknown) => {
        podQueries.push(args);
        return { items: [] };
      },
      listNamespacedEvent: async () => ({
        items: [
          {
            metadata: {},
            involvedObject: { kind: "Job", name: "report-2", namespace: "ops" },
            reason: "BackoffLimitExceeded",
            message: "Job has reached the specified backoff limit",
            count: 1,
          },
        ],
      }),
    };
    const k8s = { context: "test", core, batch, apps: {} } as unknown as K8sClients;
    const out = String(
      await getTool(k8s, "k8s_get_workload").invoke({ kind: "CronJob", namespace: "ops", name: "report" }),
    );
    expect(out).toContain('Schedule: "*/5 * * * *"');
    expect(out).toContain("Last successful: 2026-01-01T10:00:00.000Z");
    expect(out).toMatch(/- report-2: FAILED \(BackoffLimitExceeded: backoff limit\) active=0 succeeded=0 failed=3/);
    expect(out.indexOf("report-2:")).toBeLessThan(out.indexOf("report-1:"));
    expect(out).not.toContain("unrelated");
    expect(out).toContain("Newest Job: report-2");
    expect(out).toContain("Job/report-2 BackoffLimitExceeded");
    expect(podQueries).toEqual([{ namespace: "ops", labelSelector: "job-name=report-2" }]);
  });

  it("describe_pod shows a pending PVC with its missing StorageClass and events", async () => {
    const pod: V1Pod = {
      metadata: { name: "db-0", namespace: "shop" },
      spec: {
        containers: [{ name: "db" }],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }],
      },
      status: { phase: "Pending" },
    };
    const core = {
      readNamespacedPod: async () => pod,
      readNamespacedPersistentVolumeClaim: async () => ({
        metadata: { name: "data", namespace: "shop" },
        spec: { storageClassName: "nope", resources: { requests: { storage: "1Gi" } } },
        status: { phase: "Pending" },
      }),
      listNamespacedEvent: async ({ fieldSelector }: { fieldSelector: string }) => ({
        items: fieldSelector.includes("PersistentVolumeClaim")
          ? [
              {
                metadata: {},
                involvedObject: { kind: "PersistentVolumeClaim", name: "data", namespace: "shop" },
                reason: "ProvisioningFailed",
                message: 'storageclass.storage.k8s.io "nope" not found',
                count: 7,
              },
            ]
          : [],
      }),
    };
    const storage = {
      listStorageClass: async () => ({ items: [{ metadata: { name: "standard" }, provisioner: "x" }] }),
    };
    const k8s = { context: "test", core, storage, apps: {} } as unknown as K8sClients;
    const out = String(await getTool(k8s, "k8s_describe_pod").invoke({ namespace: "shop", name: "db-0" }));
    expect(out).toContain("PersistentVolumeClaims:\n- data: Pending storageClass=nope size=1Gi");
    expect(out).toContain('problem: StorageClass "nope" does not exist (existing: standard)');
    expect(out).toContain(
      'PersistentVolumeClaim/data ProvisioningFailed (x7): storageclass.storage.k8s.io "nope" not found',
    );
  });

  it("cluster_health shows aggregated APIs, stuck namespaces and leader leases", async () => {
    const recent = new Date(Date.now() - 3000);
    const k8s = {
      context: "test",
      raw: { get: async () => ({ status: 403, body: "" }) },
      core: {
        listNamespacedPod: async () => ({ items: [] }),
        listNamespacedEvent: async () => ({ items: [] }),
        listNamespace: async () => ({
          items: [
            {
              metadata: { name: "old-app", deletionTimestamp: ts("2026-01-01T11:00:00Z") },
              status: {
                phase: "Terminating",
                conditions: [
                  {
                    type: "NamespaceDeletionDiscoveryFailure",
                    status: "True",
                    reason: "DiscoveryFailed",
                    message: "metrics.k8s.io/v1beta1: stale",
                  },
                ],
              },
            },
          ],
        }),
      },
      coordination: {
        readNamespacedLease: async ({ name }: { name: string }) => ({
          spec: { holderIdentity: `${name}-cp`, renewTime: recent, leaseDurationSeconds: 15 },
        }),
      },
      apiregistration: {
        listAPIService: async () => ({
          items: [
            { metadata: { name: "v1.apps" }, spec: {} },
            {
              metadata: { name: "v1beta1.metrics.k8s.io" },
              spec: { service: { namespace: "kube-system", name: "metrics-server" } },
              status: {
                conditions: [
                  { type: "Available", status: "False", reason: "MissingEndpoints", message: "no addresses" },
                ],
              },
            },
          ],
        }),
      },
    } as unknown as K8sClients;
    const health = getTool(k8s, "k8s_cluster_health");
    const apis = String(await health.invoke({ section: "apiservices" }));
    expect(apis).toContain("Aggregated APIs (APIServices backed by a Service): 1, 1 unavailable");
    expect(apis).toContain(
      "- v1beta1.metrics.k8s.io (metrics.k8s.io/v1beta1) service=kube-system/metrics-server UNAVAILABLE (MissingEndpoints): no addresses",
    );
    expect(apis).toContain("- old-app deleting since 2026-01-01T11:00:00.000Z");
    expect(apis).toContain("NamespaceDeletionDiscoveryFailure (DiscoveryFailed): metrics.k8s.io/v1beta1: stale");
    expect(apis).not.toContain("Leader election");
    const cp = String(await health.invoke({ section: "control-plane" }));
    expect(cp).toMatch(/- kube-scheduler: holder=kube-scheduler-cp renewed \ds ago \(leaseDurationSeconds=15\)/);
    expect(cp).not.toContain("Aggregated APIs");
  });
});
