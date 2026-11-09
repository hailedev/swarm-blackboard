import { createAnthropic } from '@ai-sdk/anthropic';
import type { Model, ModelPricing } from '@team/core';
import type { LanguageModel } from 'ai';

import { createAiSdkModel } from './ai-sdk-model';

// How the schema reaches Anthropic: natively (`output_config.format`), as a forced JSON
// tool, or whichever the SDK thinks the model and schema support. Either way the SDK
// validates the result client-side, so `invalid_output` stays reachable.
export type AnthropicStructuredOutputMode = 'auto' | 'outputFormat' | 'jsonTool';

export const ANTHROPIC_TIMEOUT_MS = 60_000;

export interface AnthropicModelOptions {
  modelId: string;
  apiKey: string;
  pricing: ModelPricing;
  structuredOutputMode?: AnthropicStructuredOutputMode;
  timeoutMs?: number;
  now?: () => number;
  /** Test seam: stand in for the model the provider would build. */
  languageModel?: LanguageModel;
}

export const createAnthropicModel = (options: AnthropicModelOptions): Model => {
  const provider = createAnthropic({ apiKey: options.apiKey });
  return createAiSdkModel({
    id: options.modelId,
    billing: 'api',
    pricing: options.pricing,
    languageModel: options.languageModel ?? provider(options.modelId),
    // The role prompt is the stable prefix of every call, so it carries the cache
    // breakpoint. Anthropic only caches above a per-model minimum length; below it the
    // marker is ignored and the cache fields in usage stay at zero.
    systemMessage: (request) => ({
      role: 'system',
      content: request.system,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    }),
    providerOptions: () => ({
      anthropic: { structuredOutputMode: options.structuredOutputMode ?? 'auto' },
    }),
    timeoutMs: options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS,
    now: options.now,
  });
};
