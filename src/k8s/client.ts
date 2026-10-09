import { AppsV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";

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
  return ALLOWED_PREFIXES.some(
    (prefix) => name.startsWith(prefix) && /^[A-Z]/.test(name.slice(prefix.length)),
  );
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
}

export function createK8sClients(kubeconfigPath?: string): K8sClients {
  const kc = new KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault(); // $KUBECONFIG, then ~/.kube/config, then in-cluster
  }
  return {
    context: kc.getCurrentContext(),
    core: readOnly(kc.makeApiClient(CoreV1Api), "CoreV1Api"),
    apps: readOnly(kc.makeApiClient(AppsV1Api), "AppsV1Api"),
  };
}
