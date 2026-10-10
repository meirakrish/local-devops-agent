export interface OllamaStatus {
  url: string;
  model: string;
  reachable: boolean;
  modelAvailable: boolean;
  installedModels: string[];
  error?: string;
}

/** Ollama treats "name" and "name:latest" as the same model. */
function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * Checks that the Ollama server answers and that the configured model is pulled.
 * Uses GET /api/tags, which is cheap and does not load the model into memory.
 */
export async function checkOllama(url: string, model: string, timeoutMs = 3000): Promise<OllamaStatus> {
  const base: OllamaStatus = { url, model, reachable: false, modelAvailable: false, installedModels: [] };
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ...base, error: `HTTP ${res.status} from ${url}/api/tags` };
    const body = (await res.json()) as { models?: { name: string }[] };
    const installedModels = (body.models ?? []).map((m) => m.name);
    const wanted = normalizeModelName(model);
    return {
      ...base,
      reachable: true,
      installedModels,
      modelAvailable: installedModels.some((m) => normalizeModelName(m) === wanted),
      error: installedModels.length === 0 ? "no models installed" : undefined,
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : String(err);
    return { ...base, error: `cannot reach Ollama at ${url} (${reason})` };
  }
}
