import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseContexts, pathForContext, safeFileName, shouldFail } from "../src/cli-support.js";
import { createK8sClients } from "../src/k8s/client.js";
import type { JsonIssue, JsonReport } from "../src/report/json.js";

describe("context list", () => {
  it("accepts comma-separated and repeated values, without duplicates", () => {
    expect(parseContexts(["kind-a, kind-b", "prod", "kind-a", ""])).toEqual(["kind-a", "kind-b", "prod"]);
    expect(parseContexts(undefined)).toEqual([]);
  });

  it("makes context names safe for file names", () => {
    expect(safeFileName("arn:aws:eks:eu-west-1:123456789012:cluster/prod")).toBe(
      "arn_aws_eks_eu-west-1_123456789012_cluster_prod",
    );
    expect(safeFileName("kind-devops-agent-demo")).toBe("kind-devops-agent-demo");
  });

  it("fills {context} in paths and requires it with several contexts", () => {
    expect(pathForContext("reports/{context}.json", "gke_p_z/c", true)).toBe("reports/gke_p_z_c.json");
    expect(pathForContext("reports/latest.json", "kind-a", false)).toBe("reports/latest.json");
    expect(() => pathForContext("reports/latest.json", "kind-a", true)).toThrow(/must contain \{context\}/);
  });
});

describe("--fail-on", () => {
  const issue = (severity: JsonIssue["severity"], change?: JsonIssue["change"]): JsonIssue => ({
    id: `x:${severity}:${change}`,
    key: "k",
    severity,
    category: "c",
    resource: { kind: "Pod", name: "p" },
    title: "t",
    evidence: [],
    ...(change ? { change } : {}),
  });
  const report = (issues: JsonIssue[], compared: boolean) =>
    ({
      issues,
      comparison: compared ? { previousScannedAt: "t", new: 0, escalated: 0, ongoing: 0, resolved: [] } : null,
    }) as unknown as JsonReport;

  it('"critical" fails on any critical issue', () => {
    expect(shouldFail(report([issue("critical", "ongoing")], true), "critical")).toBe(true);
    expect(shouldFail(report([issue("warning", "new")], true), "critical")).toBe(false);
  });

  it('"new" fails only on critical issues that are new or escalated', () => {
    expect(shouldFail(report([issue("critical", "ongoing"), issue("warning", "new")], true), "new")).toBe(false);
    expect(shouldFail(report([issue("critical", "new")], true), "new")).toBe(true);
    expect(shouldFail(report([issue("critical", "escalated")], true), "new")).toBe(true);
  });

  it('"new" without a comparison treats every critical issue as new', () => {
    expect(shouldFail(report([issue("critical")], false), "new")).toBe(true);
    expect(shouldFail(report([issue("warning")], false), "new")).toBe(false);
  });
});

describe("kubeconfig contexts", () => {
  const kubeconfig = (name: string, server: string) => `apiVersion: v1
kind: Config
current-context: ${name}
clusters:
- name: ${name}
  cluster: { server: "${server}" }
users:
- name: ${name}
  user: { token: "t" }
contexts:
- name: ${name}
  context: { cluster: ${name}, user: ${name} }
`;
  const dir = mkdtempSync(join(tmpdir(), "kubeconfig-"));
  const a = join(dir, "a.yaml");
  const b = join(dir, "b.yaml");
  writeFileSync(a, kubeconfig("kind-a", "https://a.example:6443"));
  writeFileSync(b, kubeconfig("kind-b", "https://b.example:6443"));
  const both = [a, b].join(delimiter);

  it("merges a KUBECONFIG list like kubectl: the first file's current context wins", () => {
    expect(createK8sClients(both).context).toBe("kind-a");
  });

  it("selects another context from the merged files", () => {
    expect(createK8sClients(both, "kind-b").context).toBe("kind-b");
  });

  it("rejects an unknown context and lists the known ones", () => {
    expect(() => createK8sClients(both, "prod")).toThrow(
      'unknown kube context "prod". Contexts in the kubeconfig: kind-a, kind-b',
    );
  });
});
