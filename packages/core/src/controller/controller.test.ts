import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  eligible,
  notEligible,
  createRoleAgent,
  type Agent,
  type AgentContext,
  type AgentError,
  type AgentResult,
} from '../agents/agent';
import { planner } from '../agents/roles/planner';
import {
  contestedHypotheses,
  latestSynthesis,
  subproblemStatus,
  standingAnswers,
  synthesisCandidates,
} from '../agents/eligibility';
import { WRITE_UP_ROLE } from '../agents/write-up';
import { createDefaultAgents } from '../agents/roster';
import { InMemoryBoardStore } from '../board/in-memory-board-store';
import { createFakeModel, type FakeResponse } from '../model/fake-model';
import { DEFAULT_CHARS_PER_TOKEN, type Model, type ModelError } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import { nullLogger, type Logger } from '../ports/logger';
import type { PeriodBudget } from '../ports/spend-ledger';
import { zeroUsage } from '../schemas/common';
import type { Contribution } from '../schemas/contribution';
import type { BoardEvent } from '../schemas/event';
import type { RunProfile } from '../schemas/roster';
import { FakeSpendLedger } from '../testing/fake-spend-ledger';
import { ManualClock } from '../testing/manual-clock';
import { testRolePrompts, testWriteUpPrompt } from '../testing/role-prompts';
import {
  createScriptedModels,
  SCENARIO_CALL_COST_USD,
  SCENARIO_PRICING,
  SCENARIO_TOKENS,
  type ScenarioPricing,
} from '../testing/scripted-scenario';
import { SequentialIdGenerator } from '../testing/sequential-id-generator';
import { createController, type Controller, type ControllerDeps } from './controller';
import { estimateInputTokens, fitCall } from './reservation';

// A minimal agent for exercising controller paths without the role rules. It never
// calls a model, so it records no usage.
const stubAgent = (
  id: string,
  options: {
    priority?: number | null;
    targetIds?: readonly string[];
    act?: (ctx: AgentContext) => Result<AgentResult, AgentError> | Contribution[];
    onCtx?: (ctx: AgentContext) => void;
  } = {},
): Agent => ({
  id,
  role: 'solver',
  trigger: () =>
    options.priority === null
      ? notEligible('off')
      : eligible(options.priority ?? 50, options.targetIds ?? [], 'on'),
  act: (_view, ctx) => {
    options.onCtx?.(ctx);
    const produced = options.act?.(ctx) ?? [];
    if (Array.isArray(produced)) return Promise.resolve(ok({ contributions: produced }));
    return Promise.resolve(produced);
  },
});

const modelError = (error: ModelError): Result<AgentResult, AgentError> =>
  err({ kind: 'model', error });

// An agent that makes exactly one call through the controller's gateway.
const EmptyOutputSchema = z.object({ contributions: z.array(z.never()) });
const gatewayAgent = (id: string, model: Model, priority: number): Agent => ({
  id,
  role: 'solver',
  trigger: () => eligible(priority, [], 'on'),
  async act(_view, ctx) {
    const response = await ctx.models.call(model, {
      schema: EmptyOutputSchema,
      system: 'sys',
      prompt: 'ask',
      tags: { role: 'solver', runId: ctx.runId, round: ctx.round },
    });
    return response.ok ? ok({ contributions: [] }) : err({ kind: 'model', error: response.error });
  },
});

interface Harness {
  controller: Controller;
  events: BoardEvent[];
  store: InMemoryBoardStore;
  clock: ManualClock;
}

const harness = (agents: readonly Agent[], overrides: Partial<ControllerDeps> = {}): Harness => {
  const events: BoardEvent[] = [];
  const store = new InMemoryBoardStore();
  const clock = new ManualClock();
  const { onEvent, ...rest } = overrides;
  const controller = createController({
    store,
    clock,
    ids: new SequentialIdGenerator(),
    logger: nullLogger,
    agents,
    ...rest,
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
  });
  return { controller, events, store, clock };
};

const scripted = (overrides: Partial<ControllerDeps> = {}, pricing: ScenarioPricing = {}) => {
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  }, pricing);
  const h = harness(createDefaultAgents(models, testRolePrompts()), overrides);
  ref.controller = h.controller;
  return { ...h, models };
};

const monthly = (ledger: FakeSpendLedger, limitUsd = 5): PeriodBudget => ({
  limitUsd,
  warnAtFraction: 0.8,
  timeZone: 'UTC',
  ledger,
});

const ofType = <T extends BoardEvent['type']>(events: readonly BoardEvent[], type: T) =>
  events.filter((e): e is Extract<BoardEvent, { type: T }> => e.type === type);

describe('createController', () => {
  it('starts a run with the problem entry, config defaults and no profile', async () => {
    const { controller, events, store } = harness([]);
    const started = await controller.start({
      content: 'Should we adopt a monorepo?',
      constraints: ['No downtime'],
    });
    expect(started.ok && started.value.author).toBe('human');
    expect(started.ok && started.value.payload.constraints).toEqual(['No downtime']);
    expect(events.map((e) => e.type)).toEqual(['run_started', 'entry_committed']);
    const runStarted = ofType(events, 'run_started')[0];
    expect(runStarted?.config.maxRounds).toBe(12);
    expect(runStarted?.config.maxCostUsd).toBe(0.25);
    expect(runStarted?.profile).toBeNull();
    expect(controller.currentView().problem()?.content).toBe('Should we adopt a monorepo?');
    expect((await store.eventsFor(controller.runId)).map((e) => e.seq)).toEqual([0, 1]);
    expect((await controller.start({ content: 'again' })).ok).toBe(false);
  });

  it('records the resolved profile on run_started', async () => {
    const local = { alias: 'local', provider: 'ollama' as const, model: 'qwen3.6:35b-mlx' };
    const profile: RunProfile = {
      name: 'dev',
      roles: {
        planner: local,
        researcher: local,
        solver: local,
        critic: local,
        synthesizer: local,
      },
      bidder: null,
      fallback: null,
      paid: false,
    };
    const { controller, events } = harness([], { profile });
    await controller.start({ content: 'P' });
    expect(ofType(events, 'run_started')[0]?.profile).toEqual(profile);
  });

  it('rejects an invalid config or problem and refuses rounds before start', async () => {
    const { controller } = harness([]);
    const beforeStart = await controller.runRound();
    expect(!beforeStart.ok && beforeStart.error.kind).toBe('not_started');
    const badConfig = await controller.start({ content: 'x' }, { parallelism: 0 });
    expect(!badConfig.ok && badConfig.error.kind).toBe('invalid_config');
    const badProblem = await controller.start({ content: '' });
    expect(!badProblem.ok && badProblem.error.kind).toBe('invalid_problem');
    const run = await harness([]).controller.run();
    expect(!run.ok && run.error.kind).toBe('not_started');
  });

  it('runs the scripted swarm to a confident synthesis', async () => {
    const { controller, events, models } = scripted();
    await controller.start({ content: 'Should we adopt a monorepo?' });
    const result = await controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('completed');
    expect(result.value.reason).toBe('completed');
    expect(result.value.rounds).toBe(4);
    // The problem, two subproblems, two hypotheses, one evidence, two critiques, a question
    // and the synthesis: nobody posts copies of a subproblem to say where it stands.
    expect(result.value.totals.entries).toBe(10);
    const calls = 7;
    expect(result.value.totals.usage).toEqual({
      inputTokens: SCENARIO_TOKENS.inputTokens * calls,
      outputTokens: SCENARIO_TOKENS.outputTokens * calls,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: expect.closeTo(SCENARIO_CALL_COST_USD * calls, 10) as number,
    });

    const selections = ofType(events, 'agents_selected').map((e) => e.selected);
    expect(selections).toEqual([
      ['planner'],
      ['solver', 'researcher'],
      ['critic', 'solver'],
      ['critic', 'synthesizer'],
    ]);
    expect(Object.values(models).map((m) => m.calls.length)).toEqual([1, 1, 2, 2, 1]);
    expect(ofType(events, 'agent_failed')).toEqual([]);
    // Well inside the default cap: no call was shrunk.
    for (const model of Object.values(models)) {
      for (const call of model.calls) expect(call.request.maxOutputTokens).toBe(4096);
    }
    // Usage is attributed to the first entry of each call and summed per round.
    const planned = ofType(events, 'entry_committed').filter((e) => e.entry.author === 'planner');
    expect(planned.map((e) => e.entry.usage.costUsd)).toEqual([
      expect.closeTo(SCENARIO_CALL_COST_USD, 10) as number,
      0,
    ]);
    expect(ofType(events, 'round_completed').map((e) => e.usage.inputTokens)).toEqual([
      1200, 2400, 2400, 2400,
    ]);

    const view = result.value.view;
    expect(view.liveOfType('hypothesis').map((h) => h.payload.confidence)).toEqual([0.85]);
    // Both subproblems are done because the live hypothesis is parented on them and only a
    // minor critique stands against it; the entries themselves still say what the Planner wrote.
    const subproblems = view.liveOfType('subproblem');
    expect(subproblems.map((s) => subproblemStatus(view, s))).toEqual(['done', 'done']);
    expect(subproblems.map((s) => s.payload.status)).toEqual(['open', 'open']);
    expect(subproblems.map((s) => s.author)).toEqual(['planner', 'planner']);
    expect(view.liveOfType('synthesis')[0]?.payload.cites.length).toBe(2);
    expect(view.openBlockingCritiques()).toEqual([]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run_terminated');

    const after = await controller.runRound();
    expect(!after.ok && after.error).toEqual({ kind: 'terminated', reason: 'completed' });
  });

  it.each([
    ['budget_rounds', { maxRounds: 2 }, 2],
    ['budget_tokens', { maxTokens: 2_000 }, 2],
    ['budget_cost', { maxCostUsd: 0.005 }, 2],
  ])('stops with %s', async (reason, config, rounds) => {
    const { controller } = scripted();
    await controller.start({ content: 'P' }, config);
    const result = await controller.run();
    expect(result.ok && result.value.status).toBe('completed');
    expect(result.ok && result.value.reason).toBe(reason);
    expect(result.ok && result.value.rounds).toBe(rounds);
  });

  it('stops on the wall clock using the injected clock', async () => {
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const clock = new ManualClock();
    const models = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('not ready');
      return ref.controller.currentView();
    });
    const h = harness(createDefaultAgents(models, testRolePrompts()), {
      clock,
      onEvent: (event) => {
        if (event.type === 'round_completed') clock.advance(6 * 60_000);
      },
    });
    ref.controller = h.controller;
    const controller = h.controller;
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('budget_time');
    expect(result.ok && result.value.rounds).toBe(3);
    expect(result.ok && result.value.totals.elapsedMs).toBe(18 * 60_000);
  });

  it('terminates before any model call when a budget is already exhausted', async () => {
    const { controller, events } = scripted();
    await controller.start({ content: 'P' }, { maxCostUsd: 0 });
    const report = await controller.runRound();
    expect(report.ok && report.value.ended).toEqual({ status: 'completed', reason: 'budget_cost' });
    expect(report.ok && report.value.round).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['run_started', 'entry_committed', 'run_terminated']);
  });

  it('hands each selected agent the ids its trigger matched, and triggers none', async () => {
    const seen: (readonly string[])[] = [];
    const agent = stubAgent('a', {
      targetIds: ['t1', 't2'],
      onCtx: (ctx) => {
        seen.push(ctx.targetIds);
      },
    });
    const triggerCtx: AgentContext[] = [];
    const originalTrigger = agent.trigger.bind(agent);
    agent.trigger = (view, ctx) => {
      triggerCtx.push(ctx);
      return originalTrigger(view, ctx);
    };
    const { controller } = harness([agent]);
    await controller.start({ content: 'P' });
    await controller.runRound();
    expect(seen).toEqual([['t1', 't2']]);
    expect(triggerCtx.map((c) => c.targetIds)).toEqual([[]]);
  });

  describe('per-call reservation (docs/budget-guardrails.md §2)', () => {
    it('warns when a model reports far more prompt tokens than were estimated', async () => {
      const warned: { message: string; fields: Record<string, unknown> | undefined }[] = [];
      const logger: Logger = {
        ...nullLogger,
        warn: (message, fields) => {
          warned.push({ message, fields });
        },
      };
      // Against the gateway agent's estimate, 1.2× is within 20 %, while an uncached
      // prompt plus as many cache-read tokens again (2×) is not.
      const estimated = estimateInputTokens(
        { system: 'sys', prompt: 'ask', schema: EmptyOutputSchema },
        DEFAULT_CHARS_PER_TOKEN,
      );
      const model = createFakeModel({
        script: [
          {
            object: { contributions: [] },
            usage: { inputTokens: Math.floor(estimated * 1.2), outputTokens: 1 },
          },
          {
            object: { contributions: [] },
            usage: { inputTokens: estimated, outputTokens: 1, cacheReadTokens: estimated },
          },
        ],
      });
      const { controller } = harness([gatewayAgent('a', model, 90)], { logger });
      await controller.start({ content: 'P' }, { parallelism: 1 });
      await controller.runRound();
      const undershoot = () =>
        warned.filter((w) => w.message === 'input token estimate undershot by more than 20%');
      expect(undershoot()).toEqual([]);
      await controller.runRound();
      expect(undershoot().map((w) => w.fields)).toEqual([
        {
          runId: controller.runId,
          round: 2,
          agentId: 'a',
          modelId: 'fake',
          estimated,
          actual: estimated * 2,
        },
      ]);
    });

    it('shrinks the output allowance to fit, then skips calls below the floor and stops', async () => {
      const { controller, models, events } = scripted();
      await controller.start({ content: 'P' }, { maxCostUsd: 0.004 });

      const first = await controller.runRound();
      expect(first.ok && first.value.failures).toEqual([]);
      const plannerCall = models.planner.calls[0];
      expect(plannerCall).toBeDefined();
      if (plannerCall === undefined) return;
      const expected = fitCall({
        pricing: SCENARIO_PRICING,
        inputTokens: estimateInputTokens(plannerCall.request, models.planner.charsPerToken),
        maxOutputTokens: 4096,
        remainingUsd: 0.004,
      });
      expect(expected).toMatchObject({ fits: true, shrunk: true });
      expect(plannerCall.request.maxOutputTokens).toBe(expected.fits && expected.maxOutputTokens);
      expect(plannerCall.request.maxOutputTokens).toBeLessThan(4096);

      // $0.0013 is left: not even a 256-token answer fits, so nobody runs and the run ends.
      const second = await controller.runRound();
      expect(second.ok && second.value.failures.map((f) => [f.agentId, f.reason])).toEqual([
        ['solver', 'budget_exhausted'],
        ['researcher', 'budget_exhausted'],
      ]);
      expect(second.ok && second.value.failures[0]?.detail).toContain('budget exhausted');
      expect(second.ok && second.value.ended).toEqual({
        status: 'completed',
        reason: 'budget_cost',
      });
      expect(models.solver.calls.length).toBe(0);
      expect(models.researcher.calls.length).toBe(0);
      expect(ofType(events, 'run_terminated')[0]?.totals.usage.costUsd).toBeCloseTo(
        SCENARIO_CALL_COST_USD,
        10,
      );
    });

    it('lets two parallel agents reserve only what the cap can cover', async () => {
      const model = createFakeModel({
        pricing: SCENARIO_PRICING,
        script: () => ({
          object: { contributions: [] },
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      });
      const { controller } = harness([gatewayAgent('a', model, 90), gatewayAgent('b', model, 80)]);
      // The first agent's call is shrunk to what $0.004 can pay for after its prompt, and
      // that reservation leaves nothing useful for the second.
      const expected = fitCall({
        pricing: SCENARIO_PRICING,
        inputTokens: estimateInputTokens(
          { system: 'sys', prompt: 'ask', schema: EmptyOutputSchema },
          model.charsPerToken,
        ),
        maxOutputTokens: 4096,
        remainingUsd: 0.004,
      });
      expect(expected).toMatchObject({ fits: true, shrunk: true });
      await controller.start({ content: 'P' }, { maxCostUsd: 0.004, parallelism: 2 });
      const report = await controller.runRound();
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(model.calls.length).toBe(1);
      expect(model.calls[0]?.request.maxOutputTokens).toBe(
        expected.fits && expected.maxOutputTokens,
      );
      expect(report.value.failures).toEqual([
        {
          agentId: 'b',
          reason: 'budget_exhausted',
          detail: expect.stringContaining('$0.0000 left') as string,
        },
      ]);
      expect(report.value.usage.costUsd).toBeCloseTo(0.0001 + 0.00025, 10);
      expect(report.value.ended).toBeNull();
    });

    it('records tokens but no money for free models and never shrinks their calls', async () => {
      const free: ScenarioPricing = {
        planner: null,
        researcher: null,
        solver: null,
        critic: null,
        synthesizer: null,
      };
      const { controller, models } = scripted({}, free);
      await controller.start({ content: 'P' }, { maxCostUsd: 0.0001 });
      const result = await controller.run();
      expect(result.ok && result.value.reason).toBe('completed');
      expect(result.ok && result.value.totals.usage.costUsd).toBe(0);
      expect(result.ok && result.value.totals.usage.inputTokens).toBe(1200 * 7);
      for (const model of Object.values(models)) {
        for (const call of model.calls) expect(call.request.maxOutputTokens).toBe(4096);
      }
    });

    it('settles the tokens of an invalid answer and attributes every call to the entry', async () => {
      const bad: FakeResponse = {
        object: {
          contributions: [
            { type: 'subproblem', content: 'x', parents: [], payload: { status: 'later' } },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
      const model = createFakeModel({
        pricing: SCENARIO_PRICING,
        script: (_request, index) =>
          index === 0
            ? bad
            : {
                object: {
                  contributions: [
                    {
                      type: 'subproblem',
                      content: 'A',
                      parents: ['P1'],
                      payload: { status: 'open' },
                    },
                  ],
                },
                usage: { inputTokens: 300, outputTokens: 60 },
              },
      });
      const { controller } = harness([
        createRoleAgent(planner, { model }, testRolePrompts().planner),
      ]);
      await controller.start({ content: 'P' });
      const report = await controller.runRound();
      expect(report.ok && report.value.failures).toEqual([]);
      expect(report.ok && report.value.committed[0]?.usage).toEqual({
        inputTokens: 400,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: expect.closeTo((400 * 1 + 80 * 5) / 1e6, 12) as number,
      });
      expect(report.ok && report.value.usage.inputTokens).toBe(400);
    });
  });

  describe('monthly budget (docs/budget-guardrails.md §3)', () => {
    it('refuses to start a run whose cap would overrun the month, and says what would fit', async () => {
      const ledger = new FakeSpendLedger(4.9);
      const { controller, events } = harness([], { periodBudget: monthly(ledger) });
      const refused = await controller.start({ content: 'P' });
      expect(!refused.ok && refused.error).toEqual({
        kind: 'monthly_budget',
        spentUsd: 4.9,
        limitUsd: 5,
        requestedCapUsd: 0.25,
        fitsCapUsd: expect.closeTo(0.1, 10) as number,
      });
      expect(events).toEqual([]);
      expect(ledger.periods).toEqual([
        { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
      ]);
      const accepted = await controller.start({ content: 'P' }, { maxCostUsd: 0.1 });
      expect(accepted.ok).toBe(true);
    });

    it('re-reads the ledger every round and pauses once the month is spent', async () => {
      const ledger = new FakeSpendLedger(1);
      const { controller, events } = scripted({
        periodBudget: monthly(ledger),
        onEvent: (event) => {
          if (event.type === 'round_completed') ledger.spent = 5;
        },
      });
      await controller.start({ content: 'P' });
      const result = await controller.run();
      expect(result.ok && result.value).toMatchObject({
        status: 'paused',
        reason: 'monthly_budget',
        rounds: 1,
      });
      expect(events.at(-1)?.type).toBe('run_paused');
      // start + round 1 + round 2 pre-check
      expect(ledger.periods.length).toBe(3);
      const again = await controller.runRound();
      expect(!again.ok && again.error).toEqual({ kind: 'paused', reason: 'monthly_budget' });
    });

    it('emits budget_warning once when spend crosses the warning fraction', async () => {
      const ledger = new FakeSpendLedger(3.9);
      const { controller, events } = scripted({
        periodBudget: monthly(ledger),
        onEvent: (event) => {
          if (event.type === 'round_completed') ledger.spent = 4;
        },
      });
      await controller.start({ content: 'P' });
      const result = await controller.run();
      expect(result.ok && result.value.reason).toBe('completed');
      const warnings = ofType(events, 'budget_warning');
      expect(warnings.map((w) => [w.round, w.spentUsd, w.limitUsd])).toEqual([[1, 4, 5]]);
    });

    it('fails closed when the ledger cannot be read or the zone is unknown', async () => {
      const broken: PeriodBudget = {
        ...monthly(new FakeSpendLedger()),
        ledger: { spentUsd: () => Promise.reject(new Error('disk on fire')) },
      };
      const unreadable = await harness([], { periodBudget: broken }).controller.start({
        content: 'P',
      });
      expect(!unreadable.ok && unreadable.error).toEqual({
        kind: 'ledger',
        message: 'disk on fire',
      });

      const badZone = await harness([], {
        periodBudget: { ...monthly(new FakeSpendLedger()), timeZone: 'Mars/Olympus_Mons' },
      }).controller.start({ content: 'P' });
      expect(!badZone.ok && badZone.error.kind).toBe('invalid_config');
    });
  });

  describe('provider errors (docs/budget-guardrails.md §4)', () => {
    it.each([
      ['billing', { kind: 'billing', message: 'credit balance too low' }],
      ['auth', { kind: 'auth', message: 'invalid x-api-key' }],
    ] as const)(
      'fails the run on a %s error after committing what others produced',
      async (reason, error) => {
        const problemId = () => events.find((e) => e.type === 'entry_committed')?.entry.id ?? '';
        const { controller, events } = harness([
          stubAgent('paid', { priority: 90, act: () => modelError(error) }),
          stubAgent('local', {
            priority: 80,
            act: () => [
              { type: 'question', content: 'Still here', parents: [problemId()], payload: {} },
            ],
          }),
        ]);
        await controller.start({ content: 'P' }, { parallelism: 2 });
        const result = await controller.run();
        expect(result.ok && result.value).toMatchObject({ status: 'failed', reason, rounds: 1 });
        expect(result.ok && result.value.view.liveOfType('question').length).toBe(1);
        expect(ofType(events, 'agent_failed').map((e) => [e.agentId, e.reason])).toEqual([
          ['paid', reason],
        ]);
        expect(ofType(events, 'run_terminated')[0]?.status).toBe('failed');
      },
    );

    it.each([
      ['rate_limit', 'rate_limit', { kind: 'rate_limit', message: '429', attempts: 3 }],
      ['overloaded', 'rate_limit', { kind: 'overloaded', message: '529', attempts: 3 }],
      [
        'network',
        'provider_unreachable',
        { kind: 'network', message: 'ECONNREFUSED', attempts: 3 },
      ],
    ] as const)('pauses the run on a %s error with reason %s', async (_kind, reason, error) => {
      const { controller, events } = harness([
        stubAgent('flaky', { priority: 90, act: () => modelError(error) }),
      ]);
      await controller.start({ content: 'P' });
      const result = await controller.run();
      expect(result.ok && result.value).toMatchObject({ status: 'paused', reason, rounds: 1 });
      expect(ofType(events, 'run_paused').map((e) => e.reason)).toEqual([reason]);
      const again = await controller.runRound();
      expect(!again.ok && again.error).toEqual({ kind: 'paused', reason });
    });

    it('treats invalid_request as a per-agent failure and keeps going', async () => {
      const { controller } = harness([
        stubAgent('picky', {
          priority: 90,
          act: () => modelError({ kind: 'invalid_request', message: 'max_tokens too large' }),
        }),
      ]);
      await controller.start({ content: 'P' }, { maxRounds: 2 });
      const result = await controller.run();
      expect(result.ok && result.value).toMatchObject({
        status: 'completed',
        reason: 'budget_rounds',
        rounds: 2,
      });
    });
  });

  it('records agent failures and keeps going', async () => {
    const problemId = () => events.find((e) => e.type === 'entry_committed')?.entry.id ?? '';
    const { controller, events } = harness([
      stubAgent('broken', {
        priority: 90,
        act: () =>
          modelError({
            kind: 'invalid_output',
            issues: ['confidence: too big'],
            raw: '{}',
            usage: zeroUsage(),
          }),
      }),
      stubAgent('half-right', {
        priority: 80,
        act: () => [
          { type: 'question', content: 'Fine', parents: [problemId()], payload: {} },
          {
            type: 'question',
            content: 'Dangling',
            parents: ['00000000-0000-7000-8000-0000000000ff'],
            payload: {},
          },
        ],
      }),
    ]);
    await controller.start({ content: 'P' }, { parallelism: 2 });
    const report = await controller.runRound();
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.committed.map((e) => e.content)).toEqual(['Fine']);
    expect(report.value.failures.map((f) => [f.agentId, f.reason])).toEqual([
      ['broken', 'invalid_output'],
      ['half-right', 'invalid_links'],
    ]);
    expect(report.value.failures[0]?.detail).toContain('confidence: too big');
    expect(ofType(events, 'agent_failed').length).toBe(2);
    expect(report.value.ended).toBeNull();
    expect(report.value.usage).toEqual(zeroUsage());
  });

  it('turns a throwing agent into an exception failure', async () => {
    const thrower: Agent = {
      ...stubAgent('thrower', { priority: 50 }),
      act: () => Promise.reject(new Error('kaboom')),
    };
    const { controller } = harness([thrower]);
    await controller.start({ content: 'P' });
    const report = await controller.runRound();
    expect(report.ok && report.value.failures).toEqual([
      { agentId: 'thrower', reason: 'exception', detail: 'kaboom' },
    ]);
  });

  it('stops immediately when no agent is eligible', async () => {
    const { controller, events } = harness([stubAgent('idle', { priority: null })]);
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('no_eligible_agents');
    expect(result.ok && result.value.rounds).toBe(1);
    expect(events.map((e) => e.type).slice(2)).toEqual([
      'round_started',
      'agents_selected',
      'round_completed',
      'run_terminated',
    ]);
  });

  it('allows one reframe after a stall, then stops', async () => {
    const seen: boolean[] = [];
    const { controller } = harness([
      stubAgent('quiet', { priority: 50, onCtx: (ctx) => seen.push(ctx.flags.stallDetected) }),
    ]);
    await controller.start({ content: 'P' }, { stallRounds: 2 });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('stalled');
    expect(result.ok && result.value.rounds).toBe(4);
    expect(seen).toEqual([false, false, true, false]);
  });

  it('forces the critic on a conflict, then requires a decision, then releases the synthesizer', async () => {
    const flagsSeen: AgentContext['flags'][] = [];
    const liveHypotheses = () => controller.currentView().liveOfType('hypothesis');
    const { controller } = harness([
      stubAgent('proposer', {
        priority: 90,
        act: (ctx) => {
          const [first] = liveHypotheses();
          if (ctx.round === 1) {
            return [
              {
                type: 'hypothesis',
                content: 'A',
                parents: [],
                payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
              },
            ];
          }
          if (ctx.round === 2 && first !== undefined) {
            return [
              {
                type: 'hypothesis',
                content: 'B',
                parents: [],
                payload: { confidence: 0.5, supportedBy: [], contradictedBy: [first.id] },
              },
            ];
          }
          return [];
        },
      }),
      stubAgent('observer', {
        priority: 80,
        onCtx: (ctx) => flagsSeen.push(ctx.flags),
        act: (ctx) => {
          const [a, b] = liveHypotheses();
          if (ctx.round === 3 && a !== undefined) {
            return [
              {
                type: 'critique',
                content: 'C',
                parents: [a.id],
                payload: { target: a.id, severity: 'major' },
              },
            ];
          }
          if (ctx.round === 4 && a !== undefined && b !== undefined) {
            return [
              {
                type: 'decision',
                content: 'D',
                parents: [a.id, b.id],
                payload: { chosen: b.id, rejected: [a.id], rationale: 'r' },
              },
            ];
          }
          return [];
        },
      }),
    ]);
    await controller.start({ content: 'P' }, { parallelism: 2, maxRounds: 5 });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('budget_rounds');
    expect(flagsSeen.map((f) => [f.criticForced, f.decisionRequired])).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(controller.flags).toEqual({
      stallDetected: false,
      criticForced: false,
      decisionRequired: false,
      synthesisForced: false,
    });
  });

  it('holds a confident synthesis back while a contradiction is undecided, then completes on the decision', async () => {
    const infos: string[] = [];
    const logger: Logger = {
      ...nullLogger,
      info: (message) => {
        infos.push(message);
      },
    };
    const liveHypotheses = () => controller.currentView().liveOfType('hypothesis');
    // One agent plays every part, a round at a time: A; B contradicting A; a critique of A
    // (the conflict is now "critiqued", so a decision is required; a minor one, which does
    // not hold a run by itself); a confident synthesis that must not end the run; the
    // decision that lets it.
    const { controller } = harness(
      [
        stubAgent('all', {
          priority: 90,
          act: (ctx) => {
            const [a, b] = liveHypotheses();
            switch (ctx.round) {
              case 1:
                return [
                  {
                    type: 'hypothesis',
                    content: 'A',
                    parents: [],
                    payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
                  },
                ];
              case 2:
                return a === undefined
                  ? []
                  : [
                      {
                        type: 'hypothesis',
                        content: 'B',
                        parents: [],
                        payload: { confidence: 0.6, supportedBy: [], contradictedBy: [a.id] },
                      },
                    ];
              case 3:
                return a === undefined
                  ? []
                  : [
                      {
                        type: 'critique',
                        content: 'C',
                        parents: [a.id],
                        payload: { target: a.id, severity: 'minor' },
                      },
                    ];
              case 4:
                return b === undefined
                  ? []
                  : [
                      {
                        type: 'synthesis',
                        content: 'S',
                        parents: [b.id],
                        payload: { version: 1, confidence: 0.95, cites: [b.id] },
                      },
                    ];
              case 5:
                return a === undefined || b === undefined
                  ? []
                  : [
                      {
                        type: 'decision',
                        content: 'D',
                        parents: [a.id, b.id],
                        payload: { chosen: b.id, rejected: [a.id], rationale: 'r' },
                      },
                    ];
              default:
                return [];
            }
          },
        }),
      ],
      { logger },
    );
    await controller.start({ content: 'P' }, { maxRounds: 8 });
    const result = await controller.run();
    expect(result.ok && [result.value.reason, result.value.rounds]).toEqual(['completed', 5]);
    expect(infos.filter((m) => m.startsWith('synthesis held back')).length).toBe(1);
  });

  it('propagates store failures as controller errors', async () => {
    const failing = {
      append: () => Promise.resolve(err({ kind: 'unavailable' as const, message: 'disk full' })),
      eventsFor: () => Promise.resolve([]),
    };
    const { controller } = harness([], { store: failing });
    const started = await controller.start({ content: 'P' });
    expect(!started.ok && started.error).toEqual({
      kind: 'store',
      error: { kind: 'unavailable', message: 'disk full' },
    });
  });
});

describe('createController: exhausted scripts', () => {
  it('reports an exhausted script as an agent failure and keeps the run alive', async () => {
    const { controller } = harness([
      createRoleAgent(
        planner,
        { model: createFakeModel({ script: [] }) },
        testRolePrompts().planner,
      ),
    ]);
    await controller.start({ content: 'P' });
    const report = await controller.runRound();
    expect(report.ok && report.value.failures).toEqual([
      { agentId: 'planner', reason: 'script_exhausted', detail: 'script exhausted after 0 calls' },
    ]);
    expect(report.ok && report.value.ended).toBeNull();
  });
});

describe('a reply over the role’s limit', () => {
  it('commits the Critic’s six most severe critiques and notes the rest on the log', async () => {
    // The scripted swarm, with a Critic that writes eight critiques of the live hypothesis.
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const scriptedModels = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      return ref.controller.currentView();
    });
    const verbose = createFakeModel({
      id: 'fake-verbose-critic',
      script: () => {
        const view = ref.controller?.currentView();
        const target = view?.liveOfType('hypothesis')[0];
        const handle = target === undefined ? undefined : view?.handleOf(target.id);
        if (handle === undefined) return { object: { contributions: [] } };
        const severities = [
          'minor',
          'major',
          'minor',
          'blocking',
          'major',
          'minor',
          'major',
          'minor',
        ];
        return {
          object: {
            contributions: severities.map((severity, i) => ({
              type: 'critique',
              content: `${severity} flaw ${String(i + 1)}`,
              parents: [handle],
              payload: { target: handle, severity },
            })),
          },
          usage: SCENARIO_TOKENS,
        };
      },
    });
    const h = harness(
      createDefaultAgents({ ...scriptedModels, critic: verbose }, testRolePrompts()),
    );
    ref.controller = h.controller;
    await h.controller.start({ content: 'P' }, { maxRounds: 3 });
    const result = await h.controller.run();
    expect(result.ok).toBe(true);

    // Round 3 is the Critic's first: one call, six critiques on the board, most severe first.
    expect(verbose.calls.map((c) => c.outcome)).toEqual(['ok']);
    const critiques = ofType(h.events, 'entry_committed')
      .map((e) => e.entry)
      .filter((entry) => entry.type === 'critique');
    expect(critiques.map((c) => c.content)).toEqual([
      'blocking flaw 4',
      'major flaw 2',
      'major flaw 5',
      'major flaw 7',
      'minor flaw 1',
      'minor flaw 3',
    ]);
    expect(ofType(h.events, 'agent_failed')).toEqual([
      expect.objectContaining({
        round: 3,
        agentId: 'critic',
        reason: 'over_limit',
        detail: 'kept 6 of 8 contributions, the most severe first; 2 dropped',
      }),
    ]);
    // The note follows the entries it is about, inside the round.
    const types = h.events.filter((e) => e.type === 'agent_failed' || e.type === 'round_completed');
    expect(types.map((e) => [e.type, 'round' in e ? e.round : null]).slice(-2)).toEqual([
      ['agent_failed', 3],
      ['round_completed', 3],
    ]);
    // It is not a failure that ends or pauses anything.
    expect(result.ok && result.value.reason).toBe('budget_rounds');
  });
});

describe('a run with nothing left to change', () => {
  it('stops rewriting its synthesis, ends, and is written up', async () => {
    // A Synthesizer that never clears the threshold and never supersedes its own draft: the
    // shape that kept one paid run rewriting an unchanged board for five rounds.
    const cautious = createFakeModel({
      id: 'fake-cautious-synthesizer',
      script: (request) =>
        request.tags.role === WRITE_UP_ROLE
          ? { object: { paragraphs: ['The answer.'], confidence: 0.4, cites: ['H2'] } }
          : {
              object: {
                contributions: [
                  {
                    type: 'synthesis',
                    content: ['A cautious draft.'],
                    parents: [],
                    payload: { version: 1, confidence: 0.4, cites: [] },
                  },
                ],
              },
            },
    });
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const models = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      return ref.controller.currentView();
    });
    const h = harness(
      createDefaultAgents({ ...models, synthesizer: cautious }, testRolePrompts()),
      {
        writeUp: { model: cautious, prompt: testWriteUpPrompt() },
      },
    );
    ref.controller = h.controller;
    await h.controller.start({ content: 'P' });
    const result = await h.controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Round 4 drafts; round 5 drafts once more, because the Critic posted beside it in
    // round 4; then nothing has changed and nobody else has anything to do.
    expect(ofType(h.events, 'agents_selected').map((e) => e.selected)).toEqual([
      ['planner'],
      ['solver', 'researcher'],
      ['critic', 'solver'],
      ['critic', 'synthesizer'],
      ['synthesizer'],
      [],
    ]);
    expect([result.value.reason, result.value.rounds]).toEqual(['no_eligible_agents', 6]);
    expect(ofType(h.events, 'agents_selected').at(-1)?.eligible).toEqual([]);
    // Two drafts, not eight, and the final write-up after them.
    const syntheses = result.value.view.entries.filter((e) => e.type === 'synthesis');
    expect(syntheses.map((s) => [s.round, s.payload.stage])).toEqual([
      [4, 'draft'],
      [5, 'draft'],
      [6, 'final'],
    ]);
    expect(ofType(h.events, 'write_up_started')[0]).toMatchObject({
      round: 6,
      reason: 'no_eligible_agents',
    });
    expect(h.events.at(-1)?.type).toBe('run_terminated');
  });
});

describe('a contradiction between hypotheses, from evidence to decision', () => {
  it('forces the Critic onto the pair, then has the Synthesizer decide, and the run completes', async () => {
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const board = () => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      return ref.controller.currentView();
    };
    const handles = (type: 'hypothesis' | 'subproblem' | 'synthesis' | 'evidence') => {
      const view = board();
      return view.liveOfType(type).map((entry) => view.handleOf(entry.id) ?? '?');
    };
    const none: FakeResponse = { object: { contributions: [] } };
    const models = {
      planner: createFakeModel({
        script: () => ({
          object: {
            contributions: ['Is the left road the way?', 'Is the right road the way?'].map(
              (content) => ({
                type: 'subproblem',
                content,
                parents: ['P1'],
                payload: { status: 'open' },
              }),
            ),
          },
        }),
      }),
      // One answer to each subproblem, which cannot both hold; then nothing more.
      solver: createFakeModel({
        script: () =>
          handles('hypothesis').length > 0
            ? none
            : {
                object: {
                  contributions: ['Go left.', 'Go right.'].map((content, index) => ({
                    type: 'hypothesis',
                    answers: handles('subproblem')[index],
                    content,
                    parents: [],
                    payload: { confidence: 0.6, supportedBy: [], contradictedBy: [] },
                  })),
                },
              },
      }),
      // Evidence that supports the first and contradicts the second: the contradiction.
      researcher: createFakeModel({
        script: () => {
          const [left, right] = handles('hypothesis');
          return left === undefined || right === undefined || handles('evidence').length > 0
            ? none
            : {
                object: {
                  contributions: [
                    {
                      type: 'evidence',
                      content: 'The left road is open; the right one is closed.',
                      parents: [left],
                      payload: { source: 'survey', supports: [left], contradicts: [right] },
                    },
                  ],
                },
              };
        },
      }),
      // Speaks only when forced, and then about the hypothesis the evidence contradicts.
      critic: createFakeModel({
        script: (request) => {
          const right = handles('hypothesis')[1];
          return !request.prompt.includes('criticForced') || right === undefined
            ? none
            : {
                object: {
                  contributions: [
                    {
                      type: 'critique',
                      content: 'The right road is closed, so this cannot be the way.',
                      parents: [right],
                      payload: { target: right, severity: 'major' },
                    },
                  ],
                },
              };
        },
      }),
      // A hesitant draft, until it is asked to decide.
      synthesizer: createFakeModel({
        script: (request) => {
          const [left, right] = handles('hypothesis');
          const [draft] = handles('synthesis');
          const synthesis = (confidence: number) => ({
            type: 'synthesis',
            content: [confidence > 0.8 ? 'Go left.' : 'Left or right, undecided.'],
            parents: left === undefined ? [] : [left],
            ...(draft === undefined ? {} : { supersedes: draft }),
            payload: {
              version: draft === undefined ? 1 : 2,
              confidence,
              cites: left === undefined ? [] : [left],
            },
          });
          if (
            !request.prompt.includes('decisionRequired') ||
            left === undefined ||
            right === undefined
          ) {
            return { object: { contributions: [synthesis(0.4)] } };
          }
          return {
            object: {
              contributions: [
                {
                  type: 'decision',
                  content: 'Left over right.',
                  parents: [left, right],
                  payload: {
                    chosen: left,
                    rejected: [right],
                    rationale: 'The right road is closed.',
                  },
                },
                synthesis(0.9),
              ],
            },
          };
        },
      }),
    };
    const h = harness(createDefaultAgents(models, testRolePrompts()));
    ref.controller = h.controller;
    await h.controller.start({ content: 'Which road?' });
    const result = await h.controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([result.value.reason, result.value.rounds]).toEqual(['completed', 5]);
    const selections = ofType(h.events, 'agents_selected');
    expect(selections.map((e) => e.selected)).toEqual([
      ['planner'],
      ['solver', 'researcher'],
      ['critic', 'researcher'],
      // The evidence of round 3 set the two against each other: the Critic is certain to run.
      ['critic', 'synthesizer'],
      // The Critic has spoken: a decision is owed, and the Synthesizer outranks everyone.
      ['synthesizer', 'solver'],
    ]);
    expect(selections[3]?.eligible.find((e) => e.agentId === 'critic')).toMatchObject({
      agentId: 'critic',
      priority: 100,
      reason: 'forced: live hypotheses contradict each other',
    });
    expect(selections[4]?.eligible.find((e) => e.agentId === 'synthesizer')).toMatchObject({
      agentId: 'synthesizer',
      priority: 90,
      reason: 'contradicting hypotheses critiqued: decide, then synthesise',
    });

    // Both were told which hypotheses contradict, and why.
    const named = '- H1 and H2 contradict each other (E1 supports one and contradicts the other)';
    expect(models.critic.calls.at(-1)?.request.prompt).toContain(named);
    expect(models.synthesizer.calls.at(-1)?.request.prompt).toContain(named);
    expect(models.synthesizer.calls.at(-1)?.request.prompt).toContain('# Your targets\nH1, H2');

    // The decision is on the board before the synthesis it came with, and it settles things.
    const view = result.value.view;
    const [left, right] = view.entries.filter((e) => e.type === 'hypothesis');
    const committed = ofType(h.events, 'entry_committed').filter((e) => e.round === 5);
    expect(committed.map((e) => e.entry.type)).toEqual(['decision', 'synthesis']);
    expect(view.liveOfType('decision')[0]?.payload).toMatchObject({
      chosen: left?.id,
      rejected: [right?.id],
    });
    expect(h.controller.flags).toMatchObject({ criticForced: false, decisionRequired: false });
    expect(synthesisCandidates(view).map((c) => c.id)).toEqual([left?.id]);
    // The rejected hypothesis is not sent back to the Solver, critique or no critique.
    expect(contestedHypotheses(view)).toEqual([]);
    expect(latestSynthesis(view)).toMatchObject({ content: 'Go left.', payload: { version: 2 } });
  });
});

describe('one answer per subproblem, and a declared rival decided', () => {
  it('drops an undeclared second answer, takes a declared rival to the Critic and the decision, and completes', async () => {
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const handles = (type: 'hypothesis' | 'subproblem' | 'synthesis' | 'critique') => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      const view = ref.controller.currentView();
      return view.liveOfType(type).map((entry) => view.handleOf(entry.id) ?? '?');
    };
    const none: FakeResponse = { object: { contributions: [] } };
    const answer = (content: string, extra: object = {}) => ({
      type: 'hypothesis',
      answers: handles('subproblem')[0],
      content,
      parents: [],
      payload: { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      ...extra,
    });
    const models = {
      planner: createFakeModel({
        script: () => ({
          object: {
            contributions: [
              {
                type: 'subproblem',
                content: 'Which way?',
                parents: ['P1'],
                payload: { status: 'open' },
              },
            ],
          },
        }),
      }),
      // First two answers at once, neither related to the other; later, sent back to the
      // first, it posts the second again, this time as a rival; then nothing more.
      solver: createFakeModel({
        script: () => {
          const count = handles('hypothesis').length;
          if (count === 0) {
            return { object: { contributions: [answer('Go left.'), answer('Go right.')] } };
          }
          return count === 1
            ? { object: { contributions: [answer('Go right.', { relation: 'rival' })] } }
            : none;
        },
      }),
      researcher: createFakeModel({ script: () => none }),
      // A major objection to the first answer; and, when forced onto the rivals, a minor one
      // to the second: nothing that would hold the run once the first answer is rejected.
      critic: createFakeModel({
        script: (request) => {
          const [left, right] = handles('hypothesis');
          const critique = (target: string, content: string, severity: string) => ({
            object: {
              contributions: [
                {
                  type: 'critique',
                  content,
                  parents: [target],
                  payload: { target, severity },
                },
              ],
            },
          });
          if (request.prompt.includes('criticForced') && right !== undefined) {
            return critique(right, 'The right road is the longer one.', 'minor');
          }
          return left !== undefined && handles('critique').length === 0
            ? critique(left, 'The left road is closed.', 'major')
            : none;
        },
      }),
      synthesizer: createFakeModel({
        script: (request) => {
          const [left, right] = handles('hypothesis');
          const [draft] = handles('synthesis');
          const synthesis = (confidence: number) => ({
            type: 'synthesis',
            content: [confidence > 0.8 ? 'Go right.' : 'Left or right, undecided.'],
            parents: left === undefined ? [] : [left],
            ...(draft === undefined ? {} : { supersedes: draft }),
            payload: {
              version: draft === undefined ? 1 : 2,
              confidence,
              cites: left === undefined ? [] : [left],
            },
          });
          if (
            !request.prompt.includes('decisionRequired') ||
            left === undefined ||
            right === undefined
          ) {
            return { object: { contributions: [synthesis(0.4)] } };
          }
          return {
            object: {
              contributions: [
                {
                  type: 'decision',
                  content: 'Right over left.',
                  parents: [left, right],
                  payload: {
                    chosen: right,
                    rejected: [left],
                    rationale: 'The left road is closed.',
                  },
                },
                synthesis(0.9),
              ],
            },
          };
        },
      }),
    };
    const h = harness(createDefaultAgents(models, testRolePrompts()));
    ref.controller = h.controller;
    await h.controller.start({ content: 'Which road?' });
    const result = await h.controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reason).toBe('completed');

    const view = result.value.view;
    const [subproblem] = view.liveOfType('subproblem');
    const [left, right, ...more] = view.entries.filter((e) => e.type === 'hypothesis');
    if (subproblem === undefined || left === undefined || right === undefined) {
      throw new Error('entries missing');
    }
    // The second of the two first answers never reached the board, and the log says so.
    expect(more).toEqual([]);
    expect(left.round).toBe(2);
    expect(ofType(h.events, 'agent_failed').find((e) => e.round === 2)).toMatchObject({
      agentId: 'solver',
      reason: 'over_limit',
      detail:
        '1 hypothesis dropped: a subproblem takes one answer, and this one neither replaced the standing one nor was declared a rival',
    });
    // The rival stands beside the first answer, superseding nothing, on the record as its rival.
    expect(right.supersedes).toBeUndefined();
    expect(right.payload).toMatchObject({ rivalOf: [left.id] });
    expect(right.parents).toEqual([subproblem.id]);

    // The declared rivalry forced the Critic onto the pair, by name.
    const forced = ofType(h.events, 'agents_selected').find((e) =>
      e.eligible.some((a) => a.agentId === 'critic' && a.reason.startsWith('forced')),
    );
    expect(forced?.selected).toContain('critic');
    expect(forced?.round).toBe(right.round + 1);
    const named = '- H1 and H2 contradict each other (rival answers to one subproblem)';
    expect(models.critic.calls.at(-1)?.request.prompt).toContain(named);
    expect(models.synthesizer.calls.at(-1)?.request.prompt).toContain(named);

    // The decision settles it: one answer stands for the subproblem. The major objection
    // to the rejected answer no longer holds the run, and the minor one to the answer that
    // was kept never did.
    expect(view.liveOfType('decision')[0]?.payload).toMatchObject({
      chosen: right.id,
      rejected: [left.id],
    });
    expect(standingAnswers(view, subproblem).map((answerEntry) => answerEntry.id)).toEqual([
      right.id,
    ]);
    expect(view.liveOfType('critique').map((c) => c.payload.severity)).toEqual(['major', 'minor']);
    expect(h.controller.flags).toMatchObject({ criticForced: false, decisionRequired: false });
  });
});

describe('a confident synthesis written beside critiques it never saw', () => {
  it('does not end the run: the Solver answers, the Critic reviews, and a later synthesis does', async () => {
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const handles = (type: 'hypothesis' | 'subproblem' | 'synthesis' | 'critique') => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      const view = ref.controller.currentView();
      return view.liveOfType(type).map((entry) => view.handleOf(entry.id) ?? '?');
    };
    const none: FakeResponse = { object: { contributions: [] } };
    const models = {
      planner: createFakeModel({
        script: () => ({
          object: {
            contributions: [
              { type: 'subproblem', content: 'How?', parents: ['P1'], payload: { status: 'open' } },
            ],
          },
        }),
      }),
      // A first answer; then, sent back to it by the critique, a new version that answers it.
      solver: createFakeModel({
        script: () => {
          const [subproblem] = handles('subproblem');
          const [standing] = handles('hypothesis');
          const [critique] = handles('critique');
          if (standing === undefined) {
            return {
              object: {
                contributions: [
                  {
                    type: 'hypothesis',
                    answers: subproblem,
                    content: 'Like this.',
                    parents: [],
                    payload: { confidence: 0.7, supportedBy: [], contradictedBy: [] },
                  },
                ],
              },
            };
          }
          return critique === undefined || handles('hypothesis').length !== 1 || standing !== 'H1'
            ? none
            : {
                object: {
                  contributions: [
                    {
                      type: 'hypothesis',
                      answers: subproblem,
                      relation: `new version of ${standing}`,
                      content: 'Like this, with a rollback.',
                      parents: [],
                      payload: {
                        confidence: 0.8,
                        supportedBy: [],
                        contradictedBy: [],
                        resolves: [critique],
                      },
                    },
                  ],
                },
              };
        },
      }),
      researcher: createFakeModel({ script: () => none }),
      // One major objection to the first version; nothing to raise against the second.
      critic: createFakeModel({
        script: () => {
          const [standing] = handles('hypothesis');
          return standing !== 'H1' || handles('critique').length > 0
            ? none
            : {
                object: {
                  contributions: [
                    {
                      type: 'critique',
                      content: 'There is no rollback.',
                      parents: [standing],
                      payload: { target: standing, severity: 'major' },
                    },
                  ],
                },
              };
        },
      }),
      // Always confident: it is the board, not the model's caution, that has to hold the run.
      synthesizer: createFakeModel({
        script: () => {
          const [standing] = handles('hypothesis');
          const [draft] = handles('synthesis');
          return {
            object: {
              contributions: [
                {
                  type: 'synthesis',
                  content: ['Do it like this.'],
                  parents: standing === undefined ? [] : [standing],
                  ...(draft === undefined ? {} : { supersedes: draft }),
                  payload: {
                    version: draft === undefined ? 1 : Number(draft.slice(1)) + 1,
                    confidence: 0.9,
                    cites: standing === undefined ? [] : [standing],
                  },
                },
              ],
            },
          };
        },
      }),
    };
    // No Researcher in this roster, so the Critic and the Synthesizer share a round, as
    // they did in the rehearsal run this is drawn from.
    const h = harness(
      createDefaultAgents(models, testRolePrompts()).filter((a) => a.role !== 'researcher'),
    );
    ref.controller = h.controller;
    await h.controller.start({ content: 'P' });
    const result = await h.controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const selections = ofType(h.events, 'agents_selected').map((e) => e.selected);
    expect(selections).toEqual([
      ['planner'],
      ['solver'],
      // The Critic objects (major) while the Synthesizer, beside it, writes at 0.9.
      ['critic', 'synthesizer'],
      // Not the end: a major critique is open and the synthesis never read it. The Solver
      // answers; the Synthesizer writes again, beside the new version this time.
      ['solver', 'synthesizer'],
      // The Critic reviews the new version and raises nothing. (The Synthesizer has run two
      // rounds in a row and sits this one out.)
      ['critic'],
      // The first synthesis written after everything landed and was reviewed ends the run.
      ['synthesizer'],
    ]);
    expect([result.value.reason, result.value.rounds]).toEqual(['completed', 6]);

    const view = result.value.view;
    const [critique] = view.liveOfType('critique');
    const [standing] = view.liveOfType('hypothesis');
    expect(critique === undefined ? undefined : view.resolutionOf(critique.id)?.id).toBe(
      standing?.id,
    );
    expect(view.callsOf('critic')).toEqual([
      { round: 3, targetIds: [view.byHandle('H1')?.id] },
      { round: 5, targetIds: [standing?.id] },
    ]);
    // What each selected agent was pointed at is on the log.
    const review = ofType(h.events, 'agents_selected').find((e) => e.round === 5);
    expect(review?.eligible.find((e) => e.agentId === 'critic')).toMatchObject({
      reason: 'hypotheses not yet reviewed, or with new evidence',
      targetIds: [standing?.id],
    });
    // Three drafts, each at 0.9: only the third had read everything, and it ended the run.
    expect(
      ofType(h.events, 'entry_committed').filter((e) => e.entry.type === 'synthesis'),
    ).toHaveLength(3);
  });
});
