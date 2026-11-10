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
// The model is told the budget as a word count derived from that allowance, so a shrunk
// allowance produces a shorter answer rather than a cut-off one; an answer that still runs
// into the allowance is kept and reported as truncated.
//
// Answers are cached by problem and model, so a later pass compares a new swarm against
// the same baseline instead of paying for it again; the record keeps the cap and the word
// budget it was given, and the report says when either has drifted from the current pass.

// The answer is an array of paragraphs, joined with a blank line, for the same reason the
// Synthesizer's is (ADR-0008, third amendment): a local model under a JSON `format` may
// be unable to put a line break inside a string, and closes the string instead where a
// markdown heading or paragraph would end. The rehearsal that found this is in
// evals/results/2026-11-10-dev-rehearsal (its first baseline answer was 31 tokens long).
export const BASELINE_SYSTEM = [
  'You are a careful analyst answering a problem for the person who posed it. Lead with',
  'your recommendation, then the reasoning behind it, then the main caveats and open',
  'questions. Address every success criterion explicitly and respect every constraint.',
  'Return JSON matching the schema: `paragraphs` is the answer as an array of strings, one',
  'paragraph per element in plain markdown with no line breaks inside it; a heading or a',
  'list item is its own element. The prompt ends with the length you have: plan the answer',
  'to use most of it and to finish inside it, since anything past it is cut off. Explain',
  'rather than summarise while there is room; do not pad once the point is made.',
].join(' ');

/** Bump when the system prompt, the answer shape or the prompt layout changes, so cached answers are redone. */
export const BASELINE_PROMPT_VERSION = 4;

export const BaselineAnswerSchema = z.object({ paragraphs: z.array(z.string().min(1)).min(1) });

export const PARAGRAPH_SEPARATOR = '\n\n';

// Words the output allowance buys, deliberately conservative: English prose runs about
// three quarters of a word per token, but a model told it has N words tends to write more,
// and markdown and JSON escapes cost tokens too. The first paid pilot
// (evals/results/2026-11-10-pilot-attempt-1) set 0.75 and lost all three Sonnet baselines
// to the allowance; at 0.6 a 40 % overshoot still fits. Then headroom for the JSON around
// the paragraphs, rounded down to a round number, never below a floor a useful answer needs.
export const WORDS_PER_TOKEN = 0.6;
export const JSON_HEADROOM = 0.85;
export const WORD_BUDGET_STEP = 50;
export const MIN_WORD_BUDGET = 100;

export const wordBudgetFor = (maxOutputTokens: number): number =>
  Math.max(
    MIN_WORD_BUDGET,
    Math.floor((maxOutputTokens * WORDS_PER_TOKEN * JSON_HEADROOM) / WORD_BUDGET_STEP) *
      WORD_BUDGET_STEP,
  );

// Worded to be used, not just obeyed: told only to "fit in N words", a local model in the
// rehearsal wrote a tenth of its budget as one paragraph (evals/results/2026-11-10-dev-rehearsal).
export const baselinePrompt = (problem: Problem, wordBudget: number): string =>
  `${problemText(problem)}\n\nLength: you have about ${String(wordBudget)} words for the whole answer, all paragraphs together. Use most of them: a thorough answer that fills the room beats a terse one, and anything past the limit is cut off.`;

/**
 * The key a cached answer must still match: the problem text, the prompt layout and the
 * model. The word budget is deliberately not part of it, so a pass reuses the baseline
 * when only the swarm's cost has moved; the report shows the drift instead.
 */
export const baselineCacheKey = (problem: Problem, modelId: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: BASELINE_PROMPT_VERSION,
        system: BASELINE_SYSTEM,
        problem: problemText(problem),
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
  /** The length the prompt asked for, derived from the allowance. */
  wordBudget: z.int().positive(),
  /** The answer used its whole allowance, so its end is probably missing. */
  truncated: z.boolean(),
  answer: z.string().min(1),
  usage: UsageSchema,
  latencyMs: z.int().nonnegative(),
  at: z.string().min(1),
  passId: z.string().min(1),
});
export type BaselineRecord = z.infer<typeof BaselineRecordSchema>;

export interface BaselineCache {
  /** One record per problem and model; the pass checks the record's `key` before using it. */
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

export interface SizedBaseline {
  fit: Fit;
  wordBudget: number;
  prompt: string;
}

/** Whether, at what output allowance and for how many words the baseline call fits its cap. */
export const sizeBaseline = (request: BaselineRequest): SizedBaseline => {
  const { model, problem, capUsd, maxOutputTokens } = request;
  // The prompt's length barely depends on the budget figure, so size on the requested
  // allowance and then word the prompt for the allowance that fits.
  const estimate = estimateInput(
    {
      system: BASELINE_SYSTEM,
      prompt: baselinePrompt(problem, wordBudgetFor(maxOutputTokens)),
      schema: BaselineAnswerSchema,
    },
    model.charsPerToken,
  );
  const fit = fitCall({
    pricing: model.pricing,
    inputTokens: estimate.tokens,
    maxOutputTokens,
    remainingUsd: capUsd,
  });
  const wordBudget = wordBudgetFor(fit.fits ? fit.maxOutputTokens : 0);
  return { fit, wordBudget, prompt: baselinePrompt(problem, wordBudget) };
};

/** The model wrote up to its allowance: whatever it meant to say next is missing. */
export const hitAllowance = (outputTokens: number, maxOutputTokens: number): boolean =>
  outputTokens >= maxOutputTokens - 1;

/**
 * The complete paragraphs of an answer whose JSON never closed: every finished string
 * element after `"paragraphs"`, unescaped. The unfinished last element has no closing
 * quote and is left out. Empty when nothing finished.
 */
export const salvageParagraphs = (raw: string): string[] => {
  const start = raw.indexOf('"paragraphs"');
  if (start === -1) return [];
  const body = raw.slice(raw.indexOf('[', start) + 1);
  const paragraphs: string[] = [];
  for (const match of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const text: unknown = JSON.parse(match[0]);
      if (typeof text === 'string' && text.length > 0) paragraphs.push(text);
    } catch {
      // an escape sequence the grammar never finished: stop at the last good paragraph
      break;
    }
  }
  return paragraphs;
};

export type BaselineError =
  | { kind: 'does_not_fit'; fit: Extract<Fit, { fits: false }> }
  /** The answer ran into its allowance and never closed its JSON. */
  | { kind: 'truncated'; maxOutputTokens: number; usage: ModelError & { kind: 'invalid_output' } }
  | ModelError;

export const generateBaseline = async (
  request: BaselineRequest,
  tags: ModelCallTags,
  nowMs: number,
): Promise<Result<BaselineRecord, BaselineError>> => {
  const sized = sizeBaseline(request);
  const fit = sized.fit;
  if (!fit.fits) return err({ kind: 'does_not_fit', fit });
  const response = await request.model.generateObject({
    schema: BaselineAnswerSchema,
    system: BASELINE_SYSTEM,
    prompt: sized.prompt,
    maxOutputTokens: fit.maxOutputTokens,
    tags,
  });
  const record = (
    paragraphs: readonly string[],
    usage: BaselineRecord['usage'],
    latencyMs: number,
    truncated: boolean,
  ): BaselineRecord => ({
    key: baselineCacheKey(request.problem, request.model.id),
    problemId: request.problem.id,
    modelId: request.model.id,
    capUsd: request.capUsd,
    maxOutputTokens: fit.maxOutputTokens,
    wordBudget: sized.wordBudget,
    truncated,
    answer: paragraphs.join(PARAGRAPH_SEPARATOR),
    usage,
    latencyMs,
    at: isoFromMs(nowMs),
    passId: tags.runId,
  });
  if (!response.ok) {
    const error = response.error;
    if (
      error.kind === 'invalid_output' &&
      hitAllowance(error.usage.outputTokens, fit.maxOutputTokens)
    ) {
      // Cut off before the JSON closed: judge what finished, flagged, rather than nothing.
      const salvaged = salvageParagraphs(error.raw);
      if (salvaged.length > 0) return ok(record(salvaged, error.usage, 0, true));
      return err({ kind: 'truncated', maxOutputTokens: fit.maxOutputTokens, usage: error });
    }
    return err(error);
  }
  return ok(
    record(
      response.value.object.paragraphs,
      response.value.usage,
      response.value.latencyMs,
      hitAllowance(response.value.usage.outputTokens, fit.maxOutputTokens),
    ),
  );
};

export const describeBaselineError = (error: BaselineError): string => {
  switch (error.kind) {
    case 'does_not_fit':
      return `the cap of $${error.fit.remainingUsd.toFixed(4)} does not cover the smallest useful call ($${error.fit.worstCaseUsd.toFixed(4)})`;
    case 'truncated':
      return `truncated: the answer used its whole allowance of ${String(error.maxOutputTokens)} output tokens and not one paragraph was finished`;
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
