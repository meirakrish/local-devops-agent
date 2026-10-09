import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  MODEL: z.string().min(1).default("qwen2.5:7b-instruct"),
  KUBECONFIG: z.string().optional(),
  MAX_STEPS_PER_PROBLEM: z.coerce.number().int().positive().default(6),
  RESTART_THRESHOLD: z.coerce.number().int().positive().default(5),
  EVENT_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
});

export interface Config {
  ollamaUrl: string;
  model: string;
  kubeconfigPath?: string;
  maxStepsPerProblem: number;
  restartThreshold: number;
  eventWindowMinutes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values in .env (e.g. `KUBECONFIG=`) mean "not set", so defaults apply.
  const nonEmpty = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = ConfigSchema.safeParse(nonEmpty);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  return {
    ollamaUrl: c.OLLAMA_URL.replace(/\/+$/, ""),
    model: c.MODEL,
    kubeconfigPath: c.KUBECONFIG,
    maxStepsPerProblem: c.MAX_STEPS_PER_PROBLEM,
    restartThreshold: c.RESTART_THRESHOLD,
    eventWindowMinutes: c.EVENT_WINDOW_MINUTES,
  };
}
