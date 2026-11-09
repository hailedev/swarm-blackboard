import { defaultRunConfig, RunEndReasonSchema, runStatusFor, zeroUsage } from '@team/core';
import type { RunRecord } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { REASON_TEXT } from '../lib/reasons';
import { elements, render, slices, text } from '../testing/markup';
import { RunList } from './run-list';
import { RunStatus } from './run-status';

const record = (overrides: Partial<RunRecord>): RunRecord => ({
  id: 'run',
  problem: 'Should we adopt a monorepo?',
  status: 'running',
  reason: null,
  profileName: 'dev',
  config: defaultRunConfig(),
  startedAt: '2026-11-09T06:49:40.000Z',
  endedAt: null,
  totals: { rounds: 3, entries: 19, usage: { ...zeroUsage(), costUsd: 0.0238 }, elapsedMs: 1 },
  ...overrides,
});

describe('RunList', () => {
  const runs = [
    record({ id: 'r1' }),
    record({ id: 'r2', status: 'paused', reason: 'interrupted' }),
    record({ id: 'r3', status: 'paused', reason: 'user_paused' }),
    record({ id: 'r4', status: 'stopped', reason: 'user_stopped' }),
    record({ id: 'r5', status: 'completed', reason: 'budget_rounds', profileName: 'cheap' }),
    record({ id: 'r6', status: 'completed', reason: 'completed' }),
    record({ id: 'r7', status: 'failed', reason: 'billing', profileName: null }),
  ];
  const html = render(<RunList runs={runs} selectedId="r5" onSelect={() => undefined} />);

  it('lists every run with its status, and a reason on every one that is not running', () => {
    expect(elements(html, 'run-row').map((row) => row['data-run-id'])).toEqual(
      runs.map((run) => run.id),
    );
    expect(
      elements(html, 'run-status').map((s) => [s['data-status'], s['data-reason'] ?? null]),
    ).toEqual(runs.map((run) => [run.status, run.reason]));
    const rows = slices(html, 'run-row').map(text);
    expect(rows[0]).toContain('Running');
    expect(rows[0]).not.toContain('—');
    expect(rows[1]).toContain('Paused — interrupted by a server restart');
    expect(rows[2]).toContain('Paused — at your request');
    expect(rows[3]).toContain('Stopped — at your request');
    expect(rows[4]).toContain('Completed — round limit reached');
    expect(rows[5]).toContain('Completed — answer reached');
    expect(rows[6]).toContain('Failed — billing error');
    // No row that is not running is without its reason.
    for (const [index, run] of runs.entries()) {
      if (run.reason !== null) expect(rows[index]).toContain(REASON_TEXT[run.reason].label);
    }
  });

  it('shows what each run was and what it used, and marks the open one', () => {
    const rows = slices(html, 'run-row').map(text);
    expect(rows[4]).toContain('cheap · 3 rounds · 19 entries · $0.0238');
    expect(rows[6]).toContain('no profile');
    expect(elements(html, 'run-row').map((row) => row['aria-current'] ?? null)).toEqual([
      null,
      null,
      null,
      null,
      'true',
      null,
      null,
    ]);
    expect(text(render(<RunList runs={[]} selectedId={null} onSelect={() => undefined} />))).toBe(
      'No runs yet. Start one to see it here.',
    );
  });
});

describe('RunStatus', () => {
  it('names the reason for every way a run can pause or end, and explains it on request', () => {
    for (const reason of RunEndReasonSchema.options) {
      const status = runStatusFor(reason);
      const html = render(<RunStatus status={status} reason={reason} withDetail />);
      expect(elements(html, 'run-status')[0]).toMatchObject({
        'data-status': status,
        'data-reason': reason,
        title: REASON_TEXT[reason].detail,
      });
      expect(text(html)).toContain(`— ${REASON_TEXT[reason].label}`);
      expect(text(html)).toContain(REASON_TEXT[reason].detail);
    }
  });

  it('says only "Running" for a running run', () => {
    const html = render(<RunStatus status="running" reason={null} withDetail />);
    expect(text(html)).toBe('● Running');
    expect(elements(html, 'run-reason')).toEqual([]);
  });
});
