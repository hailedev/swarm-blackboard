import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sequentialId } from '../testing/sequential-id-generator';
import {
  answerSchemas,
  CONTRIBUTION_TYPES,
  ContributionSchema,
  contributionSchema,
  contributionSchemas,
  newVersionOf,
  parseRelation,
  RELATION_RIVAL,
  UUID_REFERENCES,
  type AnswerRefs,
  type ModelReferenceSchemas,
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

  it('gives no model, and no contribution, a way to set a synthesis stage', () => {
    // The stage is the controller's to stamp (schemas/payloads.ts): the schema a model
    // answers against does not name it, and a contribution that carries one loses it.
    const modelFacing = contributionSchemas(refs({})).synthesis;
    expect(JSON.stringify(z.toJSONSchema(modelFacing))).not.toContain('stage');
    const stored = ContributionSchema.parse({
      type: 'synthesis',
      content: 'The answer.',
      parents: [],
      payload: { version: 1, confidence: 0.9, cites: [], stage: 'final' },
    });
    expect(stored.type === 'synthesis' && 'stage' in stored.payload).toBe(false);
  });

  it('gives no model a way to post a critique that is already resolved', () => {
    // A critique closes when what it attacks is replaced, not on its author's say-so.
    const modelFacing = contributionSchemas(refs({})).critique;
    expect(JSON.stringify(z.toJSONSchema(modelFacing))).not.toContain('resolvedBy');
    const parsed = modelFacing.parse({
      type: 'critique',
      content: 'No rollback path.',
      parents: ['H1'],
      payload: { target: 'H1', severity: 'blocking', resolvedBy: 'H1' },
    });
    // A model that sends the field anyway loses it; the critique itself is kept.
    expect(parsed.payload).toEqual({ target: 'H1', severity: 'blocking' });
    // The stored shape keeps it, for the logs written before this.
    const stored = ContributionSchema.parse({
      type: 'critique',
      content: 'No rollback path.',
      parents: [],
      payload: { target: id(2), severity: 'blocking', resolvedBy: id(3) },
    });
    expect(stored.type === 'critique' && stored.payload.resolvedBy).toBe(id(3));
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

describe('the critiques a hypothesis may say it resolves', () => {
  const hypothesis = (resolves?: string[]) => ({
    type: 'hypothesis',
    content: 'A new version.',
    parents: [],
    payload: {
      confidence: 0.7,
      supportedBy: [],
      contradictedBy: [],
      ...(resolves === undefined ? {} : { resolves }),
    },
  });

  it('are an enum of the critiques in view that still stand', () => {
    const schema = contributionSchemas({
      any: z.enum(['P1', 'H1', 'C1', 'C2']),
      // Both critiques are live entries; only C2 still stands against something.
      liveOf: { hypothesis: z.enum(['H1']), critique: z.enum(['C1', 'C2']) },
      openCritiques: z.enum(['C2']),
      paragraphs: true,
    }).hypothesis;
    expect(schema.safeParse(hypothesis(['C2'])).success).toBe(true);
    expect(schema.safeParse(hypothesis()).success).toBe(true);
    // C1 is on the board but what it attacked has been replaced; H1 is not a critique.
    expect(schema.safeParse(hypothesis(['C1'])).success).toBe(false);
    expect(schema.safeParse(hypothesis(['H1'])).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(schema))).toContain('"resolves"');
  });

  it('are not in the schema at all when no critique is in view', () => {
    const schema = contributionSchemas({
      any: z.enum(['P1', 'S1']),
      liveOf: {},
      paragraphs: true,
    }).hypothesis;
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain('resolves');
    const parsed = schema.parse(hypothesis(['S1']));
    expect('resolves' in parsed.payload).toBe(false);
  });

  it('stay optional on a contribution, so a model that leaves the field out is valid', () => {
    const stored = ContributionSchema.parse({ ...hypothesis(), parents: [] });
    expect(stored.type === 'hypothesis' && stored.payload.resolves).toBeUndefined();
  });
});

describe('a hypothesis posted as an answer to a subproblem', () => {
  const refs = (answers: AnswerRefs[]): ModelReferenceSchemas => ({
    any: z.enum(['P1', 'S1', 'S2', 'H1', 'H2', 'E1', 'C1', 'C2']),
    liveOf: {},
    answers,
    paragraphs: true,
  });
  const answer = (extra: object = {}) => ({
    type: 'hypothesis',
    answers: 'S1',
    content: 'An answer.',
    parents: [],
    payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
    ...extra,
  });
  const schemaFor = (answers: AnswerRefs[]) => {
    const schema = answerSchemas(refs(answers));
    if (schema === undefined) throw new Error('no schema');
    return schema;
  };

  it('has no schema when the board has no subproblem to answer', () => {
    expect(answerSchemas(refs([]))).toBeUndefined();
    expect(answerSchemas({ any: z.enum(['P1']), liveOf: {}, paragraphs: true })).toBeUndefined();
  });

  it('is a first answer, with nothing to relate to, where nothing stands yet', () => {
    const schema = schemaFor([{ subproblem: 'S1', standing: [] }]);
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain('relation');
    // A relation sent anyway is not kept: there is nothing it could mean.
    const parsed = schema.parse(answer({ relation: 'rival' }));
    expect('relation' in parsed).toBe(false);
    expect(schema.safeParse(answer({ answers: 'S2' })).success).toBe(false);
    expect(schema.safeParse(answer({ answers: undefined })).success).toBe(false);
  });

  it('may leave the relation out where one hypothesis stands, and may only name that one or "rival"', () => {
    const schema = schemaFor([
      { subproblem: 'S1', standing: [{ hypothesis: 'H1', openCritiques: [] }] },
    ]);
    expect(schema.safeParse(answer()).success).toBe(true);
    expect(schema.safeParse(answer({ relation: newVersionOf('H1') })).success).toBe(true);
    expect(schema.safeParse(answer({ relation: RELATION_RIVAL })).success).toBe(true);
    expect(schema.safeParse(answer({ relation: newVersionOf('H2') })).success).toBe(false);
    expect(schema.safeParse(answer({ relation: 'H1' })).success).toBe(false);
  });

  it('must say which where two stand', () => {
    const schema = schemaFor([
      {
        subproblem: 'S1',
        standing: [
          { hypothesis: 'H1', openCritiques: [] },
          { hypothesis: 'H2', openCritiques: [] },
        ],
      },
    ]);
    expect(schema.safeParse(answer()).success).toBe(false);
    expect(schema.safeParse(answer({ relation: newVersionOf('H2') })).success).toBe(true);
    expect(schema.safeParse(answer({ relation: RELATION_RIVAL })).success).toBe(true);
  });

  it('is told apart by the subproblem it answers: each has its own standing hypotheses and critiques', () => {
    const schema = schemaFor([
      { subproblem: 'S1', standing: [{ hypothesis: 'H1', openCritiques: ['C1'] }] },
      { subproblem: 'S2', standing: [{ hypothesis: 'H2', openCritiques: [] }] },
    ]);
    const resolving = (answers: string, resolves: string[]) =>
      answer({
        answers,
        payload: { confidence: 0.5, supportedBy: [], contradictedBy: [], resolves },
      });
    expect(schema.safeParse(answer({ relation: newVersionOf('H1') })).success).toBe(true);
    expect(schema.safeParse(answer({ answers: 'S2', relation: newVersionOf('H1') })).success).toBe(
      false,
    );
    expect(schema.safeParse(resolving('S1', ['C1'])).success).toBe(true);
    expect(schema.safeParse(resolving('S1', ['C2'])).success).toBe(false);
    // No open critique against S2's answer: the field is not in that variant at all.
    const parsed = schema.parse(resolving('S2', ['C1']));
    expect('resolves' in parsed.payload).toBe(false);
    // Said before the content is written: which subproblem, then what it replaces.
    const properties = Object.keys(
      (z.toJSONSchema(schema) as { oneOf: { properties: object }[] }).oneOf[0]?.properties ?? {},
    );
    expect(properties.slice(0, 4)).toEqual(['type', 'answers', 'relation', 'content']);
  });

  it('reads a relation back', () => {
    expect(parseRelation(newVersionOf('H12'))).toEqual({ rival: false, of: 'H12' });
    expect(parseRelation(RELATION_RIVAL)).toEqual({ rival: true });
  });

  it('keeps rivalOf out of what a model can send, and on what the controller commits', () => {
    const modelFacing = contributionSchemas({
      any: z.enum(['P1', 'H1']),
      liveOf: {},
      paragraphs: true,
    }).hypothesis;
    expect(JSON.stringify(z.toJSONSchema(modelFacing))).not.toContain('rivalOf');
    const stored = ContributionSchema.parse({
      type: 'hypothesis',
      content: 'A rival.',
      parents: [],
      payload: { confidence: 0.5, supportedBy: [], contradictedBy: [], rivalOf: [id(2)] },
    });
    expect(stored.type === 'hypothesis' && stored.payload.rivalOf).toEqual([id(2)]);
  });
});
