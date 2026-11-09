import { describe, expect, it } from 'vitest';

import {
  HANDLE_LEGEND,
  HANDLE_PREFIX,
  HandleSchema,
  compareHandles,
  handleFor,
  typeOfHandle,
} from './handle';
import { ENTRY_TYPES } from './payloads';

describe('handles', () => {
  it('gives every entry type a distinct letter and a legend in type order', () => {
    const letters = ENTRY_TYPES.map((type) => HANDLE_PREFIX[type]);
    expect(new Set(letters).size).toBe(ENTRY_TYPES.length);
    expect(letters.every((letter) => /^[A-Z]$/.test(letter))).toBe(true);
    expect(HANDLE_LEGEND).toBe(
      'P problem, S subproblem, H hypothesis, E evidence, C critique, Q question, D decision, A synthesis, N human note',
    );
  });

  it('builds, validates and reads handles back', () => {
    expect(handleFor('hypothesis', 3)).toBe('H3');
    expect(handleFor('human_note', 12)).toBe('N12');
    expect(HandleSchema.safeParse('E7').success).toBe(true);
    expect(HandleSchema.safeParse('e7').success).toBe(false);
    expect(HandleSchema.safeParse('H').success).toBe(false);
    expect(HandleSchema.safeParse('0190a9a2-2d9f-7b7a-8d0a-9d0a6e4f3c21').success).toBe(false);
    expect(typeOfHandle('C2')).toBe('critique');
    expect(typeOfHandle('X1')).toBeUndefined();
  });

  it('sorts by type order, then ordinal, unknown letters last', () => {
    const sorted = ['E10', 'H2', 'P1', 'E2', 'X1', 'S1', 'A1', 'H1'].sort(compareHandles);
    expect(sorted).toEqual(['P1', 'S1', 'H1', 'H2', 'E2', 'E10', 'A1', 'X1']);
  });
});
