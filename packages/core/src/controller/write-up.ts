import type { ZodType } from 'zod';

import type { RoleModels } from '../agents/agent';
import { wordBudgetFor } from '../agents/word-budget';
import {
  renderWriteUpPrompt,
  writeUpOutputSchema,
  type RenderedWriteUp,
  type WriteUpOutput,
} from '../agents/write-up';
import type { BoardView } from '../board/board-view';
import { worstCaseCostUsd } from '../schemas/pricing';
import type { WriteUpConfig } from '../schemas/run-config';
import { estimateInput, fitCall, SCHEMA_FALLBACK_CHARS, type Fit } from './reservation';

// The money side of the final write-up (docs/PLAN.md §2.3 step 8, docs/budget-guardrails.md
// §2). The call is made when the run is over, so its cost cannot come out of what is left
// at that point: a run that ends because the cap is spent would have nothing to write its
// answer with. Instead the worst case of the call is held back from the cap when the run
// starts (`BudgetTracker`'s hold) and handed back to it when the call is due. Both figures
// that bound that worst case are in `RunConfig.writeUp`.

/** What the controller writes the final answer with: the Synthesizer's models and the prompt. */
export interface WriteUpDeps extends RoleModels {
  /** The system prompt, from prompts/write-up.md through the host. */
  prompt: string;
}

/**
 * Characters allowed for what the prompt holds besides the board: the problem with its
 * constraints and criteria, the human notes and the closing instructions. A problem longer
 * than this makes the prompt larger than the hold assumed; the call is still fitted to
 * what is left when it is made, so the cap holds and the allowance shrinks instead.
 */
export const WRITE_UP_FRAME_CHARS = 6_000;

/**
 * Dollars to hold back from the cap for the write-up: the worst case of one call on the
 * primary model, at the largest board the prompt may hold and the full output allowance.
 * Zero for a free model. A repair or a fallback after a malformed answer is not held for:
 * it runs on what is left, and is refused when nothing is.
 */
export const writeUpHoldUsd = (writer: WriteUpDeps, config: WriteUpConfig): number => {
  const { pricing, charsPerToken } = writer.model;
  if (pricing === null) return 0;
  const chars =
    writer.prompt.length + WRITE_UP_FRAME_CHARS + config.maxBoardChars + SCHEMA_FALLBACK_CHARS;
  return worstCaseCostUsd(pricing, Math.ceil(chars / charsPerToken), config.maxOutputTokens);
};

export interface SizedWriteUp {
  fit: Fit;
  /** The words the prompt asks for: what the allowance that fits buys (word-budget.ts). */
  wordBudget: number;
  rendered: RenderedWriteUp;
  schema: ZodType<WriteUpOutput>;
}

/**
 * Whether, at what output allowance and for how many words the write-up fits what is left,
 * the way the eval sizes its baseline: fit first, then word the prompt for the allowance
 * that fits, so a shrunk allowance asks for a shorter answer instead of cutting one off.
 * The prompt's length barely depends on the word figure, so it is sized on the configured
 * allowance and rendered again only when the allowance shrank.
 */
export const sizeWriteUp = (
  writer: WriteUpDeps,
  view: BoardView,
  config: WriteUpConfig,
  remainingUsd: number,
): SizedWriteUp => {
  const requested = renderWriteUpPrompt(view, config, wordBudgetFor(config.maxOutputTokens));
  const schema = writeUpOutputSchema(requested.citeable);
  const estimate = estimateInput(
    { system: writer.prompt, prompt: requested.prompt, schema },
    writer.model.charsPerToken,
  );
  const fit = fitCall({
    pricing: writer.model.pricing,
    inputTokens: estimate.tokens,
    maxOutputTokens: config.maxOutputTokens,
    remainingUsd,
  });
  const wordBudget = wordBudgetFor(fit.fits ? fit.maxOutputTokens : 0);
  const rendered =
    fit.fits && fit.shrunk ? renderWriteUpPrompt(view, config, wordBudget) : requested;
  return { fit, wordBudget, rendered, schema };
};
