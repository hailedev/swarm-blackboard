// How many words an output allowance buys, and the sentence that tells a model so. Pure
// arithmetic and text, shared by every long-form answer that is written under a token
// allowance: the eval's single-call baseline (evals/src/baseline.ts) and the swarm's final
// write-up (agents/write-up.ts). One function and one sentence, so two answers given the
// same allowance are asked for the same length in the same words.

// Deliberately conservative: English prose runs about three quarters of a word per token,
// but a model told it has N words tends to write more, and markdown and JSON escapes cost
// tokens too. The first paid pilot (evals/results/2026-11-10-pilot-attempt-1) set 0.75 and
// lost all three Sonnet baselines to the allowance; at 0.6 a 40 % overshoot still fits. Then
// headroom for the JSON around the paragraphs, rounded down to a round number, never below
// a floor a useful answer needs.
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
export const lengthInstruction = (wordBudget: number): string =>
  `Length: you have about ${String(wordBudget)} words for the whole answer, all paragraphs together. Use most of them: a thorough answer that fills the room beats a terse one, and anything past the limit is cut off.`;
