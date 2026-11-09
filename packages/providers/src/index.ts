// Model adapters live here (AI SDK adapters arrive with the rest of Phase 2). FakeModel
// is defined in @team/core because core's own tests need it; it is re-exported here so
// every consumer still gets its models from @team/providers.
export type {
  FakeModel,
  FakeModelOptions,
  FakeResponse,
  FakeScript,
  FakeUsage,
  Model,
  ModelBilling,
  ModelCallTags,
  ModelError,
  ModelErrorKind,
  ModelRequest,
  ModelResponse,
  RecordedCall,
} from '@team/core';
export { createFakeModel } from '@team/core';

export type { AiSdkModelOptions } from './ai-sdk-model';
export { createAiSdkModel, describeWarning, usageFromSdk } from './ai-sdk-model';
export type { AnthropicModelOptions, AnthropicStructuredOutputMode } from './anthropic';
export { ANTHROPIC_CHARS_PER_TOKEN, ANTHROPIC_TIMEOUT_MS, createAnthropicModel } from './anthropic';
export { classifyProviderError } from './errors';
export type {
  CharsPerTokenLookup,
  FactoryError,
  ModelFactory,
  ModelFactoryOptions,
} from './factory';
export { composeModel, createModelFactory, describeFactoryError } from './factory';
export type { OllamaModelOptions } from './ollama';
export {
  createOllamaModel,
  OLLAMA_CHARS_PER_TOKEN,
  OLLAMA_NUM_CTX,
  OLLAMA_THINK_TOKENS,
  OLLAMA_TIMEOUT_MS,
  ollamaApiUrl,
} from './ollama';
export type {
  Fetch,
  OllamaFormatProbeOptions,
  OllamaFormatProbeResult,
  OllamaPreflightError,
  OllamaPreflightOptions,
  OllamaPreflightReport,
} from './ollama-preflight';
export {
  describeOllamaPreflightError,
  FORMAT_PROBE,
  preflightOllama,
  probeOllamaFormat,
} from './ollama-preflight';
export { PRICE_TABLE, pricingFor } from './pricing';
export type { RetryPolicy } from './retry';
export { backoffDelayMs, DEFAULT_RETRY_POLICY, withRetry } from './retry';
export type { ModelCallTrace, TraceSink } from './trace';
export { traceModel } from './trace';
