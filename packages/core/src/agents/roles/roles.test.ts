import { describe, expect, it } from 'vitest';

import { testRolePrompts } from '../../testing/role-prompts';

const PROMPTS = testRolePrompts();

import { createFakeModel } from '../../model/fake-model';
import { UUID_MODEL_REFERENCES } from '../../schemas/contribution';
import { agentContext } from '../../testing/agent-context';
import { BoardFixture } from '../../testing/board-fixture';
import { createRoleAgent } from '../agent';
import { critic } from './critic';
import { planner } from './planner';
import { researcher } from './researcher';
import { solver } from './solver';
import { synthesizer } from './synthesizer';

const hypothesisPayload = { confidence: 0.5, supportedBy: [], contradictedBy: [] };
const roles = { planner, researcher, solver, critic, synthesizer };

const eligibleRoles = (fx: BoardFixture, ctx = agentContext()) =>
  Object.entries(roles)
    .filter(([, def]) => def.trigger(fx.view(), ctx).eligible)
    .map(([name]) => name);

describe('role triggers', () => {
  it('only the planner is eligible on a new board', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    expect(eligibleRoles(fx)).toEqual(['planner']);
    const trigger = planner.trigger(fx.view(), agentContext());
    expect(trigger.priority).toBe(100);
    expect(trigger.targetIds).toEqual([problem.id]);
  });

  it('nobody is eligible on an empty board', () => {
    expect(eligibleRoles(new BoardFixture())).toEqual([]);
  });

  it('planner re-enters on a stall at lower priority', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('subproblem', { status: 'done' });
    expect(planner.trigger(fx.view(), agentContext()).eligible).toBe(false);
    const stalled = planner.trigger(fx.view(), agentContext({ flags: { stallDetected: true } }));
    expect(stalled.eligible).toBe(true);
    expect(stalled.priority).toBe(90);
  });

  it('open subproblems wake the researcher and solver, not the critic', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const sub = fx.entry('subproblem', { status: 'open' });
    expect(eligibleRoles(fx)).toEqual(['researcher', 'solver']);
    expect(researcher.trigger(fx.view(), agentContext()).targetIds).toEqual([sub.id]);
    expect(solver.trigger(fx.view(), agentContext()).priority).toBe(70);
    expect(researcher.trigger(fx.view(), agentContext()).priority).toBe(60);
  });

  it('an uncritiqued hypothesis wakes the critic (80) and the synthesizer (50)', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', hypothesisPayload);
    expect(eligibleRoles(fx)).toEqual(['researcher', 'critic', 'synthesizer']);
    const c = critic.trigger(fx.view(), agentContext());
    expect(c.priority).toBe(80);
    expect(c.targetIds).toEqual([h.id]);
    expect(synthesizer.trigger(fx.view(), agentContext()).priority).toBe(50);
  });

  it('critic returns for new evidence on an already critiqued hypothesis', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: h.id, severity: 'minor' });
    expect(critic.trigger(fx.view(), agentContext({ round: 2 })).eligible).toBe(false);
    fx.startRound(2);
    fx.entry('evidence', { source: 's', supports: [h.id], contradicts: [] });
    const trigger = critic.trigger(fx.view(), agentContext({ round: 3 }));
    expect(trigger.eligible).toBe(true);
    expect(trigger.reason).toBe('new evidence on hypotheses');
    expect(critic.trigger(fx.view(), agentContext({ round: 5 })).eligible).toBe(false);
  });

  it('critic is forced to top priority on conflict, only when hypotheses exist', () => {
    const fx = new BoardFixture();
    fx.problem();
    const forced = agentContext({ flags: { criticForced: true } });
    expect(critic.trigger(fx.view(), forced).eligible).toBe(false);
    fx.startRound(1);
    fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', {
      target: fx.view().liveOfType('hypothesis')[0]?.id ?? '',
      severity: 'minor',
    });
    expect(critic.trigger(fx.view(), forced).priority).toBe(100);
  });

  it('synthesizer is gated by decisionRequired until synthesisFromRound, which overrides it', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: h.id, severity: 'blocking' });
    expect(synthesizer.trigger(fx.view(), agentContext()).eligible).toBe(false);
    const forced = synthesizer.trigger(fx.view(), agentContext({ round: 8 }));
    expect(forced.eligible).toBe(true);
    expect(forced.priority).toBe(95);
    expect(forced.targetIds).toEqual([]);

    const gated = fx.entry('hypothesis', hypothesisPayload);
    const early = synthesizer.trigger(
      fx.view(),
      agentContext({ round: 3, flags: { decisionRequired: true } }),
    );
    expect(early.eligible).toBe(false);
    expect(early.reason).toContain('decision');
    // Until Phase 5 nothing posts decisions, so the round rule must still produce an answer.
    const late = synthesizer.trigger(
      fx.view(),
      agentContext({ round: 8, flags: { decisionRequired: true } }),
    );
    expect(late.eligible).toBe(true);
    expect(late.targetIds).toEqual([gated.id]);
    expect(late.reason).toContain('decision still pending');
  });

  it('a synthesis the user forced overrides every gate, on any board', () => {
    const forced = agentContext({ flags: { synthesisForced: true } });
    // Nothing but the problem on the board: still mandatory, with nothing to target.
    const bare = new BoardFixture();
    bare.problem();
    expect(synthesizer.trigger(bare.view(), agentContext()).eligible).toBe(false);
    expect(synthesizer.trigger(bare.view(), forced)).toEqual({
      eligible: true,
      priority: 100,
      targetIds: [],
      reason: 'forced by the user',
      mandatory: true,
    });

    // A blocked hypothesis and a pending decision: early in the run the trigger says no.
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const blocked = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: blocked.id, severity: 'blocking' });
    const open = fx.entry('hypothesis', hypothesisPayload);
    const gated = agentContext({ round: 2, flags: { decisionRequired: true } });
    expect(synthesizer.trigger(fx.view(), gated).eligible).toBe(false);
    const overridden = synthesizer.trigger(
      fx.view(),
      agentContext({ round: 2, flags: { decisionRequired: true, synthesisForced: true } }),
    );
    expect(overridden.mandatory).toBe(true);
    expect(overridden.targetIds).toEqual([open.id]);
    // The flag is the Synthesizer's alone: nobody else becomes mandatory.
    for (const role of [planner, researcher, solver, critic]) {
      expect(role.trigger(fx.view(), forced).mandatory).toBe(false);
    }
  });
});

describe('role output schemas', () => {
  const question = { type: 'question', content: 'Why?', parents: [], payload: {} };
  const hypothesis = { type: 'hypothesis', content: 'H', parents: [], payload: hypothesisPayload };
  const synthesis = {
    type: 'synthesis',
    content: ['S'],
    parents: [],
    payload: { version: 1, confidence: 0.9, cites: [] },
  };

  it('the critic cannot propose hypotheses or syntheses', () => {
    expect(
      critic.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [question] }).success,
    ).toBe(true);
    expect(
      critic.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [hypothesis] }).success,
    ).toBe(false);
    expect(
      critic.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [synthesis] }).success,
    ).toBe(false);
  });

  it('the synthesizer returns exactly one synthesis', () => {
    expect(
      synthesizer.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [synthesis] })
        .success,
    ).toBe(true);
    expect(
      synthesizer.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [] }).success,
    ).toBe(false);
    expect(
      synthesizer
        .outputSchema(UUID_MODEL_REFERENCES)
        .safeParse({ contributions: [synthesis, synthesis] }).success,
    ).toBe(false);
    expect(
      synthesizer.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [hypothesis] })
        .success,
    ).toBe(false);
  });

  it('researcher produces evidence only; planner and solver stay in their lanes', () => {
    const evidence = {
      type: 'evidence',
      content: 'E',
      parents: [],
      payload: { source: 's', supports: [], contradicts: [] },
    };
    expect(
      researcher.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [evidence] })
        .success,
    ).toBe(true);
    expect(
      researcher.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [hypothesis] })
        .success,
    ).toBe(false);
    expect(
      planner.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [question] }).success,
    ).toBe(true);
    expect(
      planner.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [hypothesis] })
        .success,
    ).toBe(false);
    expect(
      solver.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [hypothesis] }).success,
    ).toBe(true);
    expect(
      solver.outputSchema(UUID_MODEL_REFERENCES).safeParse({ contributions: [evidence] }).success,
    ).toBe(false);
  });
});

describe('createRoleAgent', () => {
  it('renders a prompt, calls the bound model and returns its contributions', async () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    const model = createFakeModel({
      script: [
        {
          object: {
            contributions: [
              {
                type: 'subproblem',
                content: 'Part A',
                parents: ['P1'],
                payload: { status: 'open' },
              },
            ],
          },
        },
      ],
    });
    const agent = createRoleAgent(planner, { model }, PROMPTS.planner);
    const result = await agent.act(fx.view(), agentContext({ runId: fx.runId, round: 1 }));
    expect(agent.id).toBe('planner');
    expect(result.ok && result.value.contributions.map((c) => c.content)).toEqual(['Part A']);
    expect(result.ok && result.value.contributions[0]?.parents).toEqual([problem.id]);
    const call = model.calls[0];
    expect(call?.request.tags).toEqual({ role: 'planner', runId: fx.runId, round: 1 });
    expect(call?.request.prompt).toContain(problem.content);
  });

  it('wraps model failures as agent errors', async () => {
    const fx = new BoardFixture();
    fx.problem();
    const model = createFakeModel({
      script: [{ error: { kind: 'network', message: 'offline', attempts: 1 } }],
    });
    const result = await createRoleAgent(critic, { model }, PROMPTS.critic).act(
      fx.view(),
      agentContext(),
    );
    expect(!result.ok && result.error).toEqual({
      kind: 'model',
      error: { kind: 'network', message: 'offline', attempts: 1 },
    });
  });

  it('rejects contributions the role may not make, via the shared schema path', async () => {
    const fx = new BoardFixture();
    fx.problem();
    const proposal = {
      object: {
        contributions: [
          { type: 'hypothesis', content: 'H', parents: [], payload: hypothesisPayload },
        ],
      },
    };
    // Rejected on the first answer and again on the repair attempt.
    const model = createFakeModel({ script: [proposal, proposal] });
    const result = await createRoleAgent(critic, { model }, PROMPTS.critic).act(
      fx.view(),
      agentContext(),
    );
    expect(!result.ok && result.error.error.kind).toBe('invalid_output');
    expect(model.calls.map((c) => c.outcome)).toEqual(['invalid_output', 'invalid_output']);
  });
});
