// Counting an answer's words, and the least of its word budget an answer may come back
// with. Shared by the baseline's length guard, the reports and the judge-only session.

/** Words in an answer as a reader would count them: runs of non-space characters. */
export const wordCount = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

/**
 * Under half the words it was asked for, an answer is not that arm's answer: the swarm's
 * write-up is asked for once more (core, agents/word-budget.ts) and so is the baseline
 * (baseline.ts), and a baseline that is still short is void.
 */
export const MIN_WORD_SHARE = 0.5;

export const isShort = (words: number, wordBudget: number): boolean =>
  words < wordBudget * MIN_WORD_SHARE;
