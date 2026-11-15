import { describe, expect, it } from 'vitest';

import { MIN_OUTPUT_TOKENS } from '../controller/reservation';
import { lengthInstruction, MIN_WORD_BUDGET, WORD_BUDGET_STEP, wordBudgetFor } from './word-budget';

describe('wordBudgetFor', () => {
  it('derives a round word count from the allowance, never below the floor', () => {
    expect(wordBudgetFor(4_096)).toBe(1_350);
    expect(wordBudgetFor(1_700)).toBe(550);
    // The allowance a $0.03 cap buys the Sonnet baseline, and the write-up's default.
    expect(wordBudgetFor(2_690)).toBe(900);
    expect(wordBudgetFor(2_700)).toBe(900);
    expect(wordBudgetFor(MIN_OUTPUT_TOKENS)).toBe(MIN_WORD_BUDGET);
    expect(wordBudgetFor(10)).toBe(MIN_WORD_BUDGET);
    expect(wordBudgetFor(1_000) % WORD_BUDGET_STEP).toBe(0);
  });

  it('never promises more words than the allowance has tokens', () => {
    for (const tokens of [512, 1_024, 2_700, 4_096, 8_192]) {
      expect(wordBudgetFor(tokens)).toBeLessThan(tokens);
    }
  });
});

describe('lengthInstruction', () => {
  it('states the budget and asks for it to be used', () => {
    const line = lengthInstruction(900);
    expect(line).toContain('you have about 900 words');
    expect(line).toContain('Use most of them');
    expect(line.startsWith('Length: ')).toBe(true);
  });
});
