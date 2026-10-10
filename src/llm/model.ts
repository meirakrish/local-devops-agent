import type { CallbackHandlerMethods } from "@langchain/core/callbacks/base";
import { type AIMessage, type BaseMessage, isAIMessage, type UsageMetadata } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOllama } from "@langchain/ollama";
import type { z } from "zod";
import type { Config } from "../config.js";

/** Token counts reported by Ollama for a group of LLM calls (triage, or one investigation). */
export interface LlmUsage {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  /** Largest single prompt. Compare with NUM_CTX: the whole conversation must fit in it. */
  peakPromptTokens: number;
}

export function emptyUsage(): LlmUsage {
  return { calls: 0, promptTokens: 0, outputTokens: 0, peakPromptTokens: 0 };
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    peakPromptTokens: Math.max(a.peakPromptTokens, b.peakPromptTokens),
  };
}

/** Adds up token counts per call until `take()` returns them and starts over. */
export class UsageMeter {
  private usage = emptyUsage();

  record(tokens: UsageMetadata | undefined): void {
    const prompt = tokens?.input_tokens ?? 0;
    this.usage.calls++;
    this.usage.promptTokens += prompt;
    this.usage.outputTokens += tokens?.output_tokens ?? 0;
    this.usage.peakPromptTokens = Math.max(this.usage.peakPromptTokens, prompt);
  }

  take(): LlmUsage {
    const usage = this.usage;
    this.usage = emptyUsage();
    return usage;
  }
}

/**
 * By default Ollama silently drops the start of a prompt longer than NUM_CTX, and the model
 * answers from what is left. `truncate: false` makes Ollama reject the request instead.
 * ChatOllama has no option for it, but passes the request object through to Ollama.
 */
class StrictChatOllama extends ChatOllama {
  override invocationParams(options?: this["ParsedCallOptions"]) {
    return { ...super.invocationParams(options), truncate: false } as ReturnType<ChatOllama["invocationParams"]>;
  }
}

function isContextOverflow(err: unknown): err is Error {
  return err instanceof Error && /exceeds the available context size/i.test(err.message);
}

/** Ollama's overflow error is a JSON blob; say what happened and what to change. */
function explainOverflow(err: unknown): never {
  if (!isContextOverflow(err)) throw err;
  const [, prompt, ctx] =
    /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/.exec(err.message) ?? [];
  throw new Error(
    `prompt${prompt ? ` (${prompt} tokens)` : ""} does not fit in NUM_CTX${ctx ? ` (${ctx})` : ""}; raise NUM_CTX or lower TOOL_OUTPUT_MAX_CHARS`,
  );
}

/**
 * The two things the agent needs from an LLM. Keeping this small interface between
 * the agent and ChatOllama lets tests drive the agent with a scripted fake.
 */
export interface LlmClient {
  /** One chat turn where the model may answer with tool calls. */
  chatWithTools(messages: BaseMessage[], tools: StructuredToolInterface[]): Promise<AIMessage>;
  /** One chat turn whose answer must match `schema` (Ollama constrains decoding to it). */
  structured<S extends z.ZodType>(schema: S, messages: BaseMessage[], name: string): Promise<z.infer<S>>;
  /** Token usage of the calls made since the last `takeUsage()`; resets the count. */
  takeUsage?(): LlmUsage;
}

export function createOllamaLlm(config: Config): LlmClient {
  const model = new StrictChatOllama({
    baseUrl: config.ollamaUrl,
    model: config.model,
    temperature: 0,
    numCtx: config.numCtx,
    keepAlive: "10m",
  });
  // One retry: local GPUs occasionally fail a single request (e.g. a transient
  // "CUDA error" under WSL) and the next one succeeds.
  // An overflowing prompt fails the same way every time, so it is not retried.
  const retry = {
    stopAfterAttempt: 2,
    onFailedAttempt: (err: unknown) => {
      if (isContextOverflow(err)) throw err;
    },
  };
  // A callback sees every model call, including the one inside withStructuredOutput,
  // whose parsed result no longer carries the message with its usage_metadata.
  const meter = new UsageMeter();
  const counting: { callbacks: CallbackHandlerMethods[] } = {
    callbacks: [
      {
        handleLLMEnd: (output: LLMResult) => {
          const message = (output.generations[0]?.[0] as ChatGeneration | undefined)?.message;
          meter.record(message && isAIMessage(message) ? message.usage_metadata : undefined);
        },
      },
    ],
  };
  return {
    chatWithTools: (messages, tools) =>
      model.bindTools(tools).withRetry(retry).invoke(messages, counting).catch(explainOverflow),
    structured: async (schema, messages, name) =>
      (await model
        .withStructuredOutput(schema, { name })
        .withRetry(retry)
        .invoke(messages, counting)
        .catch(explainOverflow)) as z.infer<typeof schema>,
    takeUsage: () => meter.take(),
  };
}
