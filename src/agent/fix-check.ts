import { Corpus } from "./grounding.js";
import type { FixFlag } from "./types.js";

/**
 * Marks suggested-fix steps that may be invented or risky. Steps are never dropped: the
 * report shows a note next to them, so the reader knows what to check before running them.
 *
 * - unverified: a concrete value (image reference, resource name, namespace, quantity
 *   with a unit, env var value) that appears nowhere in the tool output or the rules'
 *   issue text. The model once "fixed" a missing image tag with another made-up tag.
 * - destructive: `kubectl delete`, `drain`, `--force`, `--grace-period=0`, scaling to 0.
 * - changes-cluster: `kubectl rollout undo` is a normal fix, but it is not a no-op.
 *
 * Only values in a recognizable form are checked, so generic advice ("Increase the
 * memory limit") is never flagged.
 */

const KINDS =
  "deployments?|deploy|statefulsets?|sts|daemonsets?|ds|pods?|po|services?|svc|configmaps?|cm|secrets?|" +
  "replicasets?|rs|jobs?|cronjobs?|nodes?|pvc|persistentvolumeclaims?|serviceaccounts?|sa|ingress(?:es)?|" +
  "namespaces?|ns|(?:validating|mutating)webhookconfigurations?";
const NAME = "[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?";

interface Pattern {
  re: RegExp;
  /** Capture group holding the value. */
  group: number;
  /** Optional extra filter on the captured value. */
  accept?: (value: string) => boolean;
}

const VALUE_PATTERNS: Pattern[] = [
  // Image references: "nginx:1.25.9", "ghcr.io/org/app:v2". The tag must contain a digit
  // (or be "latest"); the name must contain a letter, which rules out times like 15:46:45.
  {
    re: /(?<![\w./:-])([a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][\w.-]*)/g,
    group: 1,
    accept: (v) => {
      const [name = "", tag = ""] = v.split(":");
      return /[a-z]/.test(name) && (/\d/.test(tag) || tag === "latest");
    },
  },
  // kind/name, as in "deployment/web".
  { re: new RegExp(`\\b(?:${KINDS})/(${NAME})`, "gi"), group: 1 },
  // kind name after a kubectl verb, as in "kubectl rollout restart deployment web".
  { re: new RegExp(`\\bkubectl\\s+(?:[a-z-]+\\s+){1,2}(?:${KINDS})\\s+(${NAME})\\b`, "gi"), group: 1 },
  // Namespaces: "-n shop", "--namespace=shop".
  { re: new RegExp(`(?:^|\\s)(?:-n|--namespace)[\\s=]+(${NAME})\\b`, "g"), group: 1 },
  // Quantities: "64Mi", "500m", "2Gi".
  { re: /(?<![\w.])(\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m))(?![\w.])/g, group: 1 },
  // Env var values: "DATABASE_URL=postgres://db/app". The tools never show env values.
  { re: /\b[A-Z][A-Z0-9_]+=("[^"]+"|'[^']+'|[^\s`'",;)]+)/g, group: 1 },
];

/** Placeholders the reader is meant to fill in are not invented values. */
const PLACEHOLDER = /[<>{}$]|\.\.\.|\b(your|example|placeholder|my-|xxx)|^(value|val|x)$/i;

const DESTRUCTIVE: { re: RegExp; value: string; message: string }[] = [
  { re: /\bkubectl\s+delete\b/i, value: "kubectl delete", message: "deletes resources" },
  { re: /\bkubectl\s+drain\b/i, value: "kubectl drain", message: "evicts every pod from the node" },
  { re: /--force\b/, value: "--force", message: "skips safety checks" },
  { re: /--grace-period[=\s]+0\b/, value: "--grace-period=0", message: "kills pods without a graceful shutdown" },
  { re: /--replicas[=\s]+0\b/, value: "--replicas=0", message: "stops every pod of the workload" },
];
const CHANGES_CLUSTER: { re: RegExp; value: string; message: string }[] = [
  {
    re: /\brollout\s+undo\b/i,
    value: "kubectl rollout undo",
    message: "rolls back to the previous revision; check that it was healthy",
  },
];

function concreteValues(step: string): string[] {
  const values = new Set<string>();
  for (const { re, group, accept } of VALUE_PATTERNS) {
    for (const match of step.matchAll(re)) {
      const value = match[group]?.replace(/^["']|["']$/g, "").replace(/[.:-]+$/, "");
      if (!value || PLACEHOLDER.test(value) || (accept && !accept(value))) continue;
      values.add(value);
    }
  }
  return [...values];
}

/**
 * Flags for each suggested-fix step (`step` is the 0-based index). `knownText` is
 * everything the model was shown from the cluster: tool output and the issues' text.
 */
export function checkFixes(steps: string[], knownText: string[]): FixFlag[] {
  const known = new Corpus(knownText);
  const flags: FixFlag[] = [];
  steps.forEach((text, step) => {
    for (const value of concreteValues(text)) {
      if (!known.hasValue(value)) {
        flags.push({ step, kind: "unverified", value, message: "does not appear in the cluster data" });
      }
    }
    for (const d of DESTRUCTIVE) {
      if (d.re.test(text)) flags.push({ step, kind: "destructive", value: d.value, message: d.message });
    }
    for (const c of CHANGES_CLUSTER) {
      if (c.re.test(text)) flags.push({ step, kind: "changes-cluster", value: c.value, message: c.message });
    }
  });
  return flags;
}
