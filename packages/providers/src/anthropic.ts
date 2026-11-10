import { createAnthropic } from '@ai-sdk/anthropic';
import type { Model, ModelPricing } from '@team/core';
import type { LanguageModel } from 'ai';

import { createAiSdkModel } from './ai-sdk-model';

// How the schema reaches Anthropic: natively (`output_config.format`), as a forced JSON
// tool, or whichever the SDK thinks the model and schema support. Either way the SDK
// validates the result client-side, so `invalid_output` stays reachable.
export type AnthropicStructuredOutputMode = 'auto' | 'outputFormat' | 'jsonTool';

export const ANTHROPIC_TIMEOUT_MS = 60_000;

/**
 * Default chars per token for Claude's tokenizer on board prompts, before calibration
 * (docs/budget-guardrails.md §2). Deliberately low: the estimate must not undershoot.
 */
export const ANTHROPIC_CHARS_PER_TOKEN = 2;

/**
 * What the request says about thinking (ADR-0013). Claude Sonnet 5.5 and Haiku 5.5 think
 * adaptively when the request says nothing, and the thinking tokens are billed as output
 * and count against `maxOutputTokens`, so an alias with `think: false` turns it off:
 * Sonnet 5.5 rejects `disabled` and offers `between_tools` as its lowest setting (with no
 * tools in play, that is off); every other model takes `disabled`. `think: true` asks for
 * adaptive thinking explicitly, and an alias that says nothing leaves the model's default.
 */
export interface AnthropicThinkingOption {
  thinking: { type: 'adaptive' | 'disabled' | 'between_tools' };
}

export const anthropicThinking = (
  modelId: string,
  think: boolean | undefined,
): Partial<AnthropicThinkingOption> => {
  if (think === undefined) return {};
  if (think) return { thinking: { type: 'adaptive' } };
  return {
    thinking: { type: modelId.startsWith('claude-sonnet-5-5') ? 'between_tools' : 'disabled' },
  };
};

export interface AnthropicModelOptions {
  modelId: string;
  apiKey: string;
  pricing: ModelPricing;
  structuredOutputMode?: AnthropicStructuredOutputMode;
  /** The alias's `think` flag; undefined leaves the model's own default. */
  think?: boolean;
  /** Overrides ANTHROPIC_CHARS_PER_TOKEN: an agents.yaml value or the host's calibration. */
  charsPerToken?: number;
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
    charsPerToken: options.charsPerToken ?? ANTHROPIC_CHARS_PER_TOKEN,
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
      anthropic: {
        structuredOutputMode: options.structuredOutputMode ?? 'auto',
        ...anthropicThinking(options.modelId, options.think),
      },
    }),
    timeoutMs: options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS,
    now: options.now,
  });
};
