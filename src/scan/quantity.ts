/**
 * Parsing for Kubernetes resource quantities ("500m", "2", "16Mi", "16246788Ki", "1G").
 * Returns undefined for anything it does not understand rather than guessing.
 */

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

export function parseQuantity(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const m = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  const suffix = m[2] ?? "";
  const factor = BINARY[suffix] ?? DECIMAL[suffix];
  return factor === undefined ? undefined : value * factor;
}

export function formatCpu(cores: number): string {
  return cores < 1 ? `${Math.round(cores * 1000)}m` : `${Number(cores.toFixed(2))}`;
}

export function formatMemory(bytes: number): string {
  if (bytes >= 2 ** 30) return `${Number((bytes / 2 ** 30).toFixed(1))}Gi`;
  return `${Math.round(bytes / 2 ** 20)}Mi`;
}
