import { describe, expect, it } from 'vitest';

import type { Contribution } from '../schemas/contribution';
import { BoardFixture } from '../testing/board-fixture';
import { settleAnswers, withImpliedSupersedes } from './implied-supersedes';

// Two hypotheses, each with a critique against it.
const contested = () => {
  const fx = new BoardFixture();
  fx.problem();
  fx.startRound(1);
  const first = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
  const second = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
  fx.startRound(2);
  const onFirst = fx.entry('critique', { target: first.id, severity: 'blocking' });
  const alsoOnFirst = fx.entry('critique', { target: first.id, severity: 'major' });
  const onSecond = fx.entry('critique', { target: second.id, severity: 'major' });
  return { fx, first, second, onFirst, alsoOnFirst, onSecond };
};

const hypothesis = (resolves: string[] | undefined, supersedes?: string): Contribution => ({
  type: 'hypothesis',
  content: 'A better version.',
  parents: [],
  ...(supersedes === undefined ? {} : { supersedes }),
  payload: {
    confidence: 0.7,
    supportedBy: [],
    contradictedBy: [],
    ...(resolves === undefined ? {} : { resolves }),
  },
});

describe('withImpliedSupersedes', () => {
  it('makes a hypothesis the new version of the one whose critiques it names', () => {
    const { fx, first, onFirst, alsoOnFirst } = contested();
    const [result] = withImpliedSupersedes(fx.view(), [hypothesis([onFirst.id, alsoOnFirst.id])]);
    expect(result?.supersedes).toBe(first.id);
  });

  it('leaves what the model said it supersedes alone', () => {
    const { fx, second, onFirst } = contested();
    const [result] = withImpliedSupersedes(fx.view(), [hypothesis([onFirst.id], second.id)]);
    expect(result?.supersedes).toBe(second.id);
  });

  it('adds nothing when the critiques named are against two standing hypotheses', () => {
    const { fx, onFirst, onSecond } = contested();
    const [result] = withImpliedSupersedes(fx.view(), [hypothesis([onFirst.id, onSecond.id])]);
    expect(result?.supersedes).toBeUndefined();
  });

  it('adds nothing to a hypothesis that names no critique, or to another type', () => {
    const { fx, first } = contested();
    const critique: Contribution = {
      type: 'critique',
      content: 'Still wrong.',
      parents: [first.id],
      payload: { target: first.id, severity: 'minor' },
    };
    const results = withImpliedSupersedes(fx.view(), [
      hypothesis(undefined),
      hypothesis([]),
      critique,
    ]);
    expect(results.map((c) => c.supersedes)).toEqual([undefined, undefined, undefined]);
    expect(results[2]).toBe(critique);
  });

  it('gives a hypothesis one new version per reply, not two', () => {
    const { fx, first, onFirst, alsoOnFirst } = contested();
    const results = withImpliedSupersedes(fx.view(), [
      hypothesis([onFirst.id]),
      hypothesis([alsoOnFirst.id]),
    ]);
    expect(results.map((c) => c.supersedes)).toEqual([first.id, undefined]);
    // Nor a second one beside a version the model linked itself.
    const mixed = withImpliedSupersedes(fx.view(), [
      hypothesis([alsoOnFirst.id]),
      hypothesis([onFirst.id], first.id),
    ]);
    expect(mixed.map((c) => c.supersedes)).toEqual([undefined, first.id]);
  });

  it('ignores critiques of a hypothesis that was replaced or rejected', () => {
    const { fx, first, second, onFirst, onSecond } = contested();
    fx.startRound(3);
    fx.entry(
      'hypothesis',
      { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      { supersedes: first.id },
    );
    // The first is replaced: only the critique of the second still points at something standing.
    const [narrowed] = withImpliedSupersedes(fx.view(), [hypothesis([onFirst.id, onSecond.id])]);
    expect(narrowed?.supersedes).toBe(second.id);
    const [none] = withImpliedSupersedes(fx.view(), [hypothesis([onFirst.id])]);
    expect(none?.supersedes).toBeUndefined();

    const other = fx.entry('hypothesis', { confidence: 0.4, supportedBy: [], contradictedBy: [] });
    fx.entry('decision', { chosen: other.id, rejected: [second.id], rationale: 'Better backed.' });
    const [rejected] = withImpliedSupersedes(fx.view(), [hypothesis([onSecond.id])]);
    expect(rejected?.supersedes).toBeUndefined();
  });
});

describe('settleAnswers: one answer per subproblem', () => {
  const HYP = { confidence: 0.5, supportedBy: [], contradictedBy: [] };
  // S1 answered by H1, S2 by H2, S3 by nothing.
  const answered = () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const s1 = fx.entry('subproblem', { status: 'open' });
    const s2 = fx.entry('subproblem', { status: 'open' });
    const s3 = fx.entry('subproblem', { status: 'open' });
    fx.startRound(2);
    const h1 = fx.entry('hypothesis', HYP, { parents: [s1.id] });
    const h2 = fx.entry('hypothesis', HYP, { parents: [s2.id] });
    return { fx, s1, s2, s3, h1, h2 };
  };
  const answerTo = (
    parents: string[],
    extra: { supersedes?: string; rivalOf?: string[]; content?: string } = {},
  ): Contribution => ({
    type: 'hypothesis',
    content: extra.content ?? 'An answer.',
    parents,
    ...(extra.supersedes === undefined ? {} : { supersedes: extra.supersedes }),
    payload: { ...HYP, ...(extra.rivalOf === undefined ? {} : { rivalOf: extra.rivalOf }) },
  });

  it('lets a subproblem with no answer take one, and only one, from a reply', () => {
    const { fx, s3 } = answered();
    const settled = settleAnswers(fx.view(), [
      answerTo([s3.id], { content: 'first' }),
      answerTo([s3.id], { content: 'second' }),
    ]);
    expect(settled.contributions.map((c) => c.content)).toEqual(['first']);
    expect(settled.dropped).toBe(1);
  });

  it('links a hypothesis that says nothing to the one answer its subproblem has', () => {
    const { fx, s1, h1 } = answered();
    const settled = settleAnswers(fx.view(), [answerTo([s1.id])]);
    expect(settled.contributions[0]?.supersedes).toBe(h1.id);
    expect(settled.dropped).toBe(0);
  });

  it('keeps one new version of a hypothesis per reply', () => {
    const { fx, s1, h1 } = answered();
    const settled = settleAnswers(fx.view(), [
      answerTo([s1.id], { supersedes: h1.id, content: 'first' }),
      answerTo([s1.id], { supersedes: h1.id, content: 'second' }),
      // Says nothing: the one answer of S1 is already replaced by this reply.
      answerTo([s1.id], { content: 'third' }),
    ]);
    expect(settled.contributions.map((c) => c.content)).toEqual(['first']);
    expect(settled.dropped).toBe(2);
  });

  it('keeps a declared rival beside the answer it rivals, and beside its new version', () => {
    const { fx, s1, h1 } = answered();
    const settled = settleAnswers(fx.view(), [
      answerTo([s1.id], { supersedes: h1.id, content: 'new version' }),
      answerTo([s1.id], { rivalOf: [h1.id], content: 'rival' }),
    ]);
    expect(settled.contributions.map((c) => c.content)).toEqual(['new version', 'rival']);
    expect(settled.dropped).toBe(0);
  });

  it('strikes a subproblem that already has another answer from the parents', () => {
    const { fx, s1, s2, s3, h1 } = answered();
    // A new version of S1's answer that also lists S2 (answered by H2) and S3 (unanswered).
    const settled = settleAnswers(fx.view(), [
      answerTo([s1.id, s2.id, s3.id], { supersedes: h1.id }),
    ]);
    expect(settled.contributions[0]?.parents).toEqual([s1.id, s3.id]);
    expect(settled.dropped).toBe(0);
  });

  it('drops a hypothesis that would stand beside two answers without replacing either or being their rival', () => {
    const { fx, s1, h1 } = answered();
    fx.startRound(3);
    fx.entry('hypothesis', { ...HYP, rivalOf: [h1.id] }, { parents: [s1.id] });
    const settled = settleAnswers(fx.view(), [answerTo([s1.id])]);
    expect(settled.contributions).toEqual([]);
    expect(settled.dropped).toBe(1);
  });

  it('passes other contributions, and hypotheses that name no subproblem, through', () => {
    const { fx, h1 } = answered();
    const critique: Contribution = {
      type: 'critique',
      content: 'Wrong.',
      parents: [h1.id],
      payload: { target: h1.id, severity: 'minor' },
    };
    const loose = answerTo([]);
    const settled = settleAnswers(fx.view(), [critique, loose, loose]);
    expect(settled.contributions).toEqual([critique, loose, loose]);
    expect(settled.dropped).toBe(0);
  });
});
