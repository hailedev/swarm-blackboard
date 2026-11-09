import { buildBoardView, latestSynthesis } from '@team/core';
import { describe, expect, it } from 'vitest';

import { recordedEvents, recordedRunId } from '../testing/recorded-run';
import {
  ancestorsOf,
  boardLinks,
  LINK_STYLE,
  linksOf,
  linksTouching,
  neighbourIds,
  referrersOf,
} from './provenance';

const view = buildBoardView(recordedRunId(), recordedEvents());
const handle = (id: string): string => view.handleOf(id) ?? '?';
const entry = (h: string) => {
  const found = view.byHandle(h);
  if (found === undefined) throw new Error(`no entry ${h}`);
  return found;
};

describe('links', () => {
  it('reads an entry’s links from its payload, keeping the more specific kind', () => {
    // A critique names its target in `parents` too: one link, and it says "critiques".
    const critique = entry('C1');
    expect(critique.type === 'critique' && critique.parents).toContain(
      critique.type === 'critique' ? critique.payload.target : '',
    );
    const links = linksOf(critique);
    expect(links.filter((l) => l.kind === 'critiques').map((l) => handle(l.to))).toEqual(['H1']);
    expect(links.filter((l) => l.to === view.byHandle('H1')?.id).length).toBe(1);
    expect(LINK_STYLE.critiques).toBe('dashed');

    // A superseding entry points back at what it replaced.
    const superseding = view.entries.find((e) => e.supersedes !== undefined);
    if (superseding === undefined) throw new Error('the recorded run has no superseding entry');
    expect(linksOf(superseding).filter((l) => l.kind === 'supersedes')).toEqual([
      { from: superseding.id, to: superseding.supersedes, kind: 'supersedes' },
    ]);
  });

  it('draws one link per pair of entries across the whole board, all between entries it has', () => {
    const links = boardLinks(view);
    const pairs = links.map((l) => [l.from, l.to].sort().join('|'));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(
      links.every((l) => view.byId(l.from) !== undefined && view.byId(l.to) !== undefined),
    ).toBe(true);
    // No entry floats free: each one is at one end of a link or the other.
    const linked = new Set(links.flatMap((l) => [l.from, l.to]));
    expect(view.entries.filter((e) => !linked.has(e.id)).map((e) => handle(e.id))).toEqual([]);
  });

  it('finds what touches an entry from either end', () => {
    const links = boardLinks(view);
    const h1 = entry('H1');
    const touching = linksTouching(links, h1.id);
    expect(touching.every((l) => l.from === h1.id || l.to === h1.id)).toBe(true);
    const neighbours = [...neighbourIds(links, h1.id)].map(handle);
    expect(neighbours).toContain('C1');
    expect(neighbours).not.toContain('H1');
    expect(neighbours.length).toBe(touching.length);
  });
});

describe('provenance', () => {
  it('walks from the answer back to the problem, nearest first, each entry once', () => {
    const answer = latestSynthesis(view);
    if (answer === undefined) throw new Error('the recorded run has no synthesis');
    const ancestors = ancestorsOf(view, answer.id);
    const handles = ancestors.map((a) => handle(a.entry.id));
    expect(new Set(handles).size).toBe(handles.length);
    expect(handles).toContain('P1');
    expect(handles).not.toContain(handle(answer.id));
    // Depths never decrease, and what the answer cites is at depth 1.
    expect(ancestors.map((a) => a.depth)).toEqual(
      ancestors.map((a) => a.depth).sort((a, b) => a - b),
    );
    const direct = ancestors.filter((a) => a.depth === 1).map((a) => a.entry.id);
    for (const cited of answer.payload.cites) expect(direct).toContain(cited);
    // The problem rests on nothing.
    expect(ancestorsOf(view, entry('P1').id)).toEqual([]);
    expect(ancestorsOf(view, 'no-such-entry')).toEqual([]);
  });

  it('lists what was built on an entry', () => {
    const referrers = referrersOf(view, entry('H1').id).map((e) => handle(e.id));
    expect(referrers).toContain('C1');
    expect(referrers).not.toContain('H1');
    // Everything on the board is built, directly or not, on the problem.
    expect(referrersOf(view, entry('P1').id).length).toBeGreaterThan(0);
  });
});
