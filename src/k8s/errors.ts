/** Short, human-readable message for a Kubernetes API error (or any thrown value). */
export function k8sErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: number; message?: string };
    if (e.code === 403) return "forbidden (check RBAC permissions)";
    if (e.code === 404) return "not found";
    if (e.message) return e.message.split("\n")[0]!;
  }
  return String(err);
}
