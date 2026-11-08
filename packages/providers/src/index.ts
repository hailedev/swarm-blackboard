// Model adapters live here (AI SDK adapters arrive in Phase 2). FakeModel is
// defined in @team/core because core's own tests need it; it is re-exported
// here so every consumer still gets its models from @team/providers.
export type {
  FakeModel,
  FakeModelOptions,
  FakeResponse,
  FakeScript,
  Model,
  ModelCallTags,
  ModelError,
  ModelRequest,
  ModelResponse,
  RecordedCall,
} from '@team/core';
export { createFakeModel } from '@team/core';
