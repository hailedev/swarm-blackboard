import { BoardFixture } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { renderBoard, renderFailure, renderRoundHeader, renderSummary, shortId } from './render';

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

  it('summarises totals and the final answer', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.9, cites: [] }, { content: 'The answer.' });
    const lines = renderSummary({
      runId: fx.runId,
      rounds: 4,
      reason: 'synthesis_confident',
      totals: {
        rounds: 4,
        entries: 12,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0315 },
        elapsedMs: 42,
      },
      view: fx.view(),
    });
    expect(lines).toEqual([
      '== Done: synthesis_confident after 4 rounds ==',
      'entries 12 | tokens 150 | cost $0.0315 | elapsed 42 ms',
      '',
      'Answer:',
      'The answer.',
    ]);
  });
});
