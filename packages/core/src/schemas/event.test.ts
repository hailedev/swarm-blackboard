import { describe, expect, it } from 'vitest';

import { sequentialId } from '../testing/sequential-id-generator';
import { BoardEventSchema } from './event';

const id = sequentialId;
const at = '2026-01-01T00:00:00.000Z';
const base = { id: id(100), runId: id(1), seq: 0, at };
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
const totals = { rounds: 5, entries: 9, usage, elapsedMs: 1200 };

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

const local = { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false };
const profile = {
  name: 'dev',
  roles: { planner: local, researcher: local, solver: local, critic: local, synthesizer: local },
  bidder: null,
  fallback: null,
  paid: false,
};

describe('BoardEventSchema', () => {
  it.each([
    ['run_started', { problemEntry, config: {}, profile: null }],
    ['run_started', { problemEntry, config: {}, profile }],
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
    ['agent_failed', { round: 1, agentId: 'solver', reason: 'budget_exhausted', detail: '' }],
    ['round_completed', { round: 1, newEntries: 2, usage }],
    ['budget_warning', { round: 2, spentUsd: 4.1, limitUsd: 5 }],
    ['run_paused', { round: 2, reason: 'monthly_budget', totals }],
    ['run_paused', { round: 2, reason: 'rate_limit', totals }],
    ['run_paused', { round: 2, reason: 'interrupted', totals }],
    ['run_resumed', { round: 2, from: 'user_paused' }],
    ['run_terminated', { round: 5, status: 'completed', reason: 'completed', totals }],
    ['run_terminated', { round: 5, status: 'completed', reason: 'budget_cost', totals }],
    ['run_terminated', { round: 1, status: 'failed', reason: 'billing', totals }],
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
      profile: null,
    });
    if (parsed.type === 'run_started') expect(parsed.config.maxRounds).toBe(12);
    else expect.unreachable('expected run_started');
  });

  it.each([
    ['an unknown event type', { type: 'run_exploded' }],
    [
      'an unknown end reason',
      { type: 'run_terminated', round: 1, status: 'completed', reason: 'bored', totals },
    ],
    [
      'a pause reason on run_terminated',
      { type: 'run_terminated', round: 1, status: 'paused', reason: 'rate_limit', totals },
    ],
    [
      'a terminal reason on run_paused',
      { type: 'run_paused', round: 1, reason: 'completed', totals },
    ],
    ['a negative seq', { seq: -1, type: 'round_started', round: 1 }],
    [
      'usage without cache counts',
      {
        type: 'round_completed',
        round: 1,
        newEntries: 0,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      },
    ],
  ])('rejects %s', (_label, fields) => {
    expect(BoardEventSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });
});
