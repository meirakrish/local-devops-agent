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
  const t = createK8sTools(k8s, { maxChars: 4000 }).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("k8s tools", () => {
  it("exposes exactly the six read-only tools", () => {
    expect(createK8sTools(fakeK8s(), { maxChars: 4000 }).map((t) => t.name)).toEqual([
      "k8s_list_nodes",
      "k8s_list_pods",
      "k8s_describe_pod",
      "k8s_get_logs",
      "k8s_list_events",
      "k8s_get_deployment",
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
