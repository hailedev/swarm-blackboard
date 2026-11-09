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
import { createDefaultAgents } from '../agents/roster';
import { InMemoryBoardStore } from '../board/in-memory-board-store';
import { createFakeModel, type FakeResponse } from '../model/fake-model';
import type { Model, ModelError } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import { nullLogger, type Logger } from '../ports/logger';
import type { PeriodBudget } from '../ports/spend-ledger';
import { zeroUsage } from '../schemas/common';
import type { Contribution } from '../schemas/contribution';
import type { BoardEvent } from '../schemas/event';
import type { RunProfile } from '../schemas/roster';
import { FakeSpendLedger } from '../testing/fake-spend-ledger';
import { ManualClock } from '../testing/manual-clock';
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
  outputSchema: {
    safeParse: () => ({ success: true, data: { contributions: [] } }),
  } as unknown as Agent['outputSchema'],
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
  outputSchema: EmptyOutputSchema,
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
  const h = harness(createDefaultAgents(models), overrides);
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
    expect(result.value.totals.entries).toBe(12);
    const calls = 7;
    expect(result.value.totals.usage).toEqual({
      inputTokens: SCENARIO_TOKENS.inputTokens * calls,
      outputTokens: SCENARIO_TOKENS.outputTokens * calls,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
    expect(view.liveOfType('subproblem').map((s) => s.payload.status)).toEqual(['done', 'done']);
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
    const h = harness(createDefaultAgents(models), {
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
      // The gateway agent's prompt estimates to 1002 tokens: 1200 is within 20 %, while
      // 1000 uncached plus 1000 cache-read tokens is a 2000-token prompt and is not.
      const model = createFakeModel({
        script: [
          { object: { contributions: [] }, usage: { inputTokens: 1200, outputTokens: 1 } },
          {
            object: { contributions: [] },
            usage: { inputTokens: 1000, outputTokens: 1, cacheReadTokens: 1000 },
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
          estimated: 1002,
          actual: 2000,
        },
      ]);
    });

    it('shrinks the output allowance to fit, then skips calls below the floor and stops', async () => {
      const { controller, models, events } = scripted();
      await controller.start({ content: 'P' }, { maxCostUsd: 0.005 });

      const first = await controller.runRound();
      expect(first.ok && first.value.failures).toEqual([]);
      const plannerCall = models.planner.calls[0];
      expect(plannerCall).toBeDefined();
      if (plannerCall === undefined) return;
      const expected = fitCall({
        pricing: SCENARIO_PRICING,
        inputTokens: estimateInputTokens(plannerCall.request),
        maxOutputTokens: 4096,
        remainingUsd: 0.005,
      });
      expect(expected).toMatchObject({ fits: true, shrunk: true });
      expect(plannerCall.request.maxOutputTokens).toBe(expected.fits && expected.maxOutputTokens);
      expect(plannerCall.request.maxOutputTokens).toBeLessThan(4096);

      // $0.0023 is left: not even a 256-token answer fits, so nobody runs and the run ends.
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
      // Prompt estimate is 1002 tokens → $0.0012525 worst case before output. With $0.004 the
      // first agent gets 549 output tokens and leaves nothing useful for the second.
      await controller.start({ content: 'P' }, { maxCostUsd: 0.004, parallelism: 2 });
      const report = await controller.runRound();
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(model.calls.length).toBe(1);
      expect(model.calls[0]?.request.maxOutputTokens).toBe(549);
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
      const problemId = () => events.find((e) => e.type === 'entry_committed')?.entry.id ?? '';
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
                      parents: [problemId()],
                      payload: { status: 'open' },
                    },
                  ],
                },
                usage: { inputTokens: 300, outputTokens: 60 },
              },
      });
      const { controller, events } = harness([createRoleAgent(planner, { model })]);
      await controller.start({ content: 'P' });
      const report = await controller.runRound();
      expect(report.ok && report.value.failures).toEqual([]);
      expect(report.ok && report.value.committed[0]?.usage).toEqual({
        inputTokens: 400,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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
    });
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
      createRoleAgent(planner, { model: createFakeModel({ script: [] }) }),
    ]);
    await controller.start({ content: 'P' });
    const report = await controller.runRound();
    expect(report.ok && report.value.failures).toEqual([
      { agentId: 'planner', reason: 'script_exhausted', detail: 'script exhausted after 0 calls' },
    ]);
    expect(report.ok && report.value.ended).toBeNull();
  });
});
