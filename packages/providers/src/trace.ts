import {
  estimateInput,
  isoFromMs,
  promptTokens,
  type Model,
  type TraceSink,
  type Usage,
} from '@team/core';

export type { ModelCallTrace, TraceSink } from '@team/core';

// Every model call is traced: prompt, response, tokens, cost, latency (CLAUDE.md
// architecture rule 6). The sink decides where it goes: the model_calls table, a JSONL
// file, a test array. Trace contents never reach the info log. The trace shape itself is
// core's `ModelCallTraceSchema`, so hosts can validate what they store and read back.

// A real prompt is never zero tokens, so zero means the provider reported no count
// (Ollama omits prompt_eval_count on a KV-cache hit).
const reportedPromptTokens = (usage: Usage): number | null => {
  const tokens = promptTokens(usage);
  return tokens > 0 ? tokens : null;
};

export const traceModel = (model: Model, sink: TraceSink, now: () => number = Date.now): Model => ({
  id: model.id,
  billing: model.billing,
  pricing: model.pricing,
  charsPerToken: model.charsPerToken,
  async generateObject(request) {
    const startedMs = now();
    const result = await model.generateObject(request);
    const base = {
      at: isoFromMs(startedMs),
      modelId: model.id,
      billing: model.billing,
      tags: request.tags,
      request: {
        system: request.system,
        prompt: request.prompt,
        maxOutputTokens: request.maxOutputTokens ?? null,
      },
      // The same estimate the controller reserved against, recomputed from the same inputs.
      estimate: estimateInput(request, model.charsPerToken),
      latencyMs: Math.max(0, now() - startedMs),
    };
    if (result.ok) {
      sink({
        ...base,
        outcome: 'ok',
        usage: result.value.usage,
        actualInputTokens: reportedPromptTokens(result.value.usage),
        warnings: result.value.warnings,
        response: result.value.object,
        error: null,
      });
    } else if (result.error.kind === 'invalid_output') {
      sink({
        ...base,
        outcome: result.error.kind,
        usage: result.error.usage,
        actualInputTokens: reportedPromptTokens(result.error.usage),
        warnings: [],
        response: result.error.raw,
        error: result.error.issues.join('; '),
      });
    } else {
      sink({
        ...base,
        outcome: result.error.kind,
        usage: null,
        actualInputTokens: null,
        warnings: [],
        response: null,
        error: 'message' in result.error ? result.error.message : result.error.kind,
      });
    }
    return result;
  },
});
