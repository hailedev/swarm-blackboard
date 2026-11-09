import { estimateInputTokens, type Model } from '@team/core';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';

import { createAiSdkModel } from './ai-sdk-model';

/** Generous enough for a cold load of a 24–39 GB model; the pre-flight warm-up makes that rare. */
export const OLLAMA_TIMEOUT_MS = 180_000;

/** Context window requested per call. Ollama silently truncates the start of a longer prompt. */
export const OLLAMA_NUM_CTX = 32_768;

/**
 * Extra generation room for a thinking model. Ollama counts reasoning tokens against
 * num_predict, and Qwen 3.6 can spend more than 4 096 of them before writing a byte of
 * JSON, so the output allowance alone would be eaten by the thinking.
 */
export const OLLAMA_THINK_TOKENS = 8_192;

/**
 * Default chars per token for the local models (docs/budget-guardrails.md §2). Local
 * models are not calibrated from traces: Ollama reports only the newly evaluated prompt
 * tokens after a KV-cache hit, so its counts would make the estimate optimistic, and here
 * the estimate only guards the context window, where conservative is right.
 */
export const OLLAMA_CHARS_PER_TOKEN = 3;

export interface OllamaModelOptions {
  modelId: string;
  /** Server root, e.g. http://localhost:11434; `/api` is appended here. */
  baseUrl: string;
  think?: boolean;
  /** Reasoning tokens allowed on top of the output allowance when `think` is on. */
  thinkTokens?: number;
  numCtx?: number;
  /** Overrides OLLAMA_CHARS_PER_TOKEN, e.g. from agents.yaml. */
  charsPerToken?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Test seam: stand in for the model the provider would build. */
  languageModel?: LanguageModel;
}

export const ollamaApiUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/api`;

export const createOllamaModel = (options: OllamaModelOptions): Model => {
  const numCtx = options.numCtx ?? OLLAMA_NUM_CTX;
  const think = options.think ?? false;
  const thinkTokens = think ? (options.thinkTokens ?? OLLAMA_THINK_TOKENS) : 0;
  const charsPerToken = options.charsPerToken ?? OLLAMA_CHARS_PER_TOKEN;
  const provider = createOllama({ baseURL: ollamaApiUrl(options.baseUrl) });
  return createAiSdkModel({
    id: options.modelId,
    billing: 'local',
    pricing: null,
    charsPerToken,
    languageModel: options.languageModel ?? provider(options.modelId),
    // The provider forwards the JSON schema as Ollama's `format` by itself, but it does not
    // translate maxOutputTokens into anything Ollama reads, so num_predict is set here,
    // with the thinking room on top.
    providerOptions: (_request, maxOutputTokens) => ({
      ollama: {
        think,
        options: {
          num_ctx: numCtx,
          ...(maxOutputTokens === undefined ? {} : { num_predict: maxOutputTokens + thinkTokens }),
        },
      },
    }),
    // Better a clear refusal than a prompt Ollama truncates from the front, where the
    // role instructions and the problem are.
    refuse: (request) => {
      const estimated = estimateInputTokens(request, charsPerToken);
      const needed = estimated + (request.maxOutputTokens ?? 0) + thinkTokens;
      return needed > numCtx
        ? {
            kind: 'invalid_request',
            message: `prompt (~${String(estimated)} tokens) plus output allowance (${String(request.maxOutputTokens ?? 0)}) exceeds the ${String(numCtx)}-token context of ${options.modelId}`,
          }
        : undefined;
    },
    timeoutMs: options.timeoutMs ?? OLLAMA_TIMEOUT_MS,
    now: options.now,
  });
};
