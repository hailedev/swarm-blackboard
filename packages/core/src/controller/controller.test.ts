import { describe, expect, it } from 'vitest';

import {
  eligible,
  notEligible,
  type Agent,
  type AgentContext,
  type AgentError,
  type AgentResult,
} from '../agents/agent';
import { createDefaultAgents } from '../agents/roster';
import { InMemoryBoardStore } from '../board/in-memory-board-store';
import { err, ok, type Result } from '../ports/result';
import { nullLogger } from '../ports/logger';
import type { Contribution } from '../schemas/contribution';
import type { BoardEvent } from '../schemas/event';
import type { RunConfigInput } from '../schemas/run-config';
import { ManualClock } from '../testing/manual-clock';
import { createScriptedModels, SCENARIO_USAGE } from '../testing/scripted-scenario';
import { SequentialIdGenerator } from '../testing/sequential-id-generator';
import { createController, type Controller, type ControllerDeps } from './controller';

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 };

// A minimal agent for exercising controller paths without the role rules.
const stubAgent = (
  id: string,
  options: {
    priority?: number | null;
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
    options.priority === null ? notEligible('off') : eligible(options.priority ?? 50, [], 'on'),
  act: (_view, ctx) => {
    options.onCtx?.(ctx);
    const produced = options.act?.(ctx) ?? [];
    if (Array.isArray(produced)) return Promise.resolve(ok({ contributions: produced, usage }));
    return Promise.resolve(produced);
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
  const controller = createController({
    store,
    clock,
    ids: new SequentialIdGenerator(),
    logger: nullLogger,
    agents,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { controller, events, store, clock };
};

const scripted = (config: RunConfigInput = {}, overrides: Partial<ControllerDeps> = {}) => {
  let controller: Controller | undefined;
  const models = createScriptedModels(() => {
    if (controller === undefined) throw new Error('controller not ready');
    return controller.currentView();
  });
  const h = harness(createDefaultAgents(models), overrides);
  controller = h.controller;
  return { ...h, models, config };
};

describe('createController', () => {
  it('starts a run with the problem entry and config defaults', async () => {
    const { controller, events, store } = harness([]);
    const started = await controller.start({
      content: 'Should we adopt a monorepo?',
      constraints: ['No downtime'],
    });
    expect(started.ok && started.value.author).toBe('human');
    expect(started.ok && started.value.payload.constraints).toEqual(['No downtime']);
    expect(events.map((e) => e.type)).toEqual(['run_started', 'entry_committed']);
    expect(events[0]?.type === 'run_started' && events[0].config.maxRounds).toBe(12);
    expect(controller.currentView().problem()?.content).toBe('Should we adopt a monorepo?');
    expect((await store.eventsFor(controller.runId)).map((e) => e.seq)).toEqual([0, 1]);
    expect((await controller.start({ content: 'again' })).ok).toBe(false);
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

    expect(result.value.reason).toBe('synthesis_confident');
    expect(result.value.rounds).toBe(4);
    expect(result.value.totals.entries).toBe(12);
    const calls = 7;
    expect(result.value.totals.usage).toEqual({
      inputTokens: SCENARIO_USAGE.inputTokens * calls,
      outputTokens: SCENARIO_USAGE.outputTokens * calls,
      costUsd: expect.closeTo(SCENARIO_USAGE.costUsd * calls, 10) as number,
    });

    const selections = events.flatMap((e) => (e.type === 'agents_selected' ? [e.selected] : []));
    expect(selections).toEqual([
      ['planner'],
      ['solver', 'researcher'],
      ['critic', 'solver'],
      ['critic', 'synthesizer'],
    ]);
    expect(Object.values(models).map((m) => m.calls.length)).toEqual([1, 1, 2, 2, 1]);
    expect(events.filter((e) => e.type === 'agent_failed')).toEqual([]);

    const view = result.value.view;
    expect(view.liveOfType('hypothesis').map((h) => h.payload.confidence)).toEqual([0.85]);
    expect(view.liveOfType('subproblem').map((s) => s.payload.status)).toEqual(['done', 'done']);
    expect(view.liveOfType('synthesis')[0]?.payload.cites.length).toBe(2);
    expect(view.openBlockingCritiques()).toEqual([]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run_terminated');

    const after = await controller.runRound();
    expect(!after.ok && after.error.kind).toBe('terminated');
  });

  it.each([
    ['budget:rounds', { maxRounds: 2 }, 2],
    ['budget:tokens', { maxTotalTokens: 2_000 }, 2],
    ['budget:cost', { maxCostUsd: 0.005 }, 2],
  ])('stops with %s', async (reason, config, rounds) => {
    const { controller } = scripted();
    await controller.start({ content: 'P' }, config);
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe(reason);
    expect(result.ok && result.value.rounds).toBe(rounds);
  });

  it('stops on the wall clock using the injected clock', async () => {
    let controller: Controller | undefined;
    const clock = new ManualClock();
    const models = createScriptedModels(() => {
      if (controller === undefined) throw new Error('not ready');
      return controller.currentView();
    });
    const h = harness(createDefaultAgents(models), {
      clock,
      onEvent: (event) => {
        if (event.type === 'round_completed') clock.advance(6 * 60_000);
      },
    });
    controller = h.controller;
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('budget:wall_clock');
    expect(result.ok && result.value.rounds).toBe(3);
    expect(result.ok && result.value.totals.elapsedMs).toBe(18 * 60_000);
  });

  it('terminates before any model call when a budget is already exhausted', async () => {
    const { controller, events } = scripted();
    await controller.start({ content: 'P' }, { maxCostUsd: 0 });
    const report = await controller.runRound();
    expect(report.ok && report.value.terminated).toBe('budget:cost');
    expect(report.ok && report.value.round).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['run_started', 'entry_committed', 'run_terminated']);
  });

  it('records agent failures and keeps going', async () => {
    const problemId = () => events.find((e) => e.type === 'entry_committed')?.entry.id ?? '';
    const { controller, events } = harness([
      stubAgent('broken', {
        priority: 90,
        act: () =>
          err({
            kind: 'model',
            error: { kind: 'invalid_output', issues: ['confidence: too big'], raw: '{}' },
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
    expect(events.filter((e) => e.type === 'agent_failed').length).toBe(2);
    expect(report.value.terminated).toBeNull();
    expect(report.value.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
  });

  it('turns a throwing agent into a model_error failure', async () => {
    const thrower: Agent = {
      ...stubAgent('thrower', { priority: 50 }),
      act: () => Promise.reject(new Error('kaboom')),
    };
    const { controller } = harness([thrower]);
    await controller.start({ content: 'P' });
    const report = await controller.runRound();
    expect(report.ok && report.value.failures).toEqual([
      { agentId: 'thrower', reason: 'model_error', detail: 'provider error: kaboom' },
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
    expect(result.ok && result.value.reason).toBe('budget:rounds');
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
