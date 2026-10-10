import {
  AdmissionregistrationV1Api,
  AppsV1Api,
  CoordinationV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  KubeConfig,
} from "@kubernetes/client-node";
import { delimiter } from "node:path";
import { createRawReader, type RawReader } from "./raw.js";

/**
 * Read-only access to the Kubernetes API, enforced in code (not just in prompts).
 *
 * Two layers:
 *  1. Compile time: `ReadOnlyApi<T>` keeps only methods named `list*` / `read*`,
 *     so calling `deleteNamespacedPod` does not type-check.
 *  2. Runtime: `readOnly()` wraps the API object in a Proxy that throws on any
 *     other property, which also blocks `as any` casts and LLM-chosen names.
 *
 * `connect*` methods (exec, attach, port-forward, proxy) are blocked as well,
 * since they do not match the allowed prefixes.
 */
const ALLOWED_PREFIXES = ["list", "read"] as const;

export type ReadOnlyApi<T> = {
  [K in keyof T as K extends `list${string}` | `read${string}` ? K : never]: T[K];
};

export class ReadOnlyViolationError extends Error {
  constructor(apiName: string, prop: string) {
    super(`Blocked non-read-only Kubernetes operation: ${apiName}.${prop}`);
    this.name = "ReadOnlyViolationError";
  }
}

export function isReadOnlyOperation(name: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix) && /^[A-Z]/.test(name.slice(prefix.length)));
}

export function readOnly<T extends object>(api: T, apiName: string): ReadOnlyApi<T> {
  return new Proxy(api, {
    get(target, prop) {
      // Symbols (e.g. Symbol.toStringTag, util.inspect) are harmless introspection.
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      if (prop === "then") return undefined; // keep the proxy from looking like a Promise
      if (!isReadOnlyOperation(prop)) throw new ReadOnlyViolationError(apiName, prop);
      const value = Reflect.get(target, prop);
      // Bind to the real object so internal `this.*` lookups bypass the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop) {
      throw new ReadOnlyViolationError(apiName, String(prop));
    },
  }) as unknown as ReadOnlyApi<T>;
}

export interface K8sClients {
  context: string;
  core: ReadOnlyApi<CoreV1Api>;
  apps: ReadOnlyApi<AppsV1Api>;
  admission: ReadOnlyApi<AdmissionregistrationV1Api>;
  discovery: ReadOnlyApi<DiscoveryV1Api>;
  coordination: ReadOnlyApi<CoordinationV1Api>;
  /** GET-only access to /readyz, /livez, /version and /metrics (see raw.ts). */
  raw: RawReader;
}

/**
 * Loads the kubeconfig. Like kubectl, KUBECONFIG may list several files separated by ":"
 * (";" on Windows); they are merged, and the first file's current context wins.
 */
function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  const [first, ...rest] = (kubeconfigPath ?? "").split(delimiter).filter(Boolean);
  if (first) {
    kc.loadFromFile(first);
    for (const file of rest) {
      const more = new KubeConfig();
      more.loadFromFile(file);
      kc.mergeConfig(more, true);
    }
  } else {
    kc.loadFromDefault(); // $KUBECONFIG, then ~/.kube/config, then in-cluster
  }
  return kc;
}

/** Clients for `context`, or for the kubeconfig's current context when omitted. */
export function createK8sClients(kubeconfigPath?: string, context?: string): K8sClients {
  const kc = loadKubeConfig(kubeconfigPath);
  if (context) {
    if (!kc.getContextObject(context)) {
      const known = kc.getContexts().map((c) => c.name);
      throw new Error(`unknown kube context "${context}". Contexts in the kubeconfig: ${known.join(", ") || "(none)"}`);
    }
    kc.setCurrentContext(context);
  }
  return {
    context: kc.getCurrentContext(),
    core: readOnly(kc.makeApiClient(CoreV1Api), "CoreV1Api"),
    apps: readOnly(kc.makeApiClient(AppsV1Api), "AppsV1Api"),
    admission: readOnly(kc.makeApiClient(AdmissionregistrationV1Api), "AdmissionregistrationV1Api"),
    discovery: readOnly(kc.makeApiClient(DiscoveryV1Api), "DiscoveryV1Api"),
    coordination: readOnly(kc.makeApiClient(CoordinationV1Api), "CoordinationV1Api"),
    raw: createRawReader(kc),
  };
}
