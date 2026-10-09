import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOllama } from "@langchain/ollama";
import type { z } from "zod";
import type { Config } from "../config.js";

/**
 * The two things the agent needs from an LLM. Keeping this small interface between
 * the agent and ChatOllama lets tests drive the agent with a scripted fake.
 */
export interface LlmClient {
  /** One chat turn where the model may answer with tool calls. */
  chatWithTools(messages: BaseMessage[], tools: StructuredToolInterface[]): Promise<AIMessage>;
  /** One chat turn whose answer must match `schema` (Ollama constrains decoding to it). */
  structured<S extends z.ZodType>(schema: S, messages: BaseMessage[], name: string): Promise<z.infer<S>>;
}

export function createOllamaLlm(config: Config): LlmClient {
  const model = new ChatOllama({
    baseUrl: config.ollamaUrl,
    model: config.model,
    temperature: 0,
    numCtx: config.numCtx,
    keepAlive: "10m",
  });
  // One retry: local GPUs occasionally fail a single request (e.g. a transient
  // "CUDA error" under WSL) and the next one succeeds.
  const retry = { stopAfterAttempt: 2 };
  return {
    chatWithTools: (messages, tools) => model.bindTools(tools).withRetry(retry).invoke(messages),
    structured: async (schema, messages, name) =>
      (await model.withStructuredOutput(schema, { name }).withRetry(retry).invoke(messages)) as z.infer<typeof schema>,
  };
}
