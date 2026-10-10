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
    const out = String(
      await getTool(fakeK8s(logCalls), "k8s_get_logs").invoke({ namespace: "shop", pod: "web-1" }),
    );
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
    const out = String(
      await getTool(k8s, "k8s_get_logs").invoke({ namespace: "shop", pod: "web-1", previous: true }),
    );
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
      containerStatuses: [{ name: "nginx", image: "nginx", imageID: "", ready: true, restartCount: 0, state: { running: {} } }],
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
    const out = String(await getTool(serviceK8s({ app: "fronted" }, 80), "k8s_get_service").invoke({ namespace: "shop", name: "frontend" }));
    expect(out).toContain("Selector: app=fronted");
    expect(out).toContain("Endpoints: 0 ready, 0 not ready");
    expect(out).toContain("Pods matching the selector: (none)");
    expect(out).toContain("Label values on running pods in shop: app: frontend");
  });

  it("get_service notes a targetPort that no container declares", async () => {
    const out = String(await getTool(serviceK8s({ app: "frontend" }, 8080), "k8s_get_service").invoke({ namespace: "shop", name: "frontend" }));
    expect(out).toContain("- shop/frontend-1 Running ready=1/1");
    expect(out).toContain("Note: targetPort 8080 of port 80 is not a declared container port");
    const named = String(await getTool(serviceK8s({ app: "frontend" }, "http"), "k8s_get_service").invoke({ namespace: "shop", name: "frontend" }));
    expect(named).not.toContain("Note:");
  });

  it("get_workload shows a DaemonSet with its pods and controller events", async () => {
    const eventQueries: unknown[] = [];
    const apps = {
      readNamespacedDaemonSet: async () => ({
        metadata: { name: "log-agent", namespace: "ops" },
        spec: { selector: { matchLabels: { app: "log-agent" } }, template: { spec: { containers: [{ name: "agent", image: "agent:1" }] } } },
        status: { desiredNumberScheduled: 2, currentNumberScheduled: 2, numberReady: 1, updatedNumberScheduled: 2, numberAvailable: 1, numberMisscheduled: 0 },
      }),
    };
    const core = {
      listNamespacedPod: async () => ({ items: [] }),
      listNamespacedEvent: async (args: unknown) => {
        eventQueries.push(args);
        return {
          items: [
            { metadata: {}, involvedObject: { kind: "DaemonSet", name: "log-agent", namespace: "ops" }, reason: "FailedCreate", message: "violates PodSecurity", count: 2 },
            { metadata: {}, involvedObject: { kind: "DaemonSet", name: "other", namespace: "ops" }, reason: "FailedCreate", message: "unrelated", count: 1 },
          ],
        };
      },
    };
    const k8s = { context: "test", core, apps } as unknown as K8sClients;
    const out = String(await getTool(k8s, "k8s_get_workload").invoke({ kind: "DaemonSet", namespace: "ops", name: "log-agent" }));
    expect(out).toContain("DaemonSet ops/log-agent");
    expect(out).toContain("Pods: desired=2 current=2 ready=1");
    expect(out).toContain("DaemonSet/log-agent FailedCreate (x2): violates PodSecurity");
    expect(out).not.toContain("unrelated");
    expect(eventQueries).toEqual([{ namespace: "ops", fieldSelector: "type=Warning" }]);
  });
});
