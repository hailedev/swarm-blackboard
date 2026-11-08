import { describe, expect, it } from 'vitest';

import { sequentialId } from '../testing/sequential-id-generator';
import { ContributionSchema } from './contribution';

const id = sequentialId;

describe('ContributionSchema', () => {
  it('accepts an agent contribution without controller-stamped fields', () => {
    const result = ContributionSchema.safeParse({
      type: 'hypothesis',
      content: 'Adopt a monorepo',
      parents: [id(2)],
      payload: { confidence: 0.7, supportedBy: [], contradictedBy: [] },
    });
    expect(result.success).toBe(true);
  });

  it('strips unknown keys so model output with extras still validates', () => {
    const result = ContributionSchema.safeParse({
      type: 'question',
      content: 'What is the budget?',
      parents: [],
      payload: {},
      rationale: 'not part of the schema',
    });
    expect(result.success).toBe(true);
    if (result.success) expect('rationale' in result.data).toBe(false);
  });

  it.each(['problem', 'human_note'])('rejects %s, which agents never produce', (type) => {
    const result = ContributionSchema.safeParse({
      type,
      content: 'x',
      parents: [],
      payload: { constraints: [], successCriteria: [], priority: 'high' },
    });
    expect(result.success).toBe(false);
  });

  it('requires content and valid parent ids', () => {
    expect(
      ContributionSchema.safeParse({ type: 'question', content: '', parents: [], payload: {} })
        .success,
    ).toBe(false);
    expect(
      ContributionSchema.safeParse({
        type: 'question',
        content: 'x',
        parents: ['not-an-id'],
        payload: {},
      }).success,
    ).toBe(false);
  });
});
