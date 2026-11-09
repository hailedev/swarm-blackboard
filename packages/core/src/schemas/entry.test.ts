import { describe, expect, it } from 'vitest';

import { sequentialId } from '../testing/sequential-id-generator';
import { EntrySchema, type Entry } from './entry';
import { ENTRY_TYPES, type EntryType } from './payloads';

const id = sequentialId;

const base = {
  id: id(10),
  runId: id(1),
  round: 1,
  author: 'planner',
  createdAt: '2026-01-01T00:00:00.000Z',
  parents: [id(2)],
  status: 'active',
  content: 'Some markdown',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
  },
};

const payloads: Record<EntryType, unknown> = {
  problem: { constraints: ['c1'], successCriteria: ['s1'] },
  subproblem: { status: 'open' },
  hypothesis: { confidence: 0.6, supportedBy: [id(3)], contradictedBy: [] },
  evidence: { source: 'https://example.org', supports: [id(4)], contradicts: [] },
  critique: { target: id(4), severity: 'blocking' },
  question: {},
  decision: { chosen: id(4), rejected: [id(5)], rationale: 'Because.' },
  synthesis: { version: 1, confidence: 0.9, cites: [id(4)] },
  human_note: { priority: 'high' },
};

describe('EntrySchema', () => {
  it.each(ENTRY_TYPES)('accepts a well-formed %s entry', (type) => {
    const result = EntrySchema.safeParse({ ...base, type, payload: payloads[type] });
    expect(result.success).toBe(true);
  });

  it('narrows payload by type', () => {
    const parsed: Entry = EntrySchema.parse({
      ...base,
      type: 'hypothesis',
      payload: payloads.hypothesis,
    });
    if (parsed.type === 'hypothesis') expect(parsed.payload.confidence).toBe(0.6);
    else expect.unreachable('expected a hypothesis');
  });

  it('accepts an optional supersedes link and resolved critiques', () => {
    const superseding = EntrySchema.safeParse({
      ...base,
      type: 'critique',
      supersedes: id(9),
      payload: { target: id(4), severity: 'major', resolvedBy: id(11) },
    });
    expect(superseding.success).toBe(true);
  });

  it.each([
    [
      'hypothesis confidence above 1',
      'hypothesis',
      { confidence: 1.5, supportedBy: [], contradictedBy: [] },
    ],
    ['unknown critique severity', 'critique', { target: id(4), severity: 'huge' }],
    ['synthesis version 0', 'synthesis', { version: 0, confidence: 0.5, cites: [] }],
    ['unknown subproblem status', 'subproblem', { status: 'blocked' }],
    ['evidence without source', 'evidence', { source: '', supports: [], contradicts: [] }],
    ['decision without rationale', 'decision', { chosen: id(4), rejected: [], rationale: '' }],
    ['mismatched payload for problem', 'problem', { status: 'open' }],
  ])('rejects %s', (_label, type, payload) => {
    expect(EntrySchema.safeParse({ ...base, type, payload }).success).toBe(false);
  });

  it('rejects unknown types, non-v7 ids, bad dates, empty content and negative usage', () => {
    const problem = { ...base, type: 'problem', payload: payloads.problem };
    expect(EntrySchema.safeParse({ ...problem, type: 'rumour' }).success).toBe(false);
    expect(
      EntrySchema.safeParse({ ...problem, id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }).success,
    ).toBe(false);
    expect(EntrySchema.safeParse({ ...problem, createdAt: 'yesterday' }).success).toBe(false);
    expect(EntrySchema.safeParse({ ...problem, content: '' }).success).toBe(false);
    expect(
      EntrySchema.safeParse({ ...problem, usage: { ...base.usage, costUsd: -1 } }).success,
    ).toBe(false);
  });
});
