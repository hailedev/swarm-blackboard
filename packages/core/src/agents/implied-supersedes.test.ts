import { describe, expect, it } from 'vitest';

import type { Contribution } from '../schemas/contribution';
import { BoardFixture } from '../testing/board-fixture';
import { withImpliedSupersedes } from './implied-supersedes';

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
