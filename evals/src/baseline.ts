import { createHash } from 'node:crypto';

import {
  err,
  estimateInput,
  fitCall,
  isoFromMs,
  ok,
  UsageSchema,
  type Fit,
  type Model,
  type ModelCallTags,
  type ModelError,
  type Result,
} from '@team/core';
import { z } from 'zod';

import { problemText, type Problem } from './problems';

// The single-agent arm (ADR-0012): one call of a strong model on the same problem text,
// capped at the dollar cost of that problem's swarm run. The cap is enforced the way the
// controller enforces a run's cap: the call is sized with core's reservation arithmetic
// and shrinks its output allowance to fit, or is skipped when even the floor does not fit.
//
// Answers are cached by problem, prompt and model, so a later pass compares a new swarm
// against the same baseline instead of paying for it again; the record keeps the cap it
// was given, and the report says when that cap has drifted from the swarm's current cost.

export const BASELINE_SYSTEM = [
  'You are a careful analyst answering a problem for the person who posed it. Lead with',
  'your recommendation, then the reasoning behind it, then the main caveats and open',
  'questions. Address every success criterion explicitly and respect every constraint.',
  'Write in plain markdown paragraphs. Do not pad: a complete answer beats a long one.',
].join(' ');

/** Bump when the system prompt or the prompt layout changes, so cached answers are redone. */
export const BASELINE_PROMPT_VERSION = 1;

export const BaselineAnswerSchema = z.object({ answer: z.string().min(1) });

export const baselinePrompt = (problem: Problem): string => problemText(problem);

export const baselineCacheKey = (problem: Problem, modelId: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: BASELINE_PROMPT_VERSION,
        system: BASELINE_SYSTEM,
        prompt: baselinePrompt(problem),
        modelId,
      }),
    )
    .digest('hex');

export const BaselineRecordSchema = z.object({
  key: z.string().min(1),
  problemId: z.string().min(1),
  modelId: z.string().min(1),
  /** The dollar cap the call was sized for: the swarm's cost on the pass that made it. */
  capUsd: z.number().nonnegative(),
  maxOutputTokens: z.int().positive(),
  answer: z.string().min(1),
  usage: UsageSchema,
  latencyMs: z.int().nonnegative(),
  at: z.string().min(1),
  passId: z.string().min(1),
});
export type BaselineRecord = z.infer<typeof BaselineRecordSchema>;

/**
 * One record per problem and model, so a `dev` rehearsal's local answers never stand in
 * for a paid pass's. The pass still checks the record's `key` before using it: a change to
 * the prompt or the problem text makes a stored answer stale even for the same model.
 */
export interface BaselineCache {
  get(problemId: string, modelId: string): Promise<BaselineRecord | undefined>;
  put(record: BaselineRecord): Promise<void>;
}

export interface BaselineRequest {
  model: Model;
  problem: Problem;
  /** The most the call may cost; the output allowance shrinks to fit it. */
  capUsd: number;
  maxOutputTokens: number;
}

/** Whether, and at what output allowance, the baseline call fits its cap. */
export const sizeBaseline = ({ model, problem, capUsd, maxOutputTokens }: BaselineRequest): Fit => {
  const estimate = estimateInput(
    { system: BASELINE_SYSTEM, prompt: baselinePrompt(problem), schema: BaselineAnswerSchema },
    model.charsPerToken,
  );
  return fitCall({
    pricing: model.pricing,
    inputTokens: estimate.tokens,
    maxOutputTokens,
    remainingUsd: capUsd,
  });
};

export type BaselineError =
  { kind: 'does_not_fit'; fit: Extract<Fit, { fits: false }> } | ModelError;

export const generateBaseline = async (
  request: BaselineRequest,
  tags: ModelCallTags,
  nowMs: number,
): Promise<Result<BaselineRecord, BaselineError>> => {
  const fit = sizeBaseline(request);
  if (!fit.fits) return err({ kind: 'does_not_fit', fit });
  const response = await request.model.generateObject({
    schema: BaselineAnswerSchema,
    system: BASELINE_SYSTEM,
    prompt: baselinePrompt(request.problem),
    maxOutputTokens: fit.maxOutputTokens,
    tags,
  });
  if (!response.ok) return err(response.error);
  return ok({
    key: baselineCacheKey(request.problem, request.model.id),
    problemId: request.problem.id,
    modelId: request.model.id,
    capUsd: request.capUsd,
    maxOutputTokens: fit.maxOutputTokens,
    answer: response.value.object.answer,
    usage: response.value.usage,
    latencyMs: response.value.latencyMs,
    at: isoFromMs(nowMs),
    passId: tags.runId,
  });
};

export const describeBaselineError = (error: BaselineError): string => {
  switch (error.kind) {
    case 'does_not_fit':
      return `the cap of $${error.fit.remainingUsd.toFixed(4)} does not cover the smallest useful call ($${error.fit.worstCaseUsd.toFixed(4)})`;
    case 'invalid_output':
      return `the model's answer failed the schema: ${error.issues.join('; ')}`;
    case 'script_exhausted':
      return `the scripted model ran out after ${String(error.calls)} calls`;
    case 'billing':
    case 'auth':
    case 'invalid_request':
    case 'rate_limit':
    case 'overloaded':
    case 'network':
      return `${error.kind}: ${error.message}`;
  }
};
