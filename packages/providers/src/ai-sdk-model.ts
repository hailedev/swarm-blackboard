import {
  err,
  ok,
  withCost,
  zeroUsage,
  type Model,
  type ModelBilling,
  type ModelError,
  type ModelPricing,
  type ModelRequest,
  type ModelResponse,
  type Result,
  type Usage,
} from '@team/core';
import {
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  type CallWarning,
  type LanguageModel,
  type LanguageModelUsage,
  type SystemModelMessage,
} from 'ai';

import { classifyProviderError } from './errors';

/** The SDK does not export this type by name; it is what generateText accepts. */
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

// One implementation of core's Model port for every AI SDK language model (ADR-0003).
// The provider-specific adapters (anthropic.ts, ollama.ts) only choose the language model
// and the per-request hooks; everything the controller relies on — the schema reaching
// the provider, usage in core's shape, errors classified, warnings surfaced — is here.

export interface AiSdkModelOptions {
  id: string;
  billing: ModelBilling;
  pricing: ModelPricing | null;
  languageModel: LanguageModel;
  /** Builds the system message; lets a provider attach options such as cache control. */
  systemMessage?: (request: ModelRequest<unknown>) => SystemModelMessage;
  /** Provider options per request; lets Ollama derive num_predict from the allowance. */
  providerOptions?: (
    request: ModelRequest<unknown>,
    maxOutputTokens: number | undefined,
  ) => ProviderOptions;
  /** Refuse a request before it is sent, e.g. one that cannot fit the context window. */
  refuse?: (request: ModelRequest<unknown>) => ModelError | undefined;
  /** Whole-call timeout, including the provider's own retries (none: maxRetries is 0). */
  timeoutMs: number;
  now?: () => number;
}

// Core's `inputTokens` means uncached prompt tokens; the SDK's `inputTokens` is the total.
// Every field may be undefined (Ollama reports no cache split, and nothing at all on a
// KV-cache hit), so everything coalesces to zero.
export const usageFromSdk = (usage: LanguageModelUsage, pricing: ModelPricing | null): Usage => {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  return withCost(
    { inputTokens, outputTokens: usage.outputTokens ?? 0, cacheReadTokens, cacheWriteTokens },
    pricing,
  );
};

export const describeWarning = (warning: CallWarning): string => {
  switch (warning.type) {
    case 'unsupported':
    case 'compatibility':
      return `${warning.type} ${warning.feature}${warning.details === undefined ? '' : `: ${warning.details}`}`;
    default:
      return 'message' in warning && typeof warning.message === 'string'
        ? warning.message
        : warning.type;
  }
};

interface ZodIssueLike {
  path: readonly (string | number | symbol)[];
  message: string;
}

const isZodIssue = (value: unknown): value is ZodIssueLike =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { path?: unknown }).path) &&
  typeof (value as { message?: unknown }).message === 'string';

const zodIssues = (cause: unknown): string[] | undefined => {
  const issues = (cause as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues) || !issues.every(isZodIssue)) return undefined;
  return issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
};

// What to tell the model on the repair attempt. A truncated answer is the common failure
// for a thinking model whose reasoning tokens count against the allowance, and "the JSON
// was cut off" is a very different instruction from "field X is wrong".
const issuesOf = (error: NoObjectGeneratedError, outputTokens: number): string[] => {
  if (error.finishReason === 'length') {
    return [
      `output truncated after ${String(outputTokens)} tokens (finishReason=length); answer more briefly`,
    ];
  }
  const { cause } = error;
  if (TypeValidationError.isInstance(cause)) {
    return zodIssues(cause.cause) ?? [cause.message];
  }
  if (JSONParseError.isInstance(cause)) return ['the answer is not valid JSON'];
  return [error.message];
};

export const createAiSdkModel = (options: AiSdkModelOptions): Model => {
  const now = options.now ?? Date.now;
  return {
    id: options.id,
    billing: options.billing,
    pricing: options.pricing,
    async generateObject<T>(
      request: ModelRequest<T>,
    ): Promise<Result<ModelResponse<T>, ModelError>> {
      const erased = request as ModelRequest<unknown>;
      const refused = options.refuse?.(erased);
      if (refused !== undefined) return err(refused);
      const startedMs = now();
      try {
        const result = await generateText({
          model: options.languageModel,
          instructions: options.systemMessage?.(erased) ?? request.system,
          prompt: request.prompt,
          output: Output.object({ schema: request.schema }),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0,
          timeout: { totalMs: options.timeoutMs },
          providerOptions: options.providerOptions?.(erased, request.maxOutputTokens),
        });
        const usage = usageFromSdk(result.usage, options.pricing);
        // The SDK parses the output only when the model stopped or produced text; an
        // empty reply (e.g. finishReason "error" or "length" at zero text) surfaces as
        // NoOutputGeneratedError from the getter. The tokens were billed either way.
        let object: T;
        try {
          object = result.output;
        } catch (cause) {
          if (!NoOutputGeneratedError.isInstance(cause)) throw cause;
          return err({
            kind: 'invalid_output',
            issues: [`no output (finishReason=${result.finishReason})`],
            raw: result.text,
            usage,
          });
        }
        return ok({
          object,
          usage,
          latencyMs: Math.max(0, now() - startedMs),
          modelId: options.id,
          warnings: (result.warnings ?? []).map(describeWarning),
        });
      } catch (cause) {
        if (NoObjectGeneratedError.isInstance(cause)) {
          const usage =
            cause.usage === undefined ? zeroUsage() : usageFromSdk(cause.usage, options.pricing);
          return err({
            kind: 'invalid_output',
            issues: issuesOf(cause, usage.outputTokens),
            raw: cause.text ?? '',
            usage,
          });
        }
        return err(classifyProviderError(cause));
      }
    },
  };
};
