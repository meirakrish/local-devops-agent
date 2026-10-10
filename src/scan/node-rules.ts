import { parseMinorVersion } from "./apiserver-parse.js";
import { formatCpu, formatMemory, formatPercent, parseQuantity } from "./quantity.js";
import type { Issue, NodeSummary } from "./types.js";

/** Rules for nodes: readiness, pressure, kubelet heartbeat, requested capacity and version skew. */

export const NODE_THRESHOLDS = {
  /** Kubelets renew their Lease every ~10s; the node controller reacts after ~50s. */
  heartbeatStaleSeconds: 60,
  nodeRequestRatio: 0.9,
  /** Supported skew: kubelet may be up to 3 minor versions older, never newer. */
  maxKubeletMinorsBehind: 3,
};

export function nodeIssues(node: NodeSummary): Issue[] {
  const issues: Issue[] = [];
  const resource = { kind: "Node", name: node.name };
  if (!node.ready) {
    issues.push({
      id: `node/${node.name}:not-ready`,
      severity: "critical",
      category: "node-not-ready",
      resource,
      title: `Node ${node.name} is NotReady`,
      evidence: [node.readyMessage ?? "Ready condition is not True"],
      hint: "Check kubelet / container runtime on the node and its conditions (`kubectl describe node`).",
    });
  }
  if (node.pressures.length > 0) {
    issues.push({
      id: `node/${node.name}:pressure`,
      severity: "warning",
      category: "node-pressure",
      resource,
      title: `Node ${node.name} reports ${node.pressures.join(", ")}`,
      evidence: node.pressures.map((p) => `${p}=True`),
      hint: "Look for pods using excessive memory/disk on this node; pods may be evicted.",
    });
  }
  if (node.unschedulable) {
    issues.push({
      id: `node/${node.name}:cordoned`,
      severity: "info",
      category: "node-cordoned",
      resource,
      title: `Node ${node.name} is cordoned (unschedulable)`,
      evidence: ["spec.unschedulable=true"],
      hint: "Expected during maintenance; uncordon when done.",
    });
  }
  return issues;
}

export function nodeCapacityIssues(node: NodeSummary, now: Date, serverVersion?: string): Issue[] {
  const issues: Issue[] = [];
  const resource = { kind: "Node", name: node.name };

  if (node.heartbeat) {
    const ageSeconds = (now.getTime() - Date.parse(node.heartbeat)) / 1000;
    if (ageSeconds > NODE_THRESHOLDS.heartbeatStaleSeconds) {
      issues.push({
        id: `node/${node.name}:heartbeat`,
        severity: "critical",
        category: "node-heartbeat",
        resource,
        title: `Node ${node.name} kubelet has not sent a heartbeat for ${Math.round(ageSeconds)}s`,
        evidence: [`Lease kube-node-lease/${node.name} was last renewed at ${node.heartbeat} (kubelets renew it about every 10s)`],
        hint: "The kubelet is down, hung, or cannot reach the API server; check the node, its kubelet service and its network. If every node shows this, check the clock of the machine running this check.",
      });
    }
  }

  if (node.requested) {
    const checks = [
      { name: "cpu", used: node.requested.cpu, total: parseQuantity(node.allocatable.cpu), fmt: formatCpu },
      { name: "memory", used: node.requested.memory, total: parseQuantity(node.allocatable.memory), fmt: formatMemory },
      { name: "pods", used: node.requested.pods, total: parseQuantity(node.allocatable.pods), fmt: (n: number) => String(n) },
    ];
    const full = checks.filter((c) => c.total && c.used / c.total >= NODE_THRESHOLDS.nodeRequestRatio);
    if (full.length > 0) {
      issues.push({
        id: `node/${node.name}:capacity`,
        severity: "warning",
        category: "node-capacity",
        resource,
        title: `Node ${node.name} is nearly full (${full.map((c) => `${c.name} ${formatPercent(c.used / c.total!)}`).join(", ")} requested)`,
        evidence: full.map((c) => `${c.name}: ${c.fmt(c.used)} requested of ${c.fmt(c.total!)} allocatable`),
        hint: "New pods may not fit on this node even if actual usage is low. Right-size requests of the pods on it, or add nodes.",
      });
    }
  }

  const server = parseMinorVersion(serverVersion);
  const kubelet = parseMinorVersion(node.kubeletVersion);
  if (server && kubelet) {
    const behind = (server.major - kubelet.major) * 100 + (server.minor - kubelet.minor);
    if (behind < 0 || behind > NODE_THRESHOLDS.maxKubeletMinorsBehind) {
      issues.push({
        id: `node/${node.name}:version-skew`,
        severity: "critical",
        category: "version-skew",
        resource,
        title:
          behind < 0
            ? `Node ${node.name} kubelet ${node.kubeletVersion} is newer than the API server ${serverVersion}`
            : `Node ${node.name} kubelet ${node.kubeletVersion} is ${behind} minor versions behind the API server ${serverVersion}`,
        evidence: [`kubelet ${node.kubeletVersion}, API server ${serverVersion}; supported: kubelet up to ${NODE_THRESHOLDS.maxKubeletMinorsBehind} minor versions older, never newer`],
        hint: "Finish the upgrade: upgrade the control plane first, then the nodes, one minor version at a time.",
      });
    }
  }
  return issues;
}
