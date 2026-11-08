import { describe, expect, it } from 'vitest';

import { sequentialId } from '../testing/sequential-id-generator';
import { BoardEventSchema } from './event';

const id = sequentialId;
const at = '2026-01-01T00:00:00.000Z';
const base = { id: id(100), runId: id(1), seq: 0, at };
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

const problemEntry = {
  id: id(2),
  runId: id(1),
  type: 'problem',
  round: 0,
  author: 'human',
  createdAt: at,
  parents: [],
  status: 'active',
  content: 'Should we adopt a monorepo?',
  payload: { constraints: [], successCriteria: [] },
  usage,
};

describe('BoardEventSchema', () => {
  it.each([
    ['run_started', { problemEntry, config: {} }],
    ['round_started', { round: 1 }],
    [
      'agents_selected',
      {
        round: 1,
        selected: ['planner'],
        eligible: [{ agentId: 'planner', priority: 100, reason: 'board is new' }],
      },
    ],
    ['entry_committed', { round: 1, entry: problemEntry }],
    [
      'agent_failed',
      { round: 1, agentId: 'solver', reason: 'invalid_output', detail: 'confidence > 1' },
    ],
    ['round_completed', { round: 1, newEntries: 2, usage }],
    [
      'run_terminated',
      {
        round: 5,
        reason: 'synthesis_confident',
        totals: { rounds: 5, entries: 9, usage, elapsedMs: 1200 },
      },
    ],
  ])('accepts a %s event', (type, fields) => {
    const result = BoardEventSchema.safeParse({ ...base, type, ...fields });
    expect(result.success).toBe(true);
  });

  it('applies run-config defaults inside run_started', () => {
    const parsed = BoardEventSchema.parse({
      ...base,
      type: 'run_started',
      problemEntry,
      config: {},
    });
    if (parsed.type === 'run_started') expect(parsed.config.maxRounds).toBe(12);
    else expect.unreachable('expected run_started');
  });

  it('rejects unknown event types, unknown termination reasons and negative seq', () => {
    expect(BoardEventSchema.safeParse({ ...base, type: 'run_exploded' }).success).toBe(false);
    expect(
      BoardEventSchema.safeParse({
        ...base,
        type: 'run_terminated',
        round: 1,
        reason: 'bored',
        totals: { rounds: 1, entries: 0, usage, elapsedMs: 0 },
      }).success,
    ).toBe(false);
    expect(
      BoardEventSchema.safeParse({ ...base, seq: -1, type: 'round_started', round: 1 }).success,
    ).toBe(false);
  });
});
