import { describe, expect, it } from 'vitest';

import { createFakeModel, type FakeResponse } from '../model/fake-model';
import { agentContext } from '../testing/agent-context';
import { BoardFixture } from '../testing/board-fixture';
import { createRoleAgent } from './agent';
import { planner } from './roles/planner';

const board = () => {
  const fx = new BoardFixture();
  const problem = fx.problem();
  return { fx, problem };
};

const valid = (problemId: string): FakeResponse => ({
  object: {
    contributions: [
      { type: 'subproblem', content: 'Part A', parents: [problemId], payload: { status: 'open' } },
    ],
  },
  usage: { inputTokens: 100, outputTokens: 50 },
});

// `status: 'later'` is not a subproblem status, so the schema rejects it.
const invalid: FakeResponse = {
  object: {
    contributions: [
      { type: 'subproblem', content: 'x', parents: [], payload: { status: 'later' } },
    ],
  },
  usage: { inputTokens: 100, outputTokens: 20 },
};

describe('createRoleAgent: repair → fallback → discard', () => {
  it('repairs once on the same model, telling it what was wrong', async () => {
    const { fx, problem } = board();
    const model = createFakeModel({ script: [invalid, valid(problem.id)] });
    const agent = createRoleAgent(planner, { model });

    const result = await agent.act(fx.view(), agentContext({ runId: fx.runId, round: 1 }));

    expect(result.ok && result.value.contributions.map((c) => c.content)).toEqual(['Part A']);
    expect(model.calls.map((c) => c.outcome)).toEqual(['invalid_output', 'ok']);
    const repair = model.calls[1]?.request;
    expect(repair?.prompt).toContain('# Your previous answer was rejected');
    expect(repair?.prompt).toContain('contributions.0.payload.status');
    expect(repair?.prompt).toContain('"status":"later"');
    expect(repair?.system).toBe(model.calls[0]?.request.system);
    expect(repair?.maxOutputTokens).toBe(4096);
  });

  it('falls back to the profile fallback with the original prompt when repair also fails', async () => {
    const { fx, problem } = board();
    const model = createFakeModel({ id: 'local', script: [invalid, invalid] });
    const fallback = createFakeModel({ id: 'haiku', script: [valid(problem.id)] });
    const agent = createRoleAgent(planner, { model, fallback });

    const result = await agent.act(fx.view(), agentContext({ runId: fx.runId }));

    expect(result.ok).toBe(true);
    expect(model.calls.length).toBe(2);
    expect(fallback.calls.length).toBe(1);
    expect(fallback.calls[0]?.request.prompt).toBe(model.calls[0]?.request.prompt);
  });

  it('discards the output when there is no fallback', async () => {
    const { fx } = board();
    const model = createFakeModel({ script: [invalid, invalid] });
    const result = await createRoleAgent(planner, { model }).act(fx.view(), agentContext());
    expect(!result.ok && result.error.error.kind).toBe('invalid_output');
    expect(model.calls.length).toBe(2);
  });

  it('reports the fallback error when the fallback fails too', async () => {
    const { fx } = board();
    const model = createFakeModel({ script: [invalid, invalid] });
    const fallback = createFakeModel({ script: [invalid] });
    const result = await createRoleAgent(planner, { model, fallback }).act(
      fx.view(),
      agentContext(),
    );
    expect(!result.ok && result.error.error.kind).toBe('invalid_output');
    expect(fallback.calls.length).toBe(1);
  });

  it.each([
    ['billing', { kind: 'billing', message: 'credit balance too low' }],
    ['auth', { kind: 'auth', message: 'invalid x-api-key' }],
    ['rate_limit', { kind: 'rate_limit', message: '429', attempts: 3 }],
    ['network', { kind: 'network', message: 'ECONNREFUSED', attempts: 3 }],
    ['invalid_request', { kind: 'invalid_request', message: 'max_tokens too large' }],
  ] as const)('never repairs or falls back on a %s error', async (_kind, error) => {
    const { fx } = board();
    const model = createFakeModel({ script: [{ error }] });
    const fallback = createFakeModel({ script: [] });
    const result = await createRoleAgent(planner, { model, fallback }).act(
      fx.view(),
      agentContext(),
    );
    expect(!result.ok && result.error.error).toEqual(error);
    expect(model.calls.length).toBe(1);
    expect(fallback.calls.length).toBe(0);
  });

  it('does not fall back when the repair call fails with a provider error', async () => {
    const { fx } = board();
    const model = createFakeModel({
      script: [invalid, { error: { kind: 'overloaded', message: '529', attempts: 3 } }],
    });
    const fallback = createFakeModel({ script: [] });
    const result = await createRoleAgent(planner, { model, fallback }).act(
      fx.view(),
      agentContext(),
    );
    expect(!result.ok && result.error.error.kind).toBe('overloaded');
    expect(fallback.calls.length).toBe(0);
  });

  it('does not fall back when the controller refuses the call for budget reasons', async () => {
    const { fx } = board();
    const model = createFakeModel({ script: [] });
    const fallback = createFakeModel({ script: [] });
    const refusing = {
      call: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'budget_exhausted' as const, remainingUsd: 0.001, worstCaseUsd: 0.002 },
        }),
    };
    const result = await createRoleAgent(planner, { model, fallback }).act(
      fx.view(),
      agentContext({ models: refusing }),
    );
    expect(!result.ok && result.error.error.kind).toBe('budget_exhausted');
    expect(model.calls.length).toBe(0);
    expect(fallback.calls.length).toBe(0);
  });
});
