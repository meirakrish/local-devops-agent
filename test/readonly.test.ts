import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { isReadOnlyOperation, readOnly, ReadOnlyViolationError } from "../src/k8s/client.js";

describe("isReadOnlyOperation", () => {
  it("allows list/read operations", () => {
    for (const op of ["listNode", "listNamespacedPod", "readNamespacedPodLog", "readNamespace"]) {
      expect(isReadOnlyOperation(op)).toBe(true);
    }
  });

  it("blocks writes, deletes, exec/attach and lookalike names", () => {
    for (const op of [
      "createNamespacedPod",
      "deleteNamespacedPod",
      "deleteCollectionNamespacedPod",
      "patchNamespacedDeployment",
      "replaceNamespacedPod",
      "connectGetNamespacedPodExec",
      "connectPostNamespacedPodAttach",
      "readonlyHack", // prefix must be followed by an uppercase letter
      "list",
    ]) {
      expect(isReadOnlyOperation(op)).toBe(false);
    }
  });
});

describe("readOnly proxy", () => {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: "https://127.0.0.1:1", skipTLSVerify: true }],
    users: [{ name: "u" }],
    contexts: [{ name: "x", cluster: "c", user: "u" }],
    currentContext: "x",
  });
  const core = readOnly(kc.makeApiClient(CoreV1Api), "CoreV1Api");

  it("exposes read methods", () => {
    expect(typeof core.listNode).toBe("function");
  });

  it("throws on mutating methods even when the type system is bypassed", () => {
    const raw = core as unknown as Record<string, unknown>;
    expect(() => raw["deleteNamespacedPod"]).toThrow(ReadOnlyViolationError);
    expect(() => raw["connectGetNamespacedPodExec"]).toThrow(ReadOnlyViolationError);
    expect(() => {
      raw["listNode"] = () => {};
    }).toThrow(ReadOnlyViolationError);
  });
});
