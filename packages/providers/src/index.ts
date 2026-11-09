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

export { classifyProviderError } from './errors';
export { PRICE_TABLE, pricingFor } from './pricing';
export type { RetryPolicy } from './retry';
export { backoffDelayMs, DEFAULT_RETRY_POLICY, withRetry } from './retry';
export type { ModelCallTrace, TraceSink } from './trace';
export { traceModel } from './trace';
