import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { eligible, notEligible, type Agent } from '../agents/agent';
import { latestSynthesis } from '../agents/eligibility';
import { createDefaultAgents } from '../agents/roster';
import { wordBudgetFor } from '../agents/word-budget';
import { WRITE_UP_ROLE } from '../agents/write-up';
import { InMemoryBoardStore } from '../board/in-memory-board-store';
import { createFakeModel, type FakeModel, type FakeResponse } from '../model/fake-model';
import { nullLogger } from '../ports/logger';
import type { Model } from '../ports/model';
import { err, ok } from '../ports/result';
import type { PeriodBudget } from '../ports/spend-ledger';
import type { Contribution } from '../schemas/contribution';
import type { BoardEvent } from '../schemas/event';
import { worstCaseCostUsd } from '../schemas/pricing';
import { defaultRunConfig } from '../schemas/run-config';
import { FakeSpendLedger } from '../testing/fake-spend-ledger';
import { ManualClock } from '../testing/manual-clock';
import { testRolePrompts, testWriteUpPrompt } from '../testing/role-prompts';
import { lateBoard } from '../testing/sample-boards';
import {
  createScriptedModels,
  SCENARIO_CALL_COST_USD,
  SCENARIO_PRICING,
  SCENARIO_TOKENS,
  type ScenarioPricing,
} from '../testing/scripted-scenario';
import { SequentialIdGenerator } from '../testing/sequential-id-generator';
import { createController, type Controller, type ControllerDeps } from './controller';
import { rehydrate } from './rehydrate';
import { SCHEMA_FALLBACK_CHARS } from './reservation';
import { sizeWriteUp, WRITE_UP_FRAME_CHARS, writeUpHoldUsd } from './write-up';

// The final write-up (docs/PLAN.md §2.3 step 8): what it costs to hold back, how the call is
// sized, and what the controller does with it at every way a run can end.

const ofType = <T extends BoardEvent['type']>(events: readonly BoardEvent[], type: T) =>
  events.filter((e): e is Extract<BoardEvent, { type: T }> => e.type === type);

const typesFrom = (events: readonly BoardEvent[], type: BoardEvent['type']): string[] =>
  events.slice(events.map((e) => e.type).lastIndexOf(type)).map((e) => e.type);

const WRITE_UP = defaultRunConfig().writeUp;

/** The hold the scripted prices give the default write-up: about $0.037. */
const SCENARIO_HOLD_USD = worstCaseCostUsd(
  SCENARIO_PRICING,
  Math.ceil(
    (testWriteUpPrompt().length +
      WRITE_UP_FRAME_CHARS +
      WRITE_UP.maxBoardChars +
      SCHEMA_FALLBACK_CHARS) /
      3,
  ),
  WRITE_UP.maxOutputTokens,
);

const FREE: ScenarioPricing = {
  planner: null,
  researcher: null,
  solver: null,
  critic: null,
  synthesizer: null,
};

interface Harness {
  controller: Controller;
  events: BoardEvent[];
  store: InMemoryBoardStore;
  clock: ManualClock;
}

const harness = (
  agents: readonly Agent[],
  overrides: Partial<ControllerDeps> = {},
  options: Parameters<typeof createController>[1] = {},
): Harness => {
  const events: BoardEvent[] = [];
  const store =
    overrides.store instanceof InMemoryBoardStore ? overrides.store : new InMemoryBoardStore();
  const clock = new ManualClock();
  const { onEvent, ...rest } = overrides;
  const controller = createController(
    {
      clock,
      ids: new SequentialIdGenerator(),
      logger: nullLogger,
      agents,
      ...rest,
      store,
      onEvent: (event) => {
        events.push(event);
        onEvent?.(event);
      },
    },
    options,
  );
  return { controller, events, store, clock };
};

// The canonical scripted swarm, with its Synthesizer's model given to the controller for
// the write-up, as every host does.
const scripted = (
  overrides: Partial<ControllerDeps> = {},
  pricing: ScenarioPricing = {},
  options: Parameters<typeof createController>[1] = {},
) => {
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  }, pricing);
  const h = harness(
    createDefaultAgents(models, testRolePrompts()),
    { writeUp: { model: models.synthesizer, prompt: testWriteUpPrompt() }, ...overrides },
    options,
  );
  ref.controller = h.controller;
  return { ...h, models };
};

// A board with one hypothesis on it after round 1, from an agent that calls no model; the
// agent then has nothing more to say, so what ends the run is up to the test's config.
const hypothesis: Contribution = {
  type: 'hypothesis',
  content: 'Adopt the monorepo.',
  parents: [],
  payload: { confidence: 0.7, supportedBy: [], contradictedBy: [] },
};
const oneHypothesis = (): Agent => {
  let posted = false;
  return {
    id: 'solver',
    role: 'solver',
    trigger: () => (posted ? notEligible('said its piece') : eligible(50, [], 'has a hypothesis')),
    act: () => {
      posted = true;
      return Promise.resolve(ok({ contributions: [hypothesis] }));
    },
  };
};

const written = (cites: readonly string[] = ['H1']) => ({
  paragraphs: ['Adopt it.', 'Assumption: the estimate holds.'],
  confidence: 0.8,
  cites,
});
const answer = (cites: readonly string[] = ['H1']): FakeResponse => ({
  object: written(cites),
  usage: SCENARIO_TOKENS,
});

/** A write-up model that answers from a list, one response per call. */
const writerModel = (script: readonly FakeResponse[], pricing = SCENARIO_PRICING): FakeModel =>
  createFakeModel({ id: 'fake-writer', pricing, script });

describe('writeUpHoldUsd', () => {
  it('is the worst case of one call at the largest board and the full allowance', () => {
    const model = writerModel([]);
    const hold = writeUpHoldUsd({ model, prompt: testWriteUpPrompt() }, WRITE_UP);
    expect(hold).toBeCloseTo(SCENARIO_HOLD_USD, 12);
    // 19k prompt tokens at the cache-write rate, 2,700 output tokens: under four cents.
    expect(hold).toBeGreaterThan(0.037);
    expect(hold).toBeLessThan(0.038);
  });

  it('grows with either bound and with the prompt, and is nothing for a free model', () => {
    const model = writerModel([]);
    const base = writeUpHoldUsd({ model, prompt: 'p' }, WRITE_UP);
    expect(
      writeUpHoldUsd({ model, prompt: 'p' }, { ...WRITE_UP, maxBoardChars: 96_000 }),
    ).toBeGreaterThan(base);
    expect(
      writeUpHoldUsd({ model, prompt: 'p' }, { ...WRITE_UP, maxOutputTokens: 4_096 }),
    ).toBeGreaterThan(base);
    expect(writeUpHoldUsd({ model, prompt: 'p'.repeat(9_000) }, WRITE_UP)).toBeGreaterThan(base);
    const free = createFakeModel({ pricing: null, script: [] });
    expect(writeUpHoldUsd({ model: free, prompt: testWriteUpPrompt() }, WRITE_UP)).toBe(0);
  });
});

describe('sizeWriteUp', () => {
  const view = lateBoard().fx.view();
  const writer = { model: writerModel([]), prompt: testWriteUpPrompt() };

  it('asks for the words the configured allowance buys when the call fits', () => {
    const sized = sizeWriteUp(writer, view, WRITE_UP, 1);
    expect(sized.fit).toMatchObject({ fits: true, maxOutputTokens: 2_700, shrunk: false });
    expect(sized.wordBudget).toBe(900);
    expect(sized.rendered.prompt).toContain('you have about 900 words');
    expect(sized.schema.safeParse(written(['H2'])).success).toBe(true);
  });

  it('shrinks the allowance to what is left and asks for correspondingly fewer words', () => {
    const sized = sizeWriteUp(writer, view, WRITE_UP, 0.008);
    expect(sized.fit.fits && sized.fit.shrunk).toBe(true);
    const allowance = sized.fit.fits ? sized.fit.maxOutputTokens : 0;
    expect(allowance).toBeLessThan(2_700);
    expect(allowance).toBeGreaterThanOrEqual(256);
    expect(sized.wordBudget).toBe(wordBudgetFor(allowance));
    expect(sized.wordBudget).toBeLessThan(900);
    expect(sized.rendered.prompt).toContain(`you have about ${String(sized.wordBudget)} words`);
    expect(sized.rendered.prompt).not.toContain('about 900 words');
  });

  it('does not fit when not even the smallest useful answer is covered', () => {
    const sized = sizeWriteUp(writer, view, WRITE_UP, 0.001);
    expect(sized.fit.fits).toBe(false);
  });

  it('always fits a free model at the configured allowance', () => {
    const free = { model: createFakeModel({ pricing: null, script: [] }), prompt: 'p' };
    expect(sizeWriteUp(free, view, WRITE_UP, 0).fit).toMatchObject({
      fits: true,
      maxOutputTokens: 2_700,
      shrunk: false,
    });
  });
});

describe('the final write-up at the end of a run', () => {
  it('follows the last round of the scripted run and becomes the run’s answer', async () => {
    const { controller, events, models } = scripted();
    await controller.start({ content: 'Should we adopt a monorepo?' });
    const result = await controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The run ends for the reason it would have ended for, after as many rounds.
    expect([result.value.status, result.value.reason, result.value.rounds]).toEqual([
      'completed',
      'completed',
      4,
    ]);
    // The write-up sits between the last round and the end, bracketed by its two events.
    expect(typesFrom(events, 'round_completed')).toEqual([
      'round_completed',
      'write_up_started',
      'entry_committed',
      'write_up_completed',
      'run_terminated',
    ]);
    expect(ofType(events, 'write_up_started')[0]).toMatchObject({
      round: 4,
      reason: 'completed',
      maxOutputTokens: 2_700,
      wordBudget: 900,
    });

    // One more call, on the Synthesizer's model, under its own role and with its own prompt.
    expect(models.synthesizer.calls.length).toBe(2);
    const call = models.synthesizer.calls[1]?.request;
    expect(call?.tags).toEqual({ role: WRITE_UP_ROLE, runId: controller.runId, round: 4 });
    expect(call?.system).toBe(testWriteUpPrompt());
    expect(call?.maxOutputTokens).toBe(2_700);
    expect(call?.prompt).toContain('# Working notes');
    expect(call?.prompt).toContain('## Latest draft of the answer');
    expect(call?.prompt).toContain('you have about 900 words');

    // The controller stamps what the model does not state: the next version, superseding
    // the draft, the stage; the entry is the Synthesizer's, in the round the run ended on.
    const view = result.value.view;
    const [draft, final] = view.entries.filter((e) => e.type === 'synthesis');
    expect(final).toMatchObject({
      type: 'synthesis',
      author: 'synthesizer',
      round: 4,
      supersedes: draft?.id,
      payload: { version: 2, stage: 'final', confidence: 0.9 },
    });
    expect(draft).toMatchObject({ payload: { version: 1, stage: 'draft' } });
    expect(final?.type === 'synthesis' && final.parents).toEqual(
      final?.type === 'synthesis' ? final.payload.cites : null,
    );
    expect(final?.content.split('\n\n').length).toBe(3);
    expect(view.handleOf(final?.id ?? '')).toBe('A2');
    expect(latestSynthesis(view)?.id).toBe(final?.id);
    expect(view.isLive(draft?.id ?? '')).toBe(false);

    // Seven calls in the rounds and one after them, all in the run's totals.
    const calls = 8;
    expect(result.value.totals.entries).toBe(11);
    expect(result.value.totals.usage.inputTokens).toBe(SCENARIO_TOKENS.inputTokens * calls);
    expect(result.value.totals.usage.costUsd).toBeCloseTo(SCENARIO_CALL_COST_USD * calls, 10);
    expect(ofType(events, 'write_up_completed')[0]).toMatchObject({
      round: 4,
      newEntries: 1,
      usage: {
        inputTokens: SCENARIO_TOKENS.inputTokens,
        outputTokens: SCENARIO_TOKENS.outputTokens,
      },
    });
    expect(final?.usage.costUsd).toBeCloseTo(SCENARIO_CALL_COST_USD, 10);
    expect(ofType(events, 'run_terminated')[0]?.totals).toEqual(result.value.totals);
    expect(ofType(events, 'agent_failed')).toEqual([]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    const after = await controller.runRound();
    expect(!after.ok && after.error).toEqual({ kind: 'terminated', reason: 'completed' });
  });

  it.each([
    ['budget_rounds', { maxRounds: 2 }],
    ['budget_tokens', { maxTokens: 2_000 }],
  ] as const)(
    'is written when the run stops with %s, from what the board holds',
    async (reason, config) => {
      const { controller, events } = scripted();
      await controller.start({ content: 'P' }, config);
      const result = await controller.run();
      expect(result.ok && [result.value.reason, result.value.rounds]).toEqual([reason, 2]);
      expect(typesFrom(events, 'write_up_started')).toEqual([
        'write_up_started',
        'entry_committed',
        'write_up_completed',
        'run_terminated',
      ]);
      expect(ofType(events, 'write_up_started')[0]?.reason).toBe(reason);
      // No draft was reached in two rounds: the write-up is the first synthesis, superseding none.
      const final = result.ok ? latestSynthesis(result.value.view) : undefined;
      expect(final).toMatchObject({ payload: { version: 1, stage: 'final' } });
      expect(final?.supersedes).toBeUndefined();
    },
  );

  it('is written when the run runs out of time, and its own time counts', async () => {
    const clock = new ManualClock();
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const models = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      return ref.controller.currentView();
    });
    const events: BoardEvent[] = [];
    const controller = createController({
      store: new InMemoryBoardStore(),
      clock,
      ids: new SequentialIdGenerator(),
      logger: nullLogger,
      agents: createDefaultAgents(models, testRolePrompts()),
      writeUp: { model: models.synthesizer, prompt: testWriteUpPrompt() },
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'round_completed') clock.advance(6 * 60_000);
        if (event.type === 'write_up_started') clock.advance(30_000);
      },
    });
    ref.controller = controller;
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && [result.value.reason, result.value.rounds]).toEqual(['budget_time', 3]);
    expect(ofType(events, 'write_up_completed')[0]?.newEntries).toBe(1);
    // Three rounds of six minutes, then the half minute the call took.
    expect(result.ok && result.value.totals.elapsedMs).toBe(18 * 60_000 + 30_000);
  });

  it('is written when the user stops a live run, after the round in flight', async () => {
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const run = scripted({
      onEvent: (event) => {
        if (event.type === 'round_started' && event.round === 2) ref.controller?.requestStop();
      },
    });
    ref.controller = run.controller;
    await run.controller.start({ content: 'P' });
    const result = await run.controller.run();
    expect(result.ok && [result.value.status, result.value.reason, result.value.rounds]).toEqual([
      'stopped',
      'user_stopped',
      2,
    ]);
    expect(ofType(run.events, 'write_up_started')[0]).toMatchObject({
      round: 2,
      reason: 'user_stopped',
    });
    expect(run.events.at(-1)?.type).toBe('run_terminated');
    expect(result.ok && latestSynthesis(result.value.view)?.payload.stage).toBe('final');
  });

  it('is written when a paused run is stopped, and nothing else is accepted meanwhile', async () => {
    const refused: string[] = [];
    const ref: { controller: Controller | undefined } = { controller: undefined };
    const run = scripted({
      onEvent: (event) => {
        const c = ref.controller;
        if (c === undefined) return;
        if (event.type === 'round_completed' && event.round === 2) c.requestPause();
        // While the write-up is in flight the run is already over for every other command.
        if (event.type === 'write_up_started') {
          refused.push(JSON.stringify(c.ended));
          void c.stop().then((r) => refused.push(r.ok ? 'stop ok' : `stop: ${r.error.kind}`));
          void c.resume().then((r) => refused.push(r.ok ? 'resume ok' : `resume: ${r.error.kind}`));
          void c
            .injectNote({ content: 'late', priority: 'high' })
            .then((r) => refused.push(r.ok ? 'note ok' : `note: ${r.error.kind}`));
        }
      },
    });
    ref.controller = run.controller;
    await run.controller.start({ content: 'P' });
    const paused = await run.controller.run();
    expect(paused.ok && paused.value.reason).toBe('user_paused');
    expect(ofType(run.events, 'write_up_started')).toEqual([]);

    expect((await run.controller.stop()).ok).toBe(true);
    await Promise.resolve();
    expect(typesFrom(run.events, 'run_paused')).toEqual([
      'run_paused',
      'write_up_started',
      'entry_committed',
      'write_up_completed',
      'run_terminated',
    ]);
    expect(run.controller.ended).toEqual({ status: 'stopped', reason: 'user_stopped' });
    expect(refused).toEqual([
      '{"status":"stopped","reason":"user_stopped"}',
      'stop: terminated',
      'resume: not_paused',
      'note: terminated',
    ]);
    expect(run.controller.currentView().liveOfType('human_note')).toEqual([]);
  });

  it('is written when nothing is left to do, with a model of its own', async () => {
    const model = writerModel([answer()]);
    const { controller, events } = harness([oneHypothesis()], {
      writeUp: { model, prompt: testWriteUpPrompt() },
    });
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('no_eligible_agents');
    expect(ofType(events, 'write_up_started')[0]?.reason).toBe('no_eligible_agents');
    expect(model.calls.length).toBe(1);
    const final = result.ok ? latestSynthesis(result.value.view) : undefined;
    expect(final?.content).toBe('Adopt it.\n\nAssumption: the estimate holds.');
    expect(final?.payload).toMatchObject({ version: 1, stage: 'final', confidence: 0.8 });
    expect(result.ok && result.value.totals.usage.costUsd).toBeCloseTo(SCENARIO_CALL_COST_USD, 10);
  });
});

describe('ends that get no write-up', () => {
  // One agent posts a hypothesis; the other's only call is refused by the provider.
  const refusedBy = (kind: 'billing' | 'auth'): Agent => {
    const model: Model = createFakeModel({
      script: [{ error: { kind, message: 'refused' } }],
    });
    return {
      id: 'critic',
      role: 'critic',
      trigger: () => eligible(40, [], 'on'),
      async act(_view, ctx) {
        const response = await ctx.models.call(model, {
          schema: z.object({ contributions: z.array(z.never()) }),
          system: 'sys',
          prompt: 'ask',
          tags: { role: 'critic', runId: ctx.runId, round: ctx.round },
        });
        return response.ok
          ? ok({ contributions: [] })
          : err({ kind: 'model', error: response.error });
      },
    };
  };

  it.each(['billing', 'auth'] as const)(
    'a run the provider has just refused (%s) makes no further call',
    async (kind) => {
      const model = writerModel([answer()]);
      const { controller, events } = harness([oneHypothesis(), refusedBy(kind)], {
        writeUp: { model, prompt: testWriteUpPrompt() },
      });
      await controller.start({ content: 'P' });
      const result = await controller.run();
      expect(result.ok && [result.value.status, result.value.reason]).toEqual(['failed', kind]);
      // There was something to write from, and the model was never asked.
      expect(result.ok && result.value.view.liveOfType('hypothesis').length).toBe(1);
      expect(model.calls).toEqual([]);
      expect(ofType(events, 'write_up_started')).toEqual([]);
      expect(ofType(events, 'write_up_completed')).toEqual([]);
      expect(events.at(-1)?.type).toBe('run_terminated');
    },
  );

  it('a board that holds nothing but the problem', async () => {
    const { controller, events, models } = scripted({}, FREE);
    await controller.start({ content: 'P' }, { maxCostUsd: 0 });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('budget_cost');
    expect(events.map((e) => e.type)).toEqual(['run_started', 'entry_committed', 'run_terminated']);
    expect(models.synthesizer.calls).toEqual([]);
  });

  it('a stop on a run whose month is already spent: the monthly limit is the harder one', async () => {
    const ledger = new FakeSpendLedger(1);
    const periodBudget: PeriodBudget = {
      limitUsd: 5,
      warnAtFraction: 0.8,
      timeZone: 'UTC',
      ledger,
    };
    const { controller, events, models } = scripted({
      periodBudget,
      onEvent: (event) => {
        // The month runs out while round 2 is in flight: the run pauses before round 3.
        if (event.type === 'round_started' && event.round === 2) ledger.spent = 5.01;
      },
    });
    await controller.start({ content: 'P' });
    const paused = await controller.run();
    expect(paused.ok && [paused.value.status, paused.value.reason]).toEqual([
      'paused',
      'monthly_budget',
    ]);

    expect((await controller.stop()).ok).toBe(true);
    expect(typesFrom(events, 'run_paused')).toEqual([
      'run_paused',
      'agent_failed',
      'run_terminated',
    ]);
    expect(ofType(events, 'agent_failed').at(-1)).toMatchObject({
      agentId: 'synthesizer',
      reason: 'budget_exhausted',
      detail: "final write-up skipped: the month's budget is spent ($5.0100 of $5.0000)",
    });
    expect(models.synthesizer.calls).toEqual([]);
    expect(controller.ended).toEqual({ status: 'stopped', reason: 'user_stopped' });
  });

  it('a controller that was given nothing to write with ends as it always did', async () => {
    const { controller, events, models } = scripted({ writeUp: undefined });
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.totals.entries).toBe(10);
    expect(models.synthesizer.calls.length).toBe(1);
    expect(typesFrom(events, 'round_completed')).toEqual(['round_completed', 'run_terminated']);
  });
});

describe('the money held back for the write-up', () => {
  it('refuses a cap that cannot cover it, naming both figures', async () => {
    const { controller, events } = scripted();
    const refused = await controller.start({ content: 'P' }, { maxCostUsd: 0.03 });
    expect(refused).toEqual({
      ok: false,
      error: {
        kind: 'invalid_config',
        issues: [
          `maxCostUsd: a cap of $0.0300 does not cover the final write-up, which may cost up to $${SCENARIO_HOLD_USD.toFixed(4)} and is held back from the cap; raise the cap, or lower writeUp.maxBoardChars or writeUp.maxOutputTokens`,
        ],
      },
    });
    expect(events).toEqual([]);
    // The same cap is enough once the write-up is asked to read less and write less.
    const smaller = scripted();
    const started = await smaller.controller.start(
      { content: 'P' },
      { maxCostUsd: 0.03, writeUp: { maxBoardChars: 8_000, maxOutputTokens: 1_000 } },
    );
    expect(started.ok).toBe(true);
  });

  it('holds nothing for a free model, so a zero cap still starts', async () => {
    const { controller } = scripted({}, FREE);
    expect((await controller.start({ content: 'P' }, { maxCostUsd: 0 })).ok).toBe(true);
  });

  it('is out of the rounds’ reach: they stop on cost with it intact, and the call gets its full room', async () => {
    // A cap a little above the hold leaves the rounds six tenths of a cent: two scripted calls.
    const cap = SCENARIO_HOLD_USD + 0.006;
    const { controller, events, models } = scripted();
    await controller.start({ content: 'P' }, { maxCostUsd: cap });
    const result = await controller.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.reason).toBe('budget_cost');
    const rounds = ofType(events, 'round_completed').reduce((sum, e) => sum + e.usage.costUsd, 0);
    // What the rounds spent never passed the cap less the hold…
    expect(rounds).toBeLessThanOrEqual(cap - SCENARIO_HOLD_USD + SCENARIO_CALL_COST_USD);
    expect(rounds).toBeGreaterThan(0);
    // …no round's call was allowed to reserve into it…
    for (const model of Object.values(models)) {
      for (const call of model.calls.filter((c) => c.request.tags.role !== WRITE_UP_ROLE)) {
        expect(call.request.maxOutputTokens).toBeLessThan(4_096);
      }
    }
    // …and the write-up, which the same money was kept for, ran at its whole allowance.
    expect(ofType(events, 'write_up_started')[0]).toMatchObject({
      reason: 'budget_cost',
      maxOutputTokens: 2_700,
      wordBudget: 900,
    });
    expect(ofType(events, 'write_up_completed')[0]?.newEntries).toBe(1);
    expect(latestSynthesis(result.value.view)?.payload.stage).toBe('final');
    expect(result.value.totals.usage.costUsd).toBeLessThanOrEqual(cap);
  });

  it('asks for fewer words when the prompt outgrew what was held for it', async () => {
    // A problem statement far longer than the hold assumed: the call is fitted to what is
    // left, the allowance shrinks, and the prompt is worded for the smaller allowance.
    const model = writerModel([answer()]);
    const { controller, events } = harness([oneHypothesis()], {
      writeUp: { model, prompt: testWriteUpPrompt() },
    });
    await controller.start(
      { content: `Decide. ${'context '.repeat(10_000)}` },
      { maxCostUsd: SCENARIO_HOLD_USD + 0.001 },
    );
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('no_eligible_agents');
    const started = ofType(events, 'write_up_started')[0];
    const allowance = started?.maxOutputTokens ?? 0;
    expect(allowance).toBeLessThan(2_700);
    expect(allowance).toBeGreaterThanOrEqual(256);
    expect(started?.wordBudget).toBe(wordBudgetFor(allowance));
    const request = model.calls[0]?.request;
    expect(request?.maxOutputTokens).toBe(allowance);
    expect(request?.prompt).toContain(`you have about ${String(started?.wordBudget)} words`);
    expect(result.ok && result.value.totals.usage.costUsd).toBeLessThanOrEqual(
      SCENARIO_HOLD_USD + 0.001,
    );
  });
});

describe('a write-up that goes wrong', () => {
  const run = async (model: FakeModel, fallback?: FakeModel) => {
    const h = harness([oneHypothesis()], {
      writeUp: {
        model,
        prompt: testWriteUpPrompt(),
        ...(fallback === undefined ? {} : { fallback }),
      },
    });
    await h.controller.start({ content: 'P' });
    const result = await h.controller.run();
    if (!result.ok) throw new Error(result.error.kind);
    return { ...h, summary: result.value };
  };
  // A handle the prompt never named fails the schema, like any other malformed answer.
  const malformed = answer(['H7']);

  it('gets one repair on the same model, with what was wrong', async () => {
    const model = writerModel([malformed, answer()]);
    const { events, summary } = await run(model);
    expect(model.calls.map((c) => c.outcome)).toEqual(['invalid_output', 'ok']);
    expect(model.calls[1]?.request.prompt).toContain('# Your previous answer was rejected');
    expect(model.calls[1]?.request.prompt).toContain('cites.0');
    expect(ofType(events, 'agent_failed')).toEqual([]);
    // Both calls were billed; both are in the write-up's usage and on its entry.
    const completed = ofType(events, 'write_up_completed')[0];
    expect(completed?.newEntries).toBe(1);
    expect(completed?.usage.costUsd).toBeCloseTo(2 * SCENARIO_CALL_COST_USD, 10);
    expect(latestSynthesis(summary.view)?.usage.costUsd).toBeCloseTo(
      2 * SCENARIO_CALL_COST_USD,
      10,
    );
  });

  it('goes to the fallback model after a failed repair', async () => {
    const model = writerModel([malformed, malformed]);
    const fallback = writerModel([answer()]);
    const { events, summary } = await run(model, fallback);
    expect(model.calls.length).toBe(2);
    expect(fallback.calls.length).toBe(1);
    expect(fallback.calls[0]?.request.prompt).not.toContain('previous answer was rejected');
    expect(ofType(events, 'write_up_completed')[0]?.newEntries).toBe(1);
    expect(latestSynthesis(summary.view)?.payload.stage).toBe('final');
  });

  it('leaves the last draft as the answer when every attempt fails, and says why', async () => {
    const draft: Contribution = {
      type: 'synthesis',
      content: 'A draft.',
      parents: [],
      payload: { version: 1, confidence: 0.5, cites: [] },
    };
    let posted = false;
    const drafter: Agent = {
      id: 'synthesizer',
      role: 'synthesizer',
      trigger: () => (posted ? notEligible('done') : eligible(50, [], 'draft')),
      act: () => {
        posted = true;
        return Promise.resolve(ok({ contributions: [hypothesis, draft] }));
      },
    };
    const model = writerModel([malformed, malformed]);
    const { controller, events } = harness([drafter], {
      writeUp: { model, prompt: testWriteUpPrompt() },
    });
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && result.value.reason).toBe('no_eligible_agents');
    expect(typesFrom(events, 'write_up_started')).toEqual([
      'write_up_started',
      'agent_failed',
      'write_up_completed',
      'run_terminated',
    ]);
    expect(ofType(events, 'agent_failed')[0]).toMatchObject({
      agentId: 'synthesizer',
      reason: 'invalid_output',
    });
    // The two calls were billed although nothing was committed.
    expect(ofType(events, 'write_up_completed')[0]).toMatchObject({ newEntries: 0 });
    expect(ofType(events, 'write_up_completed')[0]?.usage.costUsd).toBeCloseTo(
      2 * SCENARIO_CALL_COST_USD,
      10,
    );
    const latest = result.ok ? latestSynthesis(result.value.view) : undefined;
    expect(latest).toMatchObject({ content: 'A draft.', payload: { stage: 'draft' } });
    expect(result.ok && result.value.totals.usage.costUsd).toBeCloseTo(
      2 * SCENARIO_CALL_COST_USD,
      10,
    );
  });

  it('does not retry a provider error, and ends the run for its own reason all the same', async () => {
    const model = writerModel([
      { error: { kind: 'network', message: 'connection reset', attempts: 3 } },
      answer(),
    ]);
    const { events, summary } = await run(model);
    expect(model.calls.length).toBe(1);
    expect(ofType(events, 'agent_failed')[0]).toMatchObject({
      agentId: 'synthesizer',
      reason: 'network',
      detail: 'network after 3 attempt(s): connection reset',
    });
    expect(ofType(events, 'write_up_completed')[0]).toMatchObject({ newEntries: 0 });
    expect(ofType(events, 'write_up_completed')[0]?.usage.costUsd).toBe(0);
    expect([summary.status, summary.reason]).toEqual(['completed', 'no_eligible_agents']);
    expect(latestSynthesis(summary.view)).toBeUndefined();
  });
});

describe('an end the host did not live to finish', () => {
  // A whole scripted run, then its log cut where a dying host would have left it.
  const finishedRun = async () => {
    const whole = scripted();
    await whole.controller.start({ content: 'P' });
    const result = await whole.controller.run();
    if (!result.ok) throw new Error(result.error.kind);
    return { log: whole.events, summary: result.value };
  };
  const resumeFrom = async (cut: readonly BoardEvent[]) => {
    const store = new InMemoryBoardStore();
    for (const event of cut) expect((await store.append(event)).ok).toBe(true);
    const state = rehydrate(cut);
    if (!state.ok) throw new Error(state.error.kind);
    const resumed = scripted(
      { store, ids: new SequentialIdGenerator(5_000) },
      {},
      {
        resume: state.value,
      },
    );
    const result = await resumed.controller.run();
    if (!result.ok) throw new Error(result.error.kind);
    return { ...resumed, summary: result.value, appended: resumed.events };
  };

  it('is finished on resume without another round when the call never returned', async () => {
    const { log, summary } = await finishedRun();
    const cut = log.slice(0, log.findIndex((e) => e.type === 'write_up_started') + 1);
    const resumed = await resumeFrom(cut);
    expect(resumed.appended.map((e) => e.type)).toEqual([
      'write_up_started',
      'entry_committed',
      'write_up_completed',
      'run_terminated',
    ]);
    expect([resumed.summary.reason, resumed.summary.rounds]).toEqual(['completed', 4]);
    expect(latestSynthesis(resumed.summary.view)).toMatchObject({
      payload: { version: 2, stage: 'final' },
    });
    expect(resumed.summary.totals.usage.inputTokens).toBe(summary.totals.usage.inputTokens);
    expect(resumed.summary.totals.usage.outputTokens).toBe(summary.totals.usage.outputTokens);
    expect(resumed.summary.totals.usage.costUsd).toBeCloseTo(summary.totals.usage.costUsd, 10);
    expect(resumed.summary.totals.entries).toBe(summary.totals.entries);
  });

  it('is finished without paying twice when the call had returned', async () => {
    const { log, summary } = await finishedRun();
    const cut = log.slice(0, log.findIndex((e) => e.type === 'write_up_completed') + 1);
    const resumed = await resumeFrom(cut);
    expect(resumed.appended.map((e) => e.type)).toEqual(['run_terminated']);
    expect(resumed.models.synthesizer.calls).toEqual([]);
    expect([resumed.summary.status, resumed.summary.reason]).toEqual(['completed', 'completed']);
    expect(resumed.summary.totals.usage.inputTokens).toBe(summary.totals.usage.inputTokens);
    expect(resumed.summary.totals.usage.outputTokens).toBe(summary.totals.usage.outputTokens);
    expect(resumed.summary.totals.usage.costUsd).toBeCloseTo(summary.totals.usage.costUsd, 10);
    expect(latestSynthesis(resumed.summary.view)?.payload.stage).toBe('final');
  });
});
