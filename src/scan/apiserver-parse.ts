/**
 * Pure parsers for API server endpoints (/readyz, /metrics, /version) and helpers for
 * cluster-level checks. No I/O here, so they are easy to test with captured output.
 */

export interface HealthCheck {
  name: string;
  ok: boolean;
  /** Text after "failed:" for failing checks (often "reason withheld"). */
  reason?: string;
}

/** Parses `/readyz?verbose` or `/livez?verbose`: lines like "[+]etcd ok" / "[-]etcd failed: ...". */
export function parseHealthChecks(body: string): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const line of body.split("\n")) {
    const m = /^\[([+-])\](\S+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const ok = m[1] === "+";
    const rest = m[3] ?? "";
    checks.push({
      name: m[2]!,
      ok,
      reason: ok ? undefined : rest.replace(/^failed:?\s*/, "") || undefined,
    });
  }
  return checks;
}

export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Minimal Prometheus text-format parser, limited to the metric names asked for (the
 * API server's /metrics output is several MB, so everything else is skipped cheaply).
 */
export function parseMetrics(body: string, names: string[]): MetricSample[] {
  const wanted = new Set(names);
  const samples: MetricSample[] = [];
  for (const line of body.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    const name = line.slice(0, brace !== -1 && brace < space ? brace : space);
    if (!wanted.has(name)) continue;

    const labels: Record<string, string> = {};
    let rest = line.slice(name.length);
    if (rest.startsWith("{")) {
      const end = rest.indexOf("}");
      for (const m of rest.slice(1, end).matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[m[1]!] = m[2]!;
      rest = rest.slice(end + 1);
    }
    const value = Number(rest.trim().split(/\s+/)[0]);
    if (!Number.isNaN(value)) samples.push({ name, labels, value });
  }
  return samples;
}

export interface EtcdStorage {
  /** Database size in bytes (largest across etcd clusters), if exposed. */
  dbSizeBytes?: number;
  /** Object counts per resource, largest first. */
  objectCounts: { resource: string; count: number }[];
}

// The object-count metric was renamed in recent Kubernetes versions; accept both.
const OBJECT_COUNT_METRICS = ["apiserver_resource_objects", "apiserver_storage_objects"];
const DB_SIZE_METRICS = ["apiserver_storage_size_bytes", "apiserver_storage_db_total_size_in_bytes", "etcd_db_total_size_in_bytes"];

export function etcdStorageFromMetrics(body: string): EtcdStorage {
  const samples = parseMetrics(body, [...DB_SIZE_METRICS, ...OBJECT_COUNT_METRICS]);
  const sizes = samples.filter((s) => DB_SIZE_METRICS.includes(s.name)).map((s) => s.value);
  const counts = new Map<string, number>();
  for (const s of samples.filter((x) => OBJECT_COUNT_METRICS.includes(x.name))) {
    const group = s.labels["group"];
    const resource = `${s.labels["resource"] ?? "?"}${group ? `.${group}` : ""}`;
    // -1 means the API server failed to count; skip it.
    if (s.value >= 0) counts.set(resource, Math.max(counts.get(resource) ?? 0, s.value));
  }
  return {
    dbSizeBytes: sizes.length > 0 ? Math.max(...sizes) : undefined,
    objectCounts: [...counts.entries()]
      .map(([resource, count]) => ({ resource, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** etcd's default backend quota (2 GiB) when --quota-backend-bytes is not set. */
export const ETCD_DEFAULT_QUOTA_BYTES = 2 * 1024 ** 3;

/** Reads --quota-backend-bytes from an etcd container's command line, if set. */
export function etcdQuotaFromArgs(args: string[]): number | undefined {
  for (const arg of args) {
    const m = /^--quota-backend-bytes=(\d+)$/.exec(arg);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export interface MinorVersion {
  major: number;
  minor: number;
}

/** "v1.37.0", "v1.30.4-eks-a737599", "1.29" -> { major: 1, minor: 37 }. */
export function parseMinorVersion(version: string | undefined): MinorVersion | undefined {
  const m = /^v?(\d+)\.(\d+)/.exec(version ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}
