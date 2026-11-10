import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sequentialId } from '../testing/sequential-id-generator';
import {
  CONTRIBUTION_TYPES,
  ContributionSchema,
  contributionSchema,
  contributionSchemas,
  UUID_REFERENCES,
} from './contribution';

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

describe('contributionSchema over handle references', () => {
  const refs = (live: Partial<Record<'hypothesis' | 'subproblem', string[]>>) => ({
    any: z.enum(['P1', 'S1', 'H1', 'E1']),
    liveOf: Object.fromEntries(
      Object.entries(live).map(([type, handles]) => [type, z.enum(handles)]),
    ),
    paragraphs: true as const,
  });

  it('accepts only the handles in the enum', () => {
    const schema = contributionSchema(refs({ hypothesis: ['H1'] }));
    const ok = schema.safeParse({
      type: 'hypothesis',
      content: 'x',
      parents: ['S1'],
      supersedes: 'H1',
      payload: { confidence: 0.5, supportedBy: ['E1'], contradictedBy: [] },
    });
    expect(ok.success).toBe(true);
    const unknown = schema.safeParse({
      type: 'hypothesis',
      content: 'x',
      parents: ['H9'],
      payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
    });
    expect(unknown.success).toBe(false);
    const uuidParent = schema.safeParse({
      type: 'evidence',
      content: 'x',
      parents: [id(2)],
      payload: { source: 's', supports: [], contradicts: [] },
    });
    expect(uuidParent.success).toBe(false);
  });

  it('only lets a contribution supersede a live entry of its own type', () => {
    const schema = contributionSchema(refs({ hypothesis: ['H1'] }));
    expect(
      schema.safeParse({
        type: 'hypothesis',
        content: 'x',
        parents: [],
        supersedes: 'S1',
        payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
      }).success,
    ).toBe(false);
  });

  it('leaves supersedes out of the schema when nothing of that type is live', () => {
    const schema = contributionSchemas(refs({ hypothesis: ['H1'] }));
    expect('supersedes' in schema.hypothesis.shape).toBe(true);
    expect('supersedes' in schema.evidence.shape).toBe(false);
    const json = z.toJSONSchema(schema.evidence) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).toEqual(['type', 'content', 'parents', 'payload']);
    // A stray supersedes is stripped rather than committed as a link.
    const parsed = schema.evidence.safeParse({
      type: 'evidence',
      content: 'x',
      parents: ['P1'],
      supersedes: 'E1',
      payload: { source: 's', supports: [], contradicts: [] },
    });
    expect(parsed.success && 'supersedes' in parsed.data).toBe(false);
  });

  it('keeps every supersedes field with UUID references', () => {
    for (const type of CONTRIBUTION_TYPES) {
      expect('supersedes' in contributionSchemas(UUID_REFERENCES)[type].shape).toBe(true);
    }
  });
});
