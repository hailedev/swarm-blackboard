// How many words an output allowance buys, and the sentence that tells a model so. Pure
// arithmetic and text, shared by every long-form answer that is written under a token
// allowance: the eval's single-call baseline (evals/src/baseline.ts) and the swarm's final
// write-up (agents/write-up.ts). One function and one sentence, so two answers given the
// same allowance are asked for the same length in the same words.

// Measured, not assumed. English prose runs about three quarters of a word per token, but
// an answer returned as JSON paragraphs of markdown costs far more tokens per word. The
// first paid pilot (evals/results/2026-11-10-pilot-attempt-1) set 0.75 and lost all three
// Sonnet baselines to the allowance. The third (evals/results/2026-11-15-pilot-3) set 0.6:
// Sonnet wrote almost exactly the words it was asked for (1,277 to 1,397 for 1,350) and
// spent 1.9 to 2.1 output tokens on each, so all three were cut off again. At 0.4 a model
// that writes its whole budget at 2.1 tokens per word still ends inside the allowance.
// Then headroom for the JSON around the paragraphs, rounded down to a round number, never
// below a floor a useful answer needs.
export const WORDS_PER_TOKEN = 0.4;
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
export const lengthInstruction = (wordBudget: number): string =>
  `Length: you have about ${String(wordBudget)} words for the whole answer, all paragraphs together. Use most of them: a thorough answer that fills the room beats a terse one, and anything past the limit is cut off.`;
