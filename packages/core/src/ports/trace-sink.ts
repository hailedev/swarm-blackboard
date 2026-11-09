import type { ModelCallTrace } from '../schemas/model-call';

/** Where traced model calls go: a JSONL file, the model_calls table, a test array. */
export type TraceSink = (trace: ModelCallTrace) => void;
