import { describe, expect, it } from 'vitest';

import type { Entry } from '../schemas/entry';
import { defaultRunConfig, type ViewBounds } from '../schemas/run-config';
import { BoardFixture } from '../testing/board-fixture';
import { lateBoard, midRunBoard } from '../testing/sample-boards';
import { buildAgentView, digestLine, type AgentView } from './agent-view';

const bounds = (overrides: Partial<ViewBounds> = {}): ViewBounds => ({
  ...defaultRunConfig().view,
  ...overrides,
});

const ids = (view: AgentView): string[] => view.focus.map((f) => f.entry.id);

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('fixture changed');
  return value;
};

describe('buildAgentView', () => {
  it('puts the targets first, then their neighbours, and digests the rest', () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const hyp1 = must(board.hypotheses[0]);
    const [ev1, ev2] = board.evidence;
    const crit1 = must(board.critiques[0]);
    const q1 = must(board.questions[0]);

    const agentView = buildAgentView(view, 'critic', [hyp1.id], bounds());
    expect(agentView.problem?.id).toBe(board.problem.id);
    expect(agentView.humanNotes.map((n) => n.content)).toEqual([
      'Prefer any option that keeps the three deploy pipelines independent.',
    ]);
    expect(agentView.focus[0]).toMatchObject({ entry: { id: hyp1.id }, isTarget: true });
    // Neighbours: the hypothesis's parents (subproblems), its evidence and its critique.
    expect(ids(agentView)).toEqual(expect.arrayContaining([must(ev1).id, must(ev2).id, crit1.id]));
    expect(ids(agentView)).toEqual(expect.arrayContaining(board.subproblems.map((s) => s.id)));
    // Everything else is one digest line; the open question is not linked to the target.
    expect(ids(agentView)).not.toContain(q1.id);
    expect(agentView.summary).toEqual([digestLine(q1)]);
    expect(agentView.omitted).toBe(0);
  });

  it('never shows superseded entries and ignores target ids that are not live', () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const claimed = must(board.subproblems[0]);
    const superseded = must(claimed.supersedes);
    const agentView = buildAgentView(view, 'solver', [superseded, 'not-an-id'], bounds());
    expect(ids(agentView)).not.toContain(superseded);
    expect(agentView.summary.join('\n')).not.toContain(superseded);
    expect(agentView.focus.every((f) => !f.isTarget)).toBe(true);
  });

  it('gives the planner every live subproblem and open question, and the synthesizer every hypothesis with its evidence and critiques', () => {
    const board = lateBoard();
    const view = board.fx.view();
    const planner = buildAgentView(view, 'planner', [board.problem.id], bounds());
    expect(ids(planner)).toEqual(
      expect.arrayContaining([
        ...board.subproblems.map((s) => s.id),
        ...board.questions.map((q) => q.id),
      ]),
    );
    expect(planner.focus.some((f) => f.isTarget)).toBe(false);

    const synthesizer = buildAgentView(view, 'synthesizer', [], bounds());
    const expected = [
      ...board.hypotheses.map((h) => h.id),
      ...board.evidence.map((e) => e.id),
      ...board.critiques.filter((c) => view.isLive(c.payload.target)).map((c) => c.id),
      must(board.synthesis).id,
    ];
    expect(ids(synthesizer)).toEqual(expect.arrayContaining(expected));
  });

  it('follows payload links for decisions, syntheses and answered questions, and digests every type', () => {
    const board = lateBoard();
    const { fx } = board;
    const hyp2 = must(board.hypotheses[0]);
    const synthesis = must(board.synthesis);
    const q1 = must(board.questions[0]);
    const loser = fx.entry(
      'hypothesis',
      { confidence: 0.2, supportedBy: [], contradictedBy: [] },
      { content: 'Keep the repositories separate.' },
    );
    const decision = fx.entry(
      'decision',
      { chosen: hyp2.id, rejected: [loser.id], rationale: 'the evidence favours it' },
      { parents: [hyp2.id, loser.id], content: 'The monorepo hypothesis stands.' },
    );
    const answer = fx.entry(
      'evidence',
      { source: 'release log', supports: [], contradicts: [] },
      { content: 'Service B ships weekly.' },
    );
    const answered = fx.entry(
      'question',
      { answeredBy: answer.id },
      { supersedes: q1.id, content: q1.content },
    );
    const view = fx.view();

    const fromDecision = buildAgentView(view, 'critic', [decision.id], bounds());
    expect(ids(fromDecision)).toEqual(expect.arrayContaining([decision.id, hyp2.id, loser.id]));
    const fromSynthesis = buildAgentView(view, 'critic', [synthesis.id], bounds());
    expect(ids(fromSynthesis)).toEqual(expect.arrayContaining(synthesis.payload.cites));
    const fromQuestion = buildAgentView(view, 'critic', [answered.id], bounds());
    expect(ids(fromQuestion)).toEqual(expect.arrayContaining([answered.id, answer.id]));
    // The planner no longer sees the question once it is answered.
    const planner = buildAgentView(view, 'planner', [], bounds());
    expect(ids(planner)).not.toContain(answered.id);

    for (const entry of view.live) expect(digestLine(entry)).toContain(entry.id);
    expect(digestLine(decision)).toContain(`chosen=${hyp2.id} rejected=${loser.id}`);
    expect(digestLine(answered)).toContain(`answeredBy=${answer.id}`);
    expect(digestLine(board.problem)).toContain('constraints=2 criteria=2');
    expect(digestLine(synthesis)).toContain('version=1 confidence=0.6 cites=');
  });

  it('clips long content and stops admitting entries at the focus bounds', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const long = fx.entry(
      'subproblem',
      { status: 'open' },
      { parents: [problem.id], content: 'L'.repeat(50) },
    );
    const others = Array.from({ length: 5 }, (_, i) =>
      fx.entry(
        'subproblem',
        { status: 'open' },
        { parents: [problem.id], content: `S${String(i)}` },
      ),
    );
    const view = fx.view();
    const targets = [long.id, ...others.map((o) => o.id)];

    const clipped = buildAgentView(view, 'solver', targets, bounds({ maxEntryChars: 10 }));
    expect(clipped.focus[0]).toMatchObject({ content: 'LLLLLLLLLL', clipped: true });

    const fewEntries = buildAgentView(view, 'solver', targets, bounds({ maxFocusEntries: 2 }));
    expect(fewEntries.focus.length).toBe(2);
    expect(fewEntries.summary.length).toBe(4);

    // 50 chars for the first, then only entries that still fit under 54 go in.
    const fewChars = buildAgentView(view, 'solver', targets, bounds({ maxFocusChars: 54 }));
    expect(ids(fewChars)).toEqual([long.id, ...others.slice(0, 2).map((o) => o.id)]);

    // The first entry is admitted even when it alone exceeds the budget.
    const tiny = buildAgentView(view, 'solver', targets, bounds({ maxFocusChars: 1 }));
    expect(ids(tiny)).toEqual([long.id]);
  });

  it('collapses the oldest digests into per-type tallies once the summary budget is spent', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const entries: Entry[] = Array.from({ length: 15 }, (_, i) =>
      i % 3 === 0
        ? fx.entry('question', {}, { parents: [problem.id], content: `entry ${String(i)}` })
        : fx.entry(
            'subproblem',
            { status: 'open' },
            { parents: [problem.id], content: `entry ${String(i)}` },
          ),
    );
    const newest = must(entries[14]);
    const secondNewest = must(entries[13]);
    const twoLines = 2 * digestLine(newest).length;
    const agentView = buildAgentView(
      fx.view(),
      'critic',
      [],
      bounds({ maxSummaryChars: twoLines }),
    );

    expect(agentView.focus).toEqual([]);
    expect(agentView.summary.slice(0, 2)).toEqual([digestLine(newest), digestLine(secondNewest)]);
    const tallies = agentView.summary.slice(2);
    expect(tallies.length).toBe(2);
    expect(tallies.join('\n')).toMatch(/… 8 older subproblem entries: /);
    expect(tallies.join('\n')).toMatch(/… 5 older question entries: /);
    expect(agentView.omitted).toBe(13);
    const subproblemTally = tallies.find((t) => t.includes('subproblem')) ?? '';
    expect(subproblemTally.match(/0000-7000-8000/g)?.length).toBe(8);

    // At most 12 ids per tally, then a count.
    const many = Array.from({ length: 14 }, (_, i) =>
      fx.entry(
        'evidence',
        { source: 's', supports: [], contradicts: [] },
        { content: `e${String(i)}` },
      ),
    );
    const crowded = buildAgentView(fx.view(), 'critic', [], bounds({ maxSummaryChars: 1 }));
    const evidenceTally = crowded.summary.find((t) => t.includes('older evidence')) ?? '';
    expect(evidenceTally).toContain(` and ${String(many.length - 12)} more`);
    expect(evidenceTally.match(/0000-7000-8000/g)?.length).toBe(12);
  });
});
