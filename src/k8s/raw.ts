import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { KubeConfig } from "@kubernetes/client-node";

/**
 * Read-only access to the API server's non-resource endpoints (health checks, version,
 * metrics). These are not Kubernetes objects, so they cannot go through the typed
 * list/read client. The guard is structural: this module can only send GET, and only
 * to the paths in ALLOWED_PATHS.
 */
export const ALLOWED_PATHS = new Set(["/readyz", "/livez", "/version", "/metrics"]);

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface PeerCertificate {
  subject: string;
  issuer: string;
  /** ISO timestamp of the certificate's expiry. */
  notAfter: string;
}

export interface RawResponse {
  status: number;
  body: string;
  /** The API server's TLS certificate (HTTPS only). */
  peerCertificate?: PeerCertificate;
}

export interface RawReader {
  get(path: string): Promise<RawResponse>;
}

export class RawPathNotAllowedError extends Error {
  constructor(path: string) {
    super(`Blocked raw API request to "${path}"; allowed paths: ${[...ALLOWED_PATHS].join(", ")}`);
    this.name = "RawPathNotAllowedError";
  }
}

/** Returns the normalized path (with query) if allowed, otherwise throws. */
export function checkRawPath(path: string): string {
  // Parse against a dummy origin so "/readyz/../api/v1/secrets" is normalized before the check.
  const url = new URL(path, "http://guard.invalid");
  if (url.origin !== "http://guard.invalid" || !ALLOWED_PATHS.has(url.pathname)) {
    throw new RawPathNotAllowedError(path);
  }
  return `${url.pathname}${url.search}`;
}

function certField(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
    .join(", ");
}

export function createRawReader(kc: KubeConfig, timeoutMs = 10_000): RawReader {
  return {
    async get(path: string): Promise<RawResponse> {
      const safePath = checkRawPath(path);
      const cluster = kc.getCurrentCluster();
      if (!cluster) throw new Error("kubeconfig has no current cluster");
      // Keep any path prefix in the server URL (e.g. Rancher's /k8s/clusters/<id>).
      const url = new URL(`${cluster.server.replace(/\/+$/, "")}${safePath}`);
      const isHttps = url.protocol === "https:";

      const options: https.RequestOptions = {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {},
        timeout: timeoutMs,
      };
      await kc.applyToHTTPSOptions(options); // CA, client certs, bearer/exec tokens
      options.method = "GET"; // never let anything above change the method
      // A reused keep-alive connection resumes the TLS session, and Node then does not
      // expose the peer certificate. Use a fresh connection (the CA and client cert stay
      // on `options`), but keep custom agents such as a kubeconfig proxy.
      if (options.agent?.constructor === https.Agent) options.agent = false;

      return new Promise<RawResponse>((resolve, reject) => {
        const req = (isHttps ? https : http).request(options, (res) => {
          let peerCertificate: PeerCertificate | undefined;
          const socket = res.socket as TLSSocket;
          if (isHttps && typeof socket.getPeerCertificate === "function") {
            const cert = socket.getPeerCertificate();
            if (cert?.valid_to) {
              peerCertificate = {
                subject: certField(cert.subject),
                issuer: certField(cert.issuer),
                notAfter: new Date(cert.valid_to).toISOString(),
              };
            }
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error(`response from ${safePath} exceeded ${MAX_BODY_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), peerCertificate }),
          );
        });
        req.on("timeout", () => req.destroy(new Error(`GET ${safePath} timed out after ${timeoutMs}ms`)));
        req.on("error", reject);
        req.end();
      });
    },
  };
}
