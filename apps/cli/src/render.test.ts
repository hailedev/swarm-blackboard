import { BoardFixture } from '@team/core/testing';
import type { RunProfile, RunSummary } from '@team/core';
import { describe, expect, it } from 'vitest';

import {
  renderBoard,
  renderBudgetBanner,
  renderFailure,
  renderRoundHeader,
  renderSummary,
  shortId,
} from './render';

describe('renderBoard', () => {
  it('prints one lane per entry type with live entries and supersede counts', () => {
    const fx = new BoardFixture();
    fx.problem('Pick a database');
    fx.startRound(1);
    const old = fx.entry('hypothesis', { confidence: 0.4, supportedBy: [], contradictedBy: [] });
    const fresh = fx.entry(
      'hypothesis',
      { confidence: 0.85, supportedBy: [], contradictedBy: [] },
      { supersedes: old.id, content: 'Use SQLite\nfor now', author: 'solver' },
    );
    const evidence = fx.entry('evidence', {
      source: 'docs',
      supports: [fresh.id],
      contradicts: [],
    });
    fx.entry('critique', { target: fresh.id, severity: 'major', resolvedBy: evidence.id });
    fx.entry('question', { answeredBy: evidence.id });
    fx.entry('subproblem', { status: 'done' }, { status: 'pinned' });
    fx.entry('decision', { chosen: fresh.id, rejected: [old.id], rationale: 'r' });
    fx.entry('synthesis', { version: 2, confidence: 0.9, cites: [fresh.id] });
    fx.entry('human_note', { priority: 'high' }, { author: 'human' });

    const text = renderBoard(fx.view()).join('\n');
    expect(text).toContain('-- problem (1 live) --');
    expect(text).toContain('-- hypothesis (1 live, 1 superseded or dismissed) --');
    expect(text).toContain(
      `${shortId(fresh.id)} solver      r1  conf 0.85, 0 for / 0 against (supersedes ${shortId(old.id)})`,
    );
    expect(text).toContain('Use SQLite for now');
    expect(text).toContain(`major -> ${shortId(fresh.id)} (resolved)`);
    expect(text).toContain(`answered by ${shortId(evidence.id)}`);
    expect(text).toContain('done [pinned]');
    expect(text).toContain(`chose ${shortId(fresh.id)}, rejected ${shortId(old.id)}`);
    expect(text).toContain('v2, conf 0.90, cites 1');
    expect(text).toContain('priority high');
    expect(text).toContain('source: docs; supports');
    expect(text).not.toContain(`${shortId(old.id)} hypothesis-author`);
  });

  it('skips lanes with no entries and truncates long content', () => {
    const fx = new BoardFixture();
    fx.problem('x'.repeat(200));
    const lines = renderBoard(fx.view());
    expect(lines.length).toBe(3);
    expect(lines[2]?.length).toBeLessThan(120);
    expect(lines[2]?.endsWith('…')).toBe(true);
  });
});

describe('headers and summary', () => {
  it('formats round headers and failures', () => {
    expect(renderRoundHeader(3, ['critic', 'solver'])).toBe('== Round 3: critic + solver ==');
    expect(renderRoundHeader(1, [])).toBe('== Round 1: nobody eligible ==');
    expect(renderFailure('solver', 'invalid_output', 'confidence:\n too big')).toBe(
      '  ! solver invalid_output: confidence: too big',
    );
  });

  const summary = (overrides: Partial<RunSummary>): RunSummary => {
    const fx = new BoardFixture();
    fx.problem();
    return {
      runId: fx.runId,
      rounds: 4,
      status: 'completed',
      reason: 'completed',
      totals: {
        rounds: 4,
        entries: 12,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0315,
        },
        elapsedMs: 42,
      },
      view: fx.view(),
      ...overrides,
    };
  };

  it('summarises totals and the final answer', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.9, cites: [] }, { content: 'The answer.' });
    expect(renderSummary(summary({ view: fx.view() }))).toEqual([
      '== Done: completed after 4 rounds ==',
      'entries 12 | tokens 150 | cost $0.0315 | elapsed 42 ms',
      '',
      'Answer:',
      'The answer.',
    ]);
  });

  it('names paused and failed runs for what they are', () => {
    expect(
      renderSummary(summary({ status: 'paused', reason: 'monthly_budget', rounds: 1 }))[0],
    ).toBe('== Paused: monthly_budget after 1 rounds ==');
    expect(renderSummary(summary({ status: 'failed', reason: 'billing', rounds: 2 }))[0]).toBe(
      '== Failed: billing after 2 rounds ==',
    );
  });
});

describe('renderBudgetBanner', () => {
  const haiku = { alias: 'haiku', provider: 'anthropic' as const, model: 'claude-haiku-5-5' };
  const sonnet = { alias: 'sonnet', provider: 'anthropic' as const, model: 'claude-sonnet-5-5' };
  const local = {
    alias: 'local',
    provider: 'ollama' as const,
    model: 'qwen3.6:35b-mlx',
    think: false,
  };
  const quality: RunProfile = {
    name: 'quality',
    roles: {
      planner: haiku,
      researcher: local,
      solver: { ...local, alias: 'local-think', think: true },
      critic: sonnet,
      synthesizer: sonnet,
    },
    bidder: haiku,
    fallback: haiku,
    paid: true,
  };

  it('matches the confirmation banner snapshot', () => {
    expect(
      renderBudgetBanner({
        profile: quality,
        maxCostUsd: 0.25,
        month: { spentUsd: 1.2345, limitUsd: 5, warnAtFraction: 0.8 },
        fake: false,
      }).join('\n'),
    ).toMatchSnapshot();
  });

  it('flags the warning fraction, a missing fallback and scripted stand-ins', () => {
    const lines = renderBudgetBanner({
      profile: { ...quality, bidder: null, fallback: null },
      maxCostUsd: 0.1,
      month: { spentUsd: 4, limitUsd: 5, warnAtFraction: 0.8 },
      fake: true,
    });
    expect(lines).toContain('  fallback      none');
    expect(lines).toContain(
      '  this month    $4.0000 of $5.00 (80%)  ! past 80% of the monthly limit',
    );
    expect(lines.at(-1)).toBe('  --fake: scripted models stand in for these; nothing is billed.');
    expect(lines.some((line) => line.startsWith('  bidder'))).toBe(false);
  });
});
