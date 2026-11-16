import { describe, expect, it } from 'vitest';

import { critic } from '../agents/roles/critic';
import { RunConfigSchema } from '../schemas/run-config';
import { agentContext } from '../testing/agent-context';
import { BoardFixture } from '../testing/board-fixture';
import { checkTermination, synthesisReady } from './termination';

const config = RunConfigSchema.parse({});
const base = {
  config,
  budget: null,
  starved: false,
  stalled: false,
  eligibleCount: 3,
  decisionRequired: false,
  criticPending: false,
} as const;

// The end the controller would find on this board: the Critic's own trigger says whether
// it has anything left to review, as in controller.ts.
const endOf = (fx: BoardFixture) =>
  checkTermination({
    ...base,
    view: fx.view(),
    criticPending: critic.trigger(fx.view(), agentContext({ round: fx.round + 1 })).eligible,
  });

const HYP = { confidence: 0.9, supportedBy: [], contradictedBy: [] };

// A board a run may end on: a hypothesis (round 1), the Critic's review of it (round 2,
// nothing raised) and a confident synthesis written after both (round 3).
const settled = (confidence = 0.9) => {
  const fx = new BoardFixture();
  fx.problem();
  fx.startRound(1);
  const hypothesis = fx.entry('hypothesis', HYP);
  fx.completeRound({ solver: [] });
  fx.startRound(2);
  fx.completeRound({ critic: [hypothesis.id] });
  fx.startRound(3);
  const synthesis = fx.entry('synthesis', { version: 1, confidence, cites: [hypothesis.id] });
  fx.completeRound({ synthesizer: [hypothesis.id] });
  return { fx, hypothesis, synthesis };
};

describe('checkTermination', () => {
  it('continues while nothing holds', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
  });

  it('completes on a confident synthesis written after the Critic has reviewed what stands', () => {
    const { fx } = settled(0.8);
    expect(endOf(fx)).toBe('completed');
  });

  it('does not stop on a synthesis below the threshold', () => {
    const { fx } = settled(0.79);
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
    expect(checkTermination({ ...base, view: fx.view(), budget: 'budget_cost' })).toBe(
      'budget_cost',
    );
  });

  it('does not stop while a blocking or a major critique is open, and does on a minor one', () => {
    for (const severity of ['blocking', 'major'] as const) {
      const { fx, hypothesis } = settled();
      // Posted in round 2, before the synthesis: it read the critique, and still the run waits.
      fx.round = 2;
      fx.entry('critique', { target: hypothesis.id, severity });
      expect(synthesisReady(fx.view(), config)).toBe(false);
    }
    const { fx, hypothesis } = settled();
    fx.round = 2;
    fx.entry('critique', { target: hypothesis.id, severity: 'minor' });
    expect(synthesisReady(fx.view(), config)).toBe(true);
  });

  it('is not held by a critique of a hypothesis a decision rejected', () => {
    const { fx, hypothesis } = settled();
    fx.round = 2;
    const rejected = fx.entry('hypothesis', HYP);
    fx.entry('critique', { target: rejected.id, severity: 'blocking' });
    fx.entry('decision', {
      chosen: hypothesis.id,
      rejected: [rejected.id],
      rationale: 'Better backed.',
    });
    expect(synthesisReady(fx.view(), config)).toBe(true);
  });

  it('does not stop on a synthesis written in the round a critique or a hypothesis landed', () => {
    // The synthesis of round 3 was written beside these: it has not read them.
    const critiqued = settled();
    critiqued.fx.entry('critique', { target: critiqued.hypothesis.id, severity: 'minor' });
    expect(synthesisReady(critiqued.fx.view(), config)).toBe(false);

    const revised = settled();
    const version = revised.fx.entry('hypothesis', HYP, { supersedes: revised.hypothesis.id });
    expect(synthesisReady(revised.fx.view(), config)).toBe(false);
    // Nor on one a later round has overtaken, until a synthesis has been written after
    // the new version and the Critic has seen that version.
    revised.fx.completeRound({ solver: [revised.hypothesis.id] });
    revised.fx.startRound(4);
    revised.fx.entry(
      'synthesis',
      { version: 2, confidence: 0.9, cites: [version.id] },
      { supersedes: revised.synthesis.id },
    );
    revised.fx.completeRound({ synthesizer: [version.id] });
    expect(synthesisReady(revised.fx.view(), config)).toBe(true);
    expect(endOf(revised.fx)).toBeNull();
    revised.fx.startRound(5);
    revised.fx.completeRound({ critic: [version.id] });
    expect(endOf(revised.fx)).toBe('completed');
  });

  it('does not stop while the Critic has a standing version left to review', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', HYP);
    fx.completeRound({ solver: [] });
    fx.startRound(2);
    fx.entry('synthesis', { version: 1, confidence: 0.9, cites: [hypothesis.id] });
    fx.completeRound({ synthesizer: [hypothesis.id] });
    // Confident, current, nothing open: but nobody has looked at the hypothesis.
    expect(synthesisReady(fx.view(), config)).toBe(true);
    expect(endOf(fx)).toBeNull();
    // A review whose call failed is no review.
    fx.startRound(3);
    fx.failedCall('critic', [hypothesis.id]);
    expect(endOf(fx)).toBeNull();
    fx.startRound(4);
    fx.completeRound({ critic: [hypothesis.id] });
    expect(endOf(fx)).toBe('completed');
    // Evidence posted since the review sends the Critic back.
    fx.startRound(5);
    fx.entry('evidence', { source: 's', supports: [hypothesis.id], contradicts: [] });
    fx.completeRound({ researcher: [hypothesis.id] });
    expect(endOf(fx)).toBeNull();
    // A roster with no Critic is not held: there is nobody whose review to wait for.
    expect(checkTermination({ ...base, view: fx.view() })).toBe('completed');
  });

  it('reports budgets, starvation, stalls and empty eligibility in order', () => {
    const fx = new BoardFixture();
    fx.problem();
    const view = fx.view();
    expect(
      checkTermination({
        ...base,
        view,
        budget: 'budget_rounds',
        starved: true,
        stalled: true,
        eligibleCount: 0,
      }),
    ).toBe('budget_rounds');
    expect(checkTermination({ ...base, view, budget: 'budget_tokens' })).toBe('budget_tokens');
    expect(checkTermination({ ...base, view, budget: 'budget_time' })).toBe('budget_time');
    expect(checkTermination({ ...base, view, starved: true, stalled: true })).toBe('budget_cost');
    expect(checkTermination({ ...base, view, stalled: true, eligibleCount: 0 })).toBe('stalled');
    expect(checkTermination({ ...base, view, eligibleCount: 0 })).toBe('no_eligible_agents');
  });

  it('holds a confident synthesis back while a contradiction is undecided', () => {
    const { fx } = settled(0.95);
    const view = fx.view();
    expect(synthesisReady(view, config)).toBe(true);
    expect(checkTermination({ ...base, view, decisionRequired: true })).toBeNull();
    // The run then ends on whatever else holds, never on `completed`.
    expect(
      checkTermination({ ...base, view, decisionRequired: true, budget: 'budget_rounds' }),
    ).toBe('budget_rounds');
    expect(checkTermination({ ...base, view, decisionRequired: true, stalled: true })).toBe(
      'stalled',
    );
    expect(checkTermination({ ...base, view, decisionRequired: false })).toBe('completed');
  });

  it('a confident synthesis wins over an exhausted budget', () => {
    const { fx } = settled(0.99);
    expect(checkTermination({ ...base, view: fx.view(), budget: 'budget_rounds' })).toBe(
      'completed',
    );
  });
});
