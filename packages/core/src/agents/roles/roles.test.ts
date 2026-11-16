import { describe, expect, it } from 'vitest';

import { testRolePrompts } from '../../testing/role-prompts';

const PROMPTS = testRolePrompts();

import { createFakeModel } from '../../model/fake-model';
import { UUID_MODEL_REFERENCES } from '../../schemas/contribution';
import { agentContext } from '../../testing/agent-context';
import { BoardFixture } from '../../testing/board-fixture';
import { createRoleAgent } from '../agent';
import { boardChangedSinceLastSynthesis } from '../eligibility';
import { renderAgentPrompt } from '../prompt';
import { critic } from './critic';
import { planner } from './planner';
import { researcher } from './researcher';
import { MAX_CONTESTED_PER_CALL, solver } from './solver';
import { MAX_DECISIONS_PER_CALL, synthesizer } from './synthesizer';

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

  it('synthesizer waits for an unblocked hypothesis or synthesisFromRound, and decides when a decision is owed', () => {
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
    // A decision is owed: the Synthesizer is the one who posts it, in any round.
    expect(early).toMatchObject({
      eligible: true,
      priority: 90,
      mandatory: false,
      targetIds: [gated.id],
      reason: 'contradicting hypotheses critiqued: decide, then synthesise',
    });
    const late = synthesizer.trigger(
      fx.view(),
      agentContext({ round: 8, flags: { decisionRequired: true } }),
    );
    expect(late).toMatchObject({ eligible: true, priority: 95, targetIds: [gated.id] });
    expect(late.reason).toContain('decide');
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

    // A blocked hypothesis and a decision owed: early in the run the trigger makes the
    // Synthesizer eligible to decide, but not certain to run.
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const blocked = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: blocked.id, severity: 'blocking' });
    const open = fx.entry('hypothesis', hypothesisPayload);
    const gated = agentContext({ round: 2, flags: { decisionRequired: true } });
    expect(synthesizer.trigger(fx.view(), gated)).toMatchObject({
      eligible: true,
      priority: 90,
      mandatory: false,
    });
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

describe('the Solver is sent back to a hypothesis with critiques that stand', () => {
  const contested = () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const open = fx.entry('subproblem', { status: 'open' }, { parents: [problem.id] });
    const sound = fx.entry('hypothesis', hypothesisPayload);
    const major = fx.entry('hypothesis', hypothesisPayload);
    const blocked = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: sound.id, severity: 'minor' });
    fx.entry('critique', { target: major.id, severity: 'major' });
    fx.entry('critique', { target: blocked.id, severity: 'blocking' });
    return { fx, open, sound, major, blocked };
  };

  it('ahead of new work, the worst contested first, then its usual targets', () => {
    const { fx, open, sound, major, blocked } = contested();
    const trigger = solver.trigger(fx.view(), agentContext({ round: 3 }));
    expect(trigger).toMatchObject({
      eligible: true,
      priority: 85,
      mandatory: false,
      reason: 'critiques to answer on live hypotheses',
    });
    // The blocking critique's hypothesis, then the major one; a minor critique sends nobody
    // back; the open subproblem comes after them.
    expect(trigger.targetIds).toEqual([blocked.id, major.id, open.id]);
    expect(trigger.targetIds).not.toContain(sound.id);
    // Above the Critic's 80, so the answer is not queued behind more critiques.
    expect(critic.trigger(fx.view(), agentContext({ round: 3 })).priority).toBeLessThan(85);
  });

  it('at most four per call, and not once the critique is answered, resolved or the hypothesis rejected', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const many = Array.from({ length: 6 }, () => fx.entry('hypothesis', hypothesisPayload));
    const critiques = many.map((h) => fx.entry('critique', { target: h.id, severity: 'major' }));
    const first = () => solver.trigger(fx.view(), agentContext({ round: 3 }));
    expect(first().targetIds).toEqual(many.slice(0, MAX_CONTESTED_PER_CALL).map((h) => h.id));

    // Superseding the first answers its critique: it leaves the list, the fifth joins it.
    const [h1, h2, h3, h4, h5, h6] = many;
    const [c1] = critiques;
    if (!h1 || !h2 || !h3 || !h4 || !h5 || !h6 || !c1) throw new Error('fixture');
    fx.entry('hypothesis', { ...hypothesisPayload, resolves: [c1.id] }, { supersedes: h1.id });
    expect(first().targetIds).toEqual([h2.id, h3.id, h4.id, h5.id]);
    // A decision that rejects one takes it out of the running, critiques and all.
    fx.entry('decision', { chosen: h6.id, rejected: [h2.id], rationale: 'r' });
    expect(first().targetIds).toEqual([h3.id, h4.id, h5.id, h6.id]);
  });

  it('is as before when nothing is contested', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const open = fx.entry('subproblem', { status: 'open' }, { parents: [problem.id] });
    expect(solver.trigger(fx.view(), agentContext({ round: 2 }))).toMatchObject({
      eligible: true,
      priority: 70,
      targetIds: [open.id],
      reason: 'open subproblems or unexplained evidence',
    });
  });
});

describe('the Synthesizer runs only when the board has changed since it last wrote', () => {
  const drafted = () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', hypothesisPayload);
    fx.startRound(2);
    const draft = fx.entry('synthesis', { version: 1, confidence: 0.5, cites: [hypothesis.id] });
    return { fx, hypothesis, draft };
  };
  const at = (round: number, flags = {}) => agentContext({ round, flags });

  it('is idle on an unchanged board, early and from synthesisFromRound alike', () => {
    const { fx } = drafted();
    expect(boardChangedSinceLastSynthesis(fx.view())).toBe(false);
    for (const round of [3, 8, 12]) {
      expect(synthesizer.trigger(fx.view(), at(round))).toMatchObject({
        eligible: false,
        reason: 'nothing has changed since the last synthesis',
      });
    }
    // The user can still ask for one.
    expect(synthesizer.trigger(fx.view(), at(3, { synthesisForced: true })).mandatory).toBe(true);
  });

  it('is eligible again once anything but a synthesis lands, in a later round or the same one', () => {
    const later = drafted();
    later.fx.startRound(3);
    later.fx.entry('critique', { target: later.hypothesis.id, severity: 'minor' });
    expect(boardChangedSinceLastSynthesis(later.fx.view())).toBe(true);
    expect(synthesizer.trigger(later.fx.view(), at(4)).eligible).toBe(true);

    // Posted by another agent in the round of the synthesis: the Synthesizer read the board
    // as that round started, so it has not seen it.
    const same = drafted();
    same.fx.entry('evidence', { source: 's', supports: [same.hypothesis.id], contradicts: [] });
    expect(synthesizer.trigger(same.fx.view(), at(3)).eligible).toBe(true);

    // A second synthesis is not a change, even one that forgot to supersede the first.
    const twice = drafted();
    twice.fx.startRound(3);
    twice.fx.entry('synthesis', { version: 1, confidence: 0.5, cites: [] });
    expect(synthesizer.trigger(twice.fx.view(), at(4)).eligible).toBe(false);
  });

  it('has changed by definition before the first synthesis', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(boardChangedSinceLastSynthesis(fx.view())).toBe(true);
  });
});

describe('the decision flow in the roles', () => {
  // Three hypotheses; evidence supports the first and contradicts the second.
  const contradiction = () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const a = fx.entry('hypothesis', hypothesisPayload);
    const b = fx.entry('hypothesis', hypothesisPayload);
    const bystander = fx.entry('hypothesis', hypothesisPayload);
    const evidence = fx.entry('evidence', { source: 's', supports: [a.id], contradicts: [b.id] });
    return { fx, a, b, bystander, evidence };
  };

  it('aims the forced Critic at the contradicting hypotheses only, and makes it certain to run', () => {
    const { fx, a, b, bystander } = contradiction();
    const forced = critic.trigger(fx.view(), agentContext({ flags: { criticForced: true } }));
    expect(forced).toEqual({
      eligible: true,
      priority: 100,
      targetIds: [a.id, b.id],
      reason: 'forced: live hypotheses contradict each other',
      mandatory: true,
    });
    expect(forced.targetIds).not.toContain(bystander.id);
    // Unforced, it is the ordinary Critic again.
    expect(critic.trigger(fx.view(), agentContext()).mandatory).toBe(false);
  });

  it('names the contradiction in the prompt of whoever has to deal with it', () => {
    const { fx, a, b } = contradiction();
    const ctx = agentContext({
      runId: fx.runId,
      round: 2,
      targetIds: [a.id, b.id],
      flags: { criticForced: true },
    });
    const forced = renderAgentPrompt('critic', fx.view(), ctx, PROMPTS.critic).prompt;
    expect(forced).toContain(
      '# Contradictions to settle\n- H1 and H2 contradict each other (E1 supports one and contradicts the other)',
    );
    const quiet = renderAgentPrompt(
      'critic',
      fx.view(),
      { ...ctx, flags: { ...ctx.flags, criticForced: false } },
      PROMPTS.critic,
    ).prompt;
    expect(quiet).not.toContain('Contradictions to settle');
    // Once a decision settles it there is nothing to name.
    fx.entry('decision', { chosen: a.id, rejected: [b.id], rationale: 'r' });
    expect(renderAgentPrompt('critic', fx.view(), ctx, PROMPTS.critic).prompt).not.toContain(
      'Contradictions to settle',
    );
  });

  it('lets the Synthesizer post decisions only while one is owed, with exactly one synthesis', () => {
    const synthesis = {
      type: 'synthesis',
      content: ['S'],
      parents: [],
      payload: { version: 1, confidence: 0.9, cites: [] },
    };
    const decision = (rationale: string) => ({
      type: 'decision',
      content: 'D',
      parents: [],
      payload: {
        chosen: '00000000-0000-7000-8000-000000000001',
        rejected: ['00000000-0000-7000-8000-000000000002'],
        rationale,
      },
    });
    const flags = { ...agentContext().flags, decisionRequired: true };
    const quiet = synthesizer.outputSchema(UUID_MODEL_REFERENCES);
    const deciding = synthesizer.outputSchema(UUID_MODEL_REFERENCES, flags);
    const accepts = (schema: typeof quiet, contributions: unknown[]) =>
      schema.safeParse({ contributions }).success;

    expect(accepts(quiet, [synthesis])).toBe(true);
    expect(accepts(quiet, [decision('r'), synthesis])).toBe(false);

    expect(accepts(deciding, [synthesis])).toBe(true);
    expect(accepts(deciding, [decision('r'), synthesis])).toBe(true);
    expect(accepts(deciding, [decision('a'), decision('b'), decision('c'), synthesis])).toBe(true);
    // Never a decision without the synthesis, two syntheses, or more than three decisions.
    expect(accepts(deciding, [decision('r')])).toBe(false);
    expect(accepts(deciding, [synthesis, synthesis])).toBe(false);
    expect(
      accepts(deciding, [decision('a'), decision('b'), decision('c'), decision('d'), synthesis]),
    ).toBe(false);
    expect(MAX_DECISIONS_PER_CALL).toBe(3);
  });

  it('takes a rejected hypothesis out of the running, and puts the contradicting ones first when deciding', () => {
    const { fx, a, b, bystander } = contradiction();
    const deciding = synthesizer.trigger(
      fx.view(),
      agentContext({ round: 3, flags: { decisionRequired: true } }),
    );
    expect(deciding.targetIds).toEqual([a.id, b.id, bystander.id]);
    fx.entry('decision', { chosen: a.id, rejected: [b.id], rationale: 'r' });
    const after = synthesizer.trigger(fx.view(), agentContext({ round: 3 }));
    expect(after.targetIds).toEqual([a.id, bystander.id]);
  });
});
