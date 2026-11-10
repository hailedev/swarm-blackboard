import {
  err,
  ok,
  type Model,
  type PriceTable,
  type Provider,
  type ResolvedModel,
  type Result,
  type TraceSink,
} from '@team/core';

import {
  ANTHROPIC_CHARS_PER_TOKEN,
  createAnthropicModel,
  type AnthropicStructuredOutputMode,
} from './anthropic';
import { createOllamaModel, OLLAMA_CHARS_PER_TOKEN } from './ollama';
import { withRetry, type RetryPolicy } from './retry';
import { traceModel } from './trace';

// Turns the roster's resolved aliases into Models (ADR-0009). One instance per alias, so
// two roles on the same alias share a model; each is traced per attempt and retried on
// transient errors: withRetry(traceModel(adapter)), trace inside retry, so every HTTP
// attempt leaves its own trace (CLAUDE.md architecture rule 6).

export type FactoryError =
  | { kind: 'missing_api_key'; provider: Provider; alias: string }
  | { kind: 'no_price'; alias: string; modelId: string };

/**
 * The host's calibrated chars-per-token figure for a model, or undefined to keep the
 * provider default (docs/budget-guardrails.md §2). An explicit `charsPerToken` on the
 * alias in agents.yaml wins over both.
 */
export type CharsPerTokenLookup = (
  resolved: ResolvedModel,
  providerDefault: number,
) => number | undefined;

export interface ModelFactoryOptions {
  anthropicApiKey?: string;
  ollamaBaseUrl: string;
  priceTable: PriceTable;
  retry?: Partial<RetryPolicy>;
  sink?: TraceSink;
  now?: () => number;
  anthropicStructuredOutputMode?: AnthropicStructuredOutputMode;
  /** Default context window for local models; an alias's `numCtx` overrides it. */
  ollamaNumCtx?: number;
  timeouts?: { anthropicMs?: number; ollamaMs?: number };
  charsPerToken?: CharsPerTokenLookup;
}

export interface ModelFactory {
  modelFor(resolved: ResolvedModel): Result<Model, FactoryError>;
}

export const describeFactoryError = (error: FactoryError): string => {
  switch (error.kind) {
    case 'missing_api_key':
      return `alias "${error.alias}" uses ${error.provider}, but no API key is set; put ANTHROPIC_API_KEY in .env or choose a local profile`;
    case 'no_price':
      return `no price for ${error.modelId} (alias "${error.alias}") in the price table; add it to packages/providers/src/pricing.ts`;
  }
};

export const createModelFactory = (options: ModelFactoryOptions): ModelFactory => {
  const cache = new Map<string, Model>();

  const charsPerToken = (resolved: ResolvedModel, providerDefault: number): number =>
    resolved.charsPerToken ?? options.charsPerToken?.(resolved, providerDefault) ?? providerDefault;

  const build = (resolved: ResolvedModel): Result<Model, FactoryError> => {
    switch (resolved.provider) {
      case 'anthropic': {
        if (options.anthropicApiKey === undefined || options.anthropicApiKey === '') {
          return err({ kind: 'missing_api_key', provider: 'anthropic', alias: resolved.alias });
        }
        const pricing = options.priceTable.models[resolved.model];
        if (pricing === undefined) {
          return err({ kind: 'no_price', alias: resolved.alias, modelId: resolved.model });
        }
        return ok(
          createAnthropicModel({
            modelId: resolved.model,
            apiKey: options.anthropicApiKey,
            pricing,
            structuredOutputMode: options.anthropicStructuredOutputMode,
            think: resolved.think,
            charsPerToken: charsPerToken(resolved, ANTHROPIC_CHARS_PER_TOKEN),
            timeoutMs: options.timeouts?.anthropicMs,
            now: options.now,
          }),
        );
      }
      case 'ollama':
        return ok(
          createOllamaModel({
            modelId: resolved.model,
            baseUrl: options.ollamaBaseUrl,
            think: resolved.think,
            numCtx: resolved.numCtx ?? options.ollamaNumCtx,
            charsPerToken: charsPerToken(resolved, OLLAMA_CHARS_PER_TOKEN),
            timeoutMs: options.timeouts?.ollamaMs,
            now: options.now,
          }),
        );
    }
  };

  return {
    modelFor(resolved) {
      const cached = cache.get(resolved.alias);
      if (cached !== undefined) return ok(cached);
      const built = build(resolved);
      if (!built.ok) return built;
      const model = composeModel(built.value, options);
      cache.set(resolved.alias, model);
      return ok(model);
    },
  };
};

/** Trace every attempt, then retry transient failures: withRetry(traceModel(base)). */
export const composeModel = (
  base: Model,
  options: Pick<ModelFactoryOptions, 'retry' | 'sink' | 'now'>,
): Model => {
  const traced = options.sink === undefined ? base : traceModel(base, options.sink, options.now);
  return withRetry(traced, options.retry);
};
