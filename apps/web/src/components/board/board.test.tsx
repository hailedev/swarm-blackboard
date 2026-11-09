import { buildBoardView, HANDLE_PREFIX, type BoardView } from '@team/core';
import { describe, expect, it } from 'vitest';

import { LANES } from '../../lib/entry-types';
import { elements, render, slices, text } from '../../testing/markup';
import { recordedEvents, recordedRunId } from '../../testing/recorded-run';
import { scriptedRun } from '../../testing/scripted-run';
import { boardAt } from '../../state/selectors';
import { Board } from './board';
import { EntryDetail } from './entry-detail';

const board = (view: BoardView, selectedId: string | null = null): string =>
  render(
    <Board view={view} selectedId={selectedId} showAllLinks={false} onSelect={() => undefined} />,
  );

const recorded = buildBoardView(recordedRunId(), recordedEvents());

describe('Board', () => {
  const html = board(recorded);
  const cards = elements(html, 'entry-card');

  it('lays the recorded run out in one lane per entry type, in order', () => {
    expect(elements(html, 'lane').map((lane) => lane['data-lane'])).toEqual([...LANES]);
    const laneText = slices(html, 'lane').map(text);
    expect(laneText[0]).toMatch(/^Problem 1 /);
    expect(laneText[1]).toBe('Your notes Nothing yet');
    expect(laneText[2]).toMatch(/^Subproblems 11 live of 15 /);
    expect(laneText[3]).toMatch(/^Hypotheses 12 live of 15 /);
    expect(laneText[7]).toBe('Decisions Nothing yet');
    expect(laneText[8]).toMatch(/^Synthesis 1 live of 4 /);
  });

  it('shows every entry once, under the handle the agents and the trace use', () => {
    expect(cards.length).toBe(96);
    expect(cards.map((card) => card['data-handle'])).toEqual(
      LANES.flatMap((type) =>
        recorded.entries.filter((e) => e.type === type).map((e) => recorded.handleOf(e.id)),
      ),
    );
    // Each lane counts from 1 with its own letter: P1, S1…S15, H1…H15, E1…E30, C1…C31, A1…A4.
    const count = (letter: string): number =>
      cards.filter((card) => card['data-handle']?.startsWith(letter) === true).length;
    expect(
      [
        HANDLE_PREFIX.problem,
        HANDLE_PREFIX.subproblem,
        HANDLE_PREFIX.hypothesis,
        HANDLE_PREFIX.evidence,
        HANDLE_PREFIX.critique,
        HANDLE_PREFIX.synthesis,
      ].map(count),
    ).toEqual([1, 15, 15, 30, 31, 4]);
    const h3 = slices(html, 'entry-card').find((card) => card.includes('data-handle="H3"'));
    expect(text(h3 ?? '')).toMatch(/^H3 solver · round 2 Hypothesis: /);
    expect(elements(h3 ?? '', 'entry-card')[0]?.['aria-label']).toBe(
      'H3, hypothesis by solver, round 2',
    );
  });

  it('dims what was superseded and says by what', () => {
    expect(cards.filter((card) => card['data-live'] === 'false').length).toBe(10);
    const dimmed = slices(html, 'entry-card').filter((card) => card.includes('data-live="false"'));
    expect(dimmed.every((card) => card.includes('opacity-55'))).toBe(true);
    expect(dimmed.every((card) => /superseded by [A-Z]\d+/.test(text(card)))).toBe(true);
    const live = slices(html, 'entry-card').filter((card) => card.includes('data-live="true"'));
    expect(live.some((card) => card.includes('opacity-55'))).toBe(false);
    // The earlier syntheses point at the latest one's chain.
    const a1 = slices(html, 'entry-card').find((card) => card.includes('data-handle="A1"'));
    expect(text(a1 ?? '')).toContain('superseded by A2');
  });

  it('badges each entry with what matters for its type', () => {
    const card = (handle: string): string =>
      text(slices(html, 'entry-card').find((c) => c.includes(`data-handle="${handle}"`)) ?? '');
    // A hypothesis: confidence, then what supports, contradicts and critiques it, by handle.
    expect(card('H3')).toMatch(/0\.60 contradicted by E7 E11 critiqued by C3 C21$/);
    // A critique: severity and target.
    expect(card('C1')).toMatch(/(blocking|major|minor) of H1/);
    // Evidence: its source and what it bears on.
    expect(card('E1')).toContain('source: ');
    // The latest synthesis: version, confidence and what it cites.
    expect(card('A4')).toMatch(/v4 .*0\.60 cites /);
    expect(card('S15')).toMatch(/(open|claimed|done)$/);
    // Status is a word and an icon, never colour alone: every severity badge has both.
    const severities = [
      ...html.matchAll(
        /aria-hidden="true" class="text-(critical|serious|muted)">(.)<\/span>(blocking|major|minor)/g,
      ),
    ];
    expect(severities.length).toBe(31);
  });

  it('marks the selected entry and outlines what it is linked to', () => {
    const h3 = recorded.byHandle('H3');
    if (h3 === undefined) throw new Error('no H3');
    const selected = board(recorded, h3.id);
    const pressed = elements(selected, 'entry-card').filter((c) => c['aria-pressed'] === 'true');
    expect(pressed.map((c) => c['data-handle'])).toEqual(['H3']);
    const outlined = slices(selected, 'entry-card')
      .filter((card) => /class="[^"]*border-accent(?! ring)/.test(card) && !card.includes('ring-2'))
      .map((card) => elements(card, 'entry-card')[0]?.['data-handle']);
    for (const handle of ['S3', 'E7', 'E11', 'C3', 'C21']) expect(outlined).toContain(handle);
    expect(outlined).not.toContain('H1');
    // Links are measured in the browser; static markup draws none.
    expect(elements(selected, 'entry-links')).toEqual([]);
  });

  it('shows the board as it stood at an earlier round', () => {
    const early = board(boardAt(recordedRunId(), recordedEvents(), 1));
    const handles = elements(early, 'entry-card').map((card) => card['data-handle']);
    expect(handles[0]).toBe('P1');
    expect(handles.every((handle) => handle === 'P1' || handle?.startsWith('S') === true)).toBe(
      true,
    );
    expect(elements(early, 'entry-card').every((card) => card['data-live'] === 'true')).toBe(true);
  });

  it('shows a note the user added in its own lane', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.injectNote({ content: 'Prefer SQLite', priority: 'high' });
    const html2 = board(run.controller.currentView());
    const note = slices(html2, 'entry-card').find((card) => card.includes('data-handle="N1"'));
    expect(text(note ?? '')).toBe('N1 you · round 1 Prefer SQLite high priority');
    expect(text(slices(html2, 'lane')[1] ?? '')).toMatch(/^Your notes 1 N1 /);
  });
});

describe('EntryDetail', () => {
  const detail = (handle: string): string => {
    const entry = recorded.byHandle(handle);
    if (entry === undefined) throw new Error(`no ${handle}`);
    return render(
      <EntryDetail
        view={recorded}
        entryId={entry.id}
        calls={[]}
        onSelect={() => undefined}
        onOpenCall={() => undefined}
      />,
    );
  };

  it('shows an entry in full with its provenance back to the problem', () => {
    const html = detail('H3');
    expect(elements(html, 'entry-detail')[0]?.['data-handle']).toBe('H3');
    const seen = text(html);
    expect(seen).toMatch(/^H3 hypothesis ✕ by solver · round 2 · /);
    expect(seen).toContain('Rests on S3 subproblem · ');
    expect(seen).toContain('P1 problem · A four-person team ships a Node service');
    expect(seen).toContain('Built on by');
    expect(seen).toContain('C3 critique · ');
    const provenance = slices(html, 'provenance')[0] ?? '';
    // Nearest first: the subproblem it answers, then the problem behind that.
    expect(provenance.indexOf('>S3<')).toBeLessThan(provenance.indexOf('>P1<'));
  });

  it('lists the versions an entry went through and where the board starts', () => {
    const a4 = text(detail('A4'));
    expect(a4).toMatch(
      /Versions A1 synthesis · .* A2 synthesis · .* A3 synthesis · .* A4 synthesis · /,
    );
    const superseded = text(detail('A1'));
    expect(superseded).toContain('superseded by A2');
    expect(text(detail('P1'))).toContain('Rests on Nothing: this is where the board starts.');
  });

  it('lists the model calls behind an entry, and says when an entry is not on the board shown', () => {
    const h3 = recorded.byHandle('H3');
    if (h3 === undefined) throw new Error('no H3');
    const call = {
      id: 'call-1',
      runId: recordedRunId(),
      round: 2,
      role: 'solver',
      modelId: 'qwen3.6:35b-a3b-q8_0',
      billing: 'local',
      at: '2026-11-09T06:50:00.000Z',
      outcome: 'ok',
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      estimateChars: 9_000,
      estimateCharsPerToken: 3,
      estimateTokens: 3_000,
      actualInputTokens: 2_000,
      latencyMs: 13_100,
      maxOutputTokens: 4_096,
      error: null,
      warningsJson: '[]',
      source: 'trace',
    };
    const html = render(
      <EntryDetail
        view={recorded}
        entryId={h3.id}
        calls={[
          call,
          { ...call, id: 'call-2', role: 'critic' },
          { ...call, id: 'call-3', round: 3 },
        ]}
        onSelect={() => undefined}
        onOpenCall={() => undefined}
      />,
    );
    expect(text(html)).toContain('Model calls qwen3.6:35b-a3b-q8_0 · ok · 13.1s · $0.0000');
    expect(html.split('qwen3.6:35b-a3b-q8_0 · ok').length - 1).toBe(1);

    const early = render(
      <EntryDetail
        view={boardAt(recordedRunId(), recordedEvents(), 1)}
        entryId={h3.id}
        calls={[]}
        onSelect={() => undefined}
        onOpenCall={() => undefined}
      />,
    );
    expect(text(early)).toBe('This entry is not on the board at the round being shown.');
  });
});
