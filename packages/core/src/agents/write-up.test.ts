import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BoardFixture } from '../testing/board-fixture';
import { freshBoard, lateBoard } from '../testing/sample-boards';
import { latestSynthesis } from './eligibility';
import { lengthInstruction } from './word-budget';
import {
  renderWriteUpPrompt,
  resolveWriteUp,
  writeUpContribution,
  writeUpOutputSchema,
} from './write-up';

const WHOLE_BOARD = { maxBoardChars: 48_000 };

describe('renderWriteUpPrompt', () => {
  it('lays the whole live board out for the writer', () => {
    const board = lateBoard();
    const rendered = renderWriteUpPrompt(board.fx.view(), WHOLE_BOARD, 900);
    expect(rendered.prompt).toMatchSnapshot();
  });

  it('shows every live entry in full, names it by handle and never by id', () => {
    const board = lateBoard();
    const view = board.fx.view();
    const rendered = renderWriteUpPrompt(view, WHOLE_BOARD, 900);

    // The problem with its numbered criteria, the note, and the length sentence both arms read.
    expect(rendered.prompt).toContain(`# Problem (P1)\n${board.problem.content}`);
    expect(rendered.prompt).toContain('1. A recommendation that names the main risk');
    expect(rendered.prompt).toContain('2. Evidence cited for the effort estimate');
    expect(rendered.prompt).toContain('- N1 (priority high): Prefer any option');
    expect(rendered.prompt).toContain(lengthInstruction(900));

    // Unlike an agent's view, nothing is clipped and nothing is a digest: the live
    // hypothesis, its two pieces of evidence, the critique that stands, the question,
    // both subproblems and the draft.
    for (const entry of [
      ...board.hypotheses,
      ...board.evidence,
      ...board.questions,
      ...board.subproblems,
    ]) {
      expect(rendered.prompt).toContain(entry.content);
    }
    expect(rendered.prompt).toContain(board.synthesis?.content ?? 'no synthesis');
    expect(rendered.shown).toEqual({ full: 8, digested: 0, omitted: 0 });
    expect(rendered.handles).toEqual(['P1', 'S2', 'S4', 'H2', 'E1', 'E2', 'C2', 'Q1', 'A1', 'N1']);
    for (const entry of view.entries) expect(rendered.prompt).not.toContain(entry.id);

    // The evidence sits under the hypothesis it supports, the critique under what it attacks.
    const at = (text: string) => rendered.prompt.indexOf(text);
    expect(at('### H2 (hypothesis')).toBeGreaterThan(at('## Candidate answers'));
    expect(at('- E1 (evidence, round 2; supports it)')).toBeGreaterThan(at('### H2 (hypothesis'));
    expect(at('- C2 (critique, round 4; critique that stands)')).toBeGreaterThan(at('- E2 ('));
    expect(at('## Latest draft of the answer')).toBeGreaterThan(at('## Subproblems'));
  });

  it('leaves out a critique of an entry that has been replaced, and says how many', () => {
    const board = lateBoard();
    const [stale, standing] = board.critiques;
    const rendered = renderWriteUpPrompt(board.fx.view(), WHOLE_BOARD, 900);
    // C1 attacked H1, which H2 superseded: it is not the writer's problem any more.
    expect(rendered.prompt).not.toContain(stale?.content ?? 'missing');
    expect(rendered.prompt).toContain(standing?.content ?? 'missing');
    expect(rendered.staleCritiques).toBe(1);
    expect(rendered.prompt).toContain(
      'Not shown: 1 critique is left out because it was resolved or what it attacks has been replaced.',
    );
    expect(rendered.handles).not.toContain('C1');
  });

  it('lets the answer cite what is shown and what those entries link to, but not a draft', () => {
    const board = lateBoard();
    const rendered = renderWriteUpPrompt(board.fx.view(), WHOLE_BOARD, 900);
    // H1 is not shown (H2 replaced it) but E1 and E2 still name it as what they support.
    expect(rendered.citeable).toEqual(['P1', 'S2', 'S4', 'H1', 'H2', 'E1', 'E2', 'C2', 'Q1', 'N1']);
    expect(rendered.citeable).not.toContain('A1');
  });

  it('falls back to one line per entry, then to a count, when the board outgrows its bound', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const long = 'x'.repeat(400);
    const evidence = Array.from({ length: 12 }, (_, i) =>
      fx.entry(
        'evidence',
        { source: `source ${String(i)}`, supports: [], contradicts: [] },
        { parents: [problem.id], content: `finding ${String(i)} ${long}` },
      ),
    );
    const view = fx.view();
    const whole = renderWriteUpPrompt(view, WHOLE_BOARD, 900);
    expect(whole.shown).toEqual({ full: 12, digested: 0, omitted: 0 });

    // Room for about three entries in full, a few more as digests, and no more.
    const tight = renderWriteUpPrompt(view, { maxBoardChars: 2_200 }, 900);
    expect(tight.shown.full).toBe(4);
    expect(tight.shown.digested).toBeGreaterThan(0);
    expect(tight.shown.omitted).toBeGreaterThan(0);
    expect(tight.shown.full + tight.shown.digested + tight.shown.omitted).toBe(12);
    expect(tight.prompt).toContain(
      `Not shown: ${String(tight.shown.omitted)} more live entries are not shown for want of room.`,
    );
    // Only what the prompt shows can be cited; the first entries win the room.
    expect(tight.handles).toEqual([
      'P1',
      ...evidence
        .slice(0, tight.shown.full + tight.shown.digested)
        .map((_, i) => `E${String(i + 1)}`),
    ]);
    // The board section stays within the bound, whatever the board holds.
    const boardSection = tight.prompt.slice(
      tight.prompt.indexOf('## Other evidence'),
      tight.prompt.indexOf('\n\nNot shown:'),
    );
    expect(boardSection.length).toBeLessThanOrEqual(2_200 + '## Other evidence\n'.length);
    expect(tight.prompt.length).toBeLessThan(whole.prompt.length);
  });

  it('says so when the board holds nothing but the problem', () => {
    const rendered = renderWriteUpPrompt(freshBoard().fx.view(), WHOLE_BOARD, 900);
    expect(rendered.prompt).toContain('# The board\n(nothing but the problem)');
    expect(rendered.citeable).toEqual(['P1']);
    expect(rendered.shown).toEqual({ full: 0, digested: 0, omitted: 0 });
  });
});

describe('writeUpOutputSchema', () => {
  const schema = writeUpOutputSchema(['P1', 'H2', 'E1']);
  const answer = { paragraphs: ['The answer.'], confidence: 0.7, cites: ['H2', 'E1'] };

  it('takes paragraphs, a confidence and handles the prompt named', () => {
    expect(schema.safeParse(answer).success).toBe(true);
    // The handles are an enum in the schema the provider sees, as an agent's links are.
    const json = JSON.stringify(z.toJSONSchema(schema));
    expect(json).toContain('"enum":["P1","H2","E1"]');
    // Nothing in it lets the model state a version, a stage or what it supersedes.
    for (const field of ['version', 'stage', 'supersedes', 'parents']) {
      expect(json).not.toContain(field);
    }
  });

  it.each([
    ['no paragraph', { ...answer, paragraphs: [] }],
    ['an empty paragraph', { ...answer, paragraphs: [''] }],
    ['no citation', { ...answer, cites: [] }],
    ['a handle the prompt did not name', { ...answer, cites: ['H9'] }],
    ['a confidence above 1', { ...answer, confidence: 1.2 }],
  ])('rejects %s', (_label, output) => {
    expect(schema.safeParse(output).success).toBe(false);
  });
});

describe('resolveWriteUp and writeUpContribution', () => {
  it('maps cited handles to entry ids, each once, and reports one it does not know', () => {
    const board = lateBoard();
    const view = board.fx.view();
    const [hypothesis] = board.hypotheses;
    const [evidence] = board.evidence;
    const resolved = resolveWriteUp(
      { paragraphs: ['One.', 'Two.'], confidence: 0.8, cites: ['H2', 'E1', 'H2'] },
      view,
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        paragraphs: ['One.', 'Two.'],
        confidence: 0.8,
        citeIds: [hypothesis?.id, evidence?.id],
      },
    });
    expect(
      resolveWriteUp({ paragraphs: ['One.'], confidence: 0.8, cites: ['H2', 'Z9'] }, view),
    ).toEqual({ ok: false, error: ['cites.1: unknown handle "Z9"'] });
  });

  it('writes the synthesis that supersedes the latest draft, one version on', () => {
    const board = lateBoard();
    const view = board.fx.view();
    const [hypothesis] = board.hypotheses;
    const draft = latestSynthesis(view);
    const contribution = writeUpContribution(view, {
      paragraphs: ['Recommendation.', 'Assumption: the estimate holds.'],
      confidence: 0.8,
      citeIds: [hypothesis?.id ?? ''],
    });
    expect(contribution).toEqual({
      type: 'synthesis',
      content: 'Recommendation.\n\nAssumption: the estimate holds.',
      parents: [hypothesis?.id],
      supersedes: draft?.id,
      payload: { version: 2, confidence: 0.8, cites: [hypothesis?.id] },
    });
  });

  it('is version 1 and supersedes nothing when the run never drafted an answer', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    const contribution = writeUpContribution(fx.view(), {
      paragraphs: ['Only this.'],
      confidence: 0.3,
      citeIds: [problem.id],
    });
    expect(contribution.payload.version).toBe(1);
    expect('supersedes' in contribution).toBe(false);
    expect(contribution.content).toBe('Only this.');
  });
});
