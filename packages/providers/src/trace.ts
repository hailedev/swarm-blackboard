import {
  isoFromMs,
  type Model,
  type ModelBilling,
  type ModelCallTags,
  type ModelErrorKind,
  type Usage,
} from '@team/core';

// Every model call is traced: prompt, response, tokens, cost, latency (CLAUDE.md
// architecture rule 6). The sink decides where it goes: the CLI's spend ledger now,
// the model_calls table in Phase 3. Trace contents never reach the info log.
export interface ModelCallTrace {
  at: string;
  modelId: string;
  billing: ModelBilling;
  tags: ModelCallTags;
  request: { system: string; prompt: string; maxOutputTokens: number | null };
  outcome: 'ok' | ModelErrorKind;
  /** Null when the call failed before the model produced anything billable. */
  usage: Usage | null;
  latencyMs: number;
  /** The validated object, the raw text of a rejected answer, or null. */
  response: unknown;
  error: string | null;
}

export type TraceSink = (trace: ModelCallTrace) => void;

export const traceModel = (model: Model, sink: TraceSink, now: () => number = Date.now): Model => ({
  id: model.id,
  billing: model.billing,
  pricing: model.pricing,
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
      latencyMs: Math.max(0, now() - startedMs),
    };
    if (result.ok) {
      sink({
        ...base,
        outcome: 'ok',
        usage: result.value.usage,
        response: result.value.object,
        error: null,
      });
    } else if (result.error.kind === 'invalid_output') {
      sink({
        ...base,
        outcome: result.error.kind,
        usage: result.error.usage,
        response: result.error.raw,
        error: result.error.issues.join('; '),
      });
    } else {
      sink({
        ...base,
        outcome: result.error.kind,
        usage: null,
        response: null,
        error: 'message' in result.error ? result.error.message : result.error.kind,
      });
    }
    return result;
  },
});
