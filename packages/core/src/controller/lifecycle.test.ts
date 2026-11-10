import { describe, expect, it } from 'vitest';

import { eligible, type Agent } from '../agents/agent';
import { createDefaultAgents } from '../agents/roster';
import { buildBoardView } from '../board/board-view';
import { InMemoryBoardStore } from '../board/in-memory-board-store';
import { createFakeModel } from '../model/fake-model';
import { nullLogger } from '../ports/logger';
import type { Model } from '../ports/model';
import { ok } from '../ports/result';
import { addUsage, zeroUsage } from '../schemas/common';
import type { BoardEvent } from '../schemas/event';
import { BoardFixture } from '../testing/board-fixture';
import { ManualClock } from '../testing/manual-clock';
import { testRolePrompts } from '../testing/role-prompts';
import { createScriptedModels } from '../testing/scripted-scenario';
import { SequentialIdGenerator, sequentialId } from '../testing/sequential-id-generator';
import { createController, type Controller, type ControllerDeps } from './controller';
import { orphanedRound } from './orphaned-round';
import { rehydrate } from './rehydrate';
import { synthesisPending } from './synthesis-request';

// Pause, resume, stop, human notes and picking a run up from its own log: the operations
// the server's run manager drives (docs/PLAN.md §2.3, human-in-the-loop).

const ofType = <T extends BoardEvent['type']>(events: readonly BoardEvent[], type: T) =>
  events.filter((e): e is Extract<BoardEvent, { type: T }> => e.type === type);

interface Scripted {
  controller: Controller;
  events: BoardEvent[];
  store: InMemoryBoardStore;
  clock: ManualClock;
}

// The canonical scripted swarm over a store the test keeps hold of, with an optional hook
// on every event so a test can ask for a pause or a stop at an exact moment.
const scripted = (
  options: {
    onEvent?: (event: BoardEvent, controller: Controller) => void;
    store?: InMemoryBoardStore;
    ids?: SequentialIdGenerator;
    resume?: Parameters<typeof createController>[1];
    /** Stands in for the scripted Synthesizer, which is always confident enough to end the run. */
    synthesizer?: Model;
  } = {},
): Scripted => {
  const events: BoardEvent[] = [];
  const store = options.store ?? new InMemoryBoardStore();
  const clock = new ManualClock();
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  });
  const deps: ControllerDeps = {
    store,
    clock,
    ids: options.ids ?? new SequentialIdGenerator(),
    logger: nullLogger,
    agents: createDefaultAgents(
      options.synthesizer === undefined ? models : { ...models, synthesizer: options.synthesizer },
      testRolePrompts(),
    ),
    onEvent: (event) => {
      events.push(event);
      if (ref.controller !== undefined) options.onEvent?.(event, ref.controller);
    },
  };
  const controller = createController(deps, options.resume);
  ref.controller = controller;
  return { controller, events, store, clock };
};

const shape = (controller: Controller) =>
  controller.currentView().entries.map((e) => [e.type, e.round, e.content]);

describe('pause and resume', () => {
  it('pauses after the round in flight, refuses rounds while paused, and resumes where it left off', async () => {
    const { controller, events } = scripted({
      onEvent: (event, c) => {
        if (event.type === 'round_completed' && event.round === 2) c.requestPause();
      },
    });
    await controller.start({ content: 'P' });
    const paused = await controller.run();
    expect(paused.ok && [paused.value.status, paused.value.reason, paused.value.rounds]).toEqual([
      'paused',
      'user_paused',
      2,
    ]);
    expect(controller.ended).toEqual({ status: 'paused', reason: 'user_paused' });
    expect(events.at(-1)).toMatchObject({ type: 'run_paused', round: 2, reason: 'user_paused' });
    const refused = await controller.runRound();
    expect(!refused.ok && refused.error).toEqual({ kind: 'paused', reason: 'user_paused' });

    const resumed = await controller.resume();
    expect(resumed.ok).toBe(true);
    expect(controller.ended).toBeNull();
    expect(ofType(events, 'run_resumed')).toMatchObject([{ round: 2, from: 'user_paused' }]);
    const done = await controller.run();
    expect(done.ok && [done.value.status, done.value.reason, done.value.rounds]).toEqual([
      'completed',
      'completed',
      4,
    ]);
    expect(ofType(events, 'round_completed').map((e) => e.round)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(!(await controller.resume()).ok).toBe(true);
  });

  it('a pause asked for between rounds happens before the next round starts, with the clock stopped', async () => {
    const { controller, events, clock } = scripted();
    await controller.start({ content: 'P' });
    await controller.runRound();
    controller.requestPause();
    const report = await controller.runRound();
    expect(report.ok && report.value.ended).toEqual({ status: 'paused', reason: 'user_paused' });
    expect(ofType(events, 'round_started').length).toBe(1);
    const pausedAt = ofType(events, 'run_paused')[0]?.totals.elapsedMs ?? -1;
    clock.advance(60 * 60_000);
    await controller.resume();
    const final = await controller.run();
    // An hour paused does not count against the fifteen-minute wall clock.
    expect(final.ok && final.value.reason).toBe('completed');
    expect(final.ok && final.value.totals.elapsedMs).toBe(pausedAt);
  });

  it('refuses to resume a run that is not paused', async () => {
    const { controller } = scripted();
    expect(!(await controller.resume()).ok).toBe(true);
    await controller.start({ content: 'P' });
    expect(await controller.resume()).toEqual({ ok: false, error: { kind: 'not_paused' } });
    await controller.run();
    expect(await controller.resume()).toEqual({ ok: false, error: { kind: 'not_paused' } });
  });
});

describe('stop', () => {
  it('stops before the next round when asked between rounds', async () => {
    const { controller, events } = scripted();
    await controller.start({ content: 'P' });
    await controller.runRound();
    controller.requestStop();
    const result = await controller.run();
    expect(result.ok && [result.value.status, result.value.reason, result.value.rounds]).toEqual([
      'stopped',
      'user_stopped',
      1,
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run_terminated', status: 'stopped' });
    expect(!(await controller.runRound()).ok).toBe(true);
  });

  it('lets the round in flight commit before stopping', async () => {
    const { controller } = scripted({
      onEvent: (event, c) => {
        if (event.type === 'agents_selected' && event.round === 2) c.requestStop();
      },
    });
    await controller.start({ content: 'P' });
    const result = await controller.run();
    expect(result.ok && [result.value.reason, result.value.rounds]).toEqual(['user_stopped', 2]);
    // Round 2's hypothesis and evidence made it to the board.
    expect(controller.currentView().liveOfType('hypothesis').length).toBe(1);
    expect(controller.currentView().liveOfType('evidence').length).toBe(1);
  });
});

describe('human notes', () => {
  it('commits a note the next round sees, under the problem, at the current round', async () => {
    const { controller, events } = scripted();
    expect(!(await controller.injectNote({ content: 'x', priority: 'high' })).ok).toBe(true);
    const problem = await controller.start({ content: 'P' });
    await controller.runRound();
    const note = await controller.injectNote({ content: 'Prefer SQLite', priority: 'high' });
    expect(note.ok && note.value).toMatchObject({
      type: 'human_note',
      author: 'human',
      round: 1,
      parents: [problem.ok ? problem.value.id : ''],
      payload: { priority: 'high' },
    });
    expect(controller.currentView().handleOf(note.ok ? note.value.id : '')).toBe('N1');
    expect(events.at(-1)).toMatchObject({ type: 'entry_committed', round: 1 });
    await controller.runRound();
    expect(controller.currentView().liveOfType('human_note').length).toBe(1);
    await controller.run();
    expect(!(await controller.injectNote({ content: 'late', priority: 'low' })).ok).toBe(true);
  });

  it('rejects an empty note', async () => {
    const { controller } = scripted();
    await controller.start({ content: 'P' });
    const result = await controller.injectNote({ content: '', priority: 'normal' });
    expect(!result.ok && result.error.kind).toBe('invalid_note');
  });

  it('keeps the event sequence contiguous when a note lands while a round is in flight', async () => {
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const slow: Agent = {
      id: 'slow',
      role: 'solver',
      trigger: () => eligible(90, [], 'on'),
      act: async () => {
        arrived();
        await gate;
        return ok({ contributions: [] });
      },
    };
    const events: BoardEvent[] = [];
    const store = new InMemoryBoardStore();
    const controller = createController({
      store,
      clock: new ManualClock(),
      ids: new SequentialIdGenerator(),
      logger: nullLogger,
      agents: [slow],
      onEvent: (event) => events.push(event),
    });
    await controller.start({ content: 'P' });
    const round = controller.runRound();
    await reached;
    expect(ofType(events, 'agents_selected').length).toBe(1);
    const note = controller.injectNote({ content: 'while you work', priority: 'normal' });
    release();
    const [report, injected] = await Promise.all([round, note]);
    expect(report.ok).toBe(true);
    expect(injected.ok && injected.value.round).toBe(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect((await store.eventsFor(controller.runId)).map((e) => e.seq)).toEqual(
      events.map((e) => e.seq),
    );
    expect(controller.currentView().liveOfType('human_note').length).toBe(1);
  });
});

describe('force synthesis', () => {
  // A Synthesizer that answers but is never confident enough to end the run, so a test can
  // see what the rounds after the forced one do.
  const cautious = (): Model =>
    createFakeModel({
      id: 'fake-cautious-synthesizer',
      script: () => ({
        object: {
          contributions: [
            {
              type: 'synthesis',
              content: ['A draft from a thin board.'],
              parents: [],
              payload: { version: 1, confidence: 0.4, cites: [] },
            },
          ],
        },
      }),
    });

  it('runs the Synthesizer in the first round after the request, once, and the run goes on', async () => {
    const { controller, events } = scripted({ synthesizer: cautious() });
    expect(await controller.forceSynthesis()).toEqual({
      ok: false,
      error: { kind: 'not_started' },
    });
    await controller.start({ content: 'P' });
    await controller.runRound();
    // Round 1 was the Planner alone: left to its trigger the Synthesizer has nothing to go on.
    expect((await controller.forceSynthesis()).ok).toBe(true);
    expect(controller.synthesisPending).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'synthesis_requested', round: 1 });
    // Asking again while the request is owed adds nothing to the log.
    expect((await controller.forceSynthesis()).ok).toBe(true);
    expect(ofType(events, 'synthesis_requested').length).toBe(1);

    const forced = await controller.runRound();
    expect(forced.ok && forced.value.selected).toEqual(['synthesizer', 'solver']);
    expect(forced.ok && forced.value.eligible.find((e) => e.agentId === 'synthesizer')).toEqual({
      agentId: 'synthesizer',
      priority: 100,
      reason: 'forced by the user',
    });
    // The termination rules are unchanged: a 0.4 synthesis does not end the run.
    expect(forced.ok && forced.value.ended).toBeNull();
    expect(
      controller
        .currentView()
        .liveOfType('synthesis')
        .map((s) => s.round),
    ).toEqual([2]);
    expect(controller.synthesisPending).toBe(false);
    expect(controller.flags.synthesisForced).toBe(false);
    expect(synthesisPending(events)).toBe(false);

    // Spent: the next round is chosen by the triggers alone.
    const next = await controller.runRound();
    expect(next.ok && next.value.selected).toEqual(['critic', 'solver']);
  });

  it('ends the run on a forced synthesis that clears the usual threshold', async () => {
    // The scripted Synthesizer answers at 0.9 with nothing blocking, which completes a run.
    const { controller } = scripted();
    await controller.start({ content: 'P' });
    await controller.runRound();
    await controller.forceSynthesis();
    const result = await controller.run();
    expect(result.ok && [result.value.status, result.value.reason, result.value.rounds]).toEqual([
      'completed',
      'completed',
      2,
    ]);
  });

  it('serves a request made while a round is in flight in the next round, not that one', async () => {
    const asked: Promise<unknown>[] = [];
    const { controller, events } = scripted({
      synthesizer: cautious(),
      onEvent: (event, c) => {
        if (event.type === 'agents_selected' && event.round === 2) asked.push(c.forceSynthesis());
      },
    });
    await controller.start({ content: 'P' });
    await controller.runRound();
    const second = await controller.runRound();
    await Promise.all(asked);
    expect(second.ok && second.value.selected).toEqual(['solver', 'researcher']);
    const requestedSeq = ofType(events, 'synthesis_requested')[0]?.seq ?? -1;
    const secondDoneSeq = ofType(events, 'round_completed')[1]?.seq ?? -1;
    expect(requestedSeq).toBeGreaterThan(ofType(events, 'round_started')[1]?.seq ?? Infinity);
    expect(requestedSeq).toBeLessThan(secondDoneSeq);
    // Round 2 completed after the request but started before it: still owed.
    expect(controller.synthesisPending).toBe(true);
    expect(synthesisPending(events)).toBe(true);

    const third = await controller.runRound();
    expect(third.ok && third.value.selected[0]).toBe('synthesizer');
    expect(controller.synthesisPending).toBe(false);
    expect(synthesisPending(events)).toBe(false);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('is exempt from the diversity rule', async () => {
    // With synthesis allowed from round 1 the Synthesizer is picked in rounds 1 and 2, so
    // the diversity rule sits it out in round 3 unless the user asks.
    const rounds = async (force: boolean) => {
      const { controller } = scripted({ synthesizer: cautious() });
      await controller.start({ content: 'P' }, { synthesisFromRound: 1 });
      const first = await controller.runRound();
      const second = await controller.runRound();
      if (force) await controller.forceSynthesis();
      const third = await controller.runRound();
      return [first, second, third].map((r) => (r.ok ? r.value.selected : []));
    };
    const unforced = await rounds(false);
    expect(unforced[0]).toContain('synthesizer');
    expect(unforced[1]).toContain('synthesizer');
    expect(unforced[2]).not.toContain('synthesizer');
    const forced = await rounds(true);
    expect(forced.slice(0, 2)).toEqual(unforced.slice(0, 2));
    expect(forced[2]?.[0]).toBe('synthesizer');
  });

  it('is refused once the run has ended', async () => {
    const { controller, events } = scripted();
    await controller.start({ content: 'P' });
    await controller.stop();
    await controller.run();
    expect(await controller.forceSynthesis()).toEqual({
      ok: false,
      error: { kind: 'terminated', reason: 'user_stopped' },
    });
    expect(ofType(events, 'synthesis_requested')).toEqual([]);
  });

  it('survives a pause and a restart: the request is rebuilt from the log', async () => {
    const first = scripted({
      synthesizer: cautious(),
      onEvent: (event, c) => {
        if (event.type === 'round_completed' && event.round === 1) c.requestPause();
      },
    });
    await first.controller.start({ content: 'P' });
    await first.controller.run();
    expect(first.controller.ended).toEqual({ status: 'paused', reason: 'user_paused' });
    // Asked for while paused: recorded now, served by the first round after the resume.
    expect((await first.controller.forceSynthesis()).ok).toBe(true);
    const log = await first.store.eventsFor(first.controller.runId);
    expect(log.at(-1)).toMatchObject({ type: 'synthesis_requested', round: 1 });

    const state = rehydrate(log);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.synthesisPending).toBe(true);
    expect(state.value.flags.synthesisForced).toBe(false);

    // A fresh process picks the run up.
    const second = scripted({
      store: first.store,
      ids: new SequentialIdGenerator(1_000),
      resume: { resume: state.value },
      synthesizer: cautious(),
    });
    expect(second.controller.synthesisPending).toBe(true);
    expect((await second.controller.resume()).ok).toBe(true);
    const round = await second.controller.runRound();
    expect(round.ok && round.value.selected).toEqual(['synthesizer', 'solver']);
    expect(second.controller.synthesisPending).toBe(false);
    const whole = await first.store.eventsFor(first.controller.runId);
    expect(whole.map((e) => e.seq)).toEqual(whole.map((_, i) => i));
    const again = rehydrate(whole);
    expect(again.ok && again.value.synthesisPending).toBe(false);
  });
});

describe('rehydrate', () => {
  it('rebuilds a paused run from its log and finishes it like an uninterrupted run', async () => {
    const reference = scripted();
    await reference.controller.start({ content: 'P' });
    const uninterrupted = await reference.controller.run();

    const first = scripted({
      onEvent: (event, c) => {
        if (event.type === 'round_completed' && event.round === 2) c.requestPause();
      },
    });
    await first.controller.start({ content: 'P' });
    await first.controller.run();
    const log = await first.store.eventsFor(first.controller.runId);

    const state = rehydrate(log);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value).toMatchObject({
      runId: first.controller.runId,
      completedRounds: 2,
      ended: { status: 'paused', reason: 'user_paused' },
      reframeUsed: false,
      consecutiveEmptyRounds: 0,
      monthlyWarningSent: false,
      flags: first.controller.flags,
    });
    expect(state.value.history).toEqual(ofType(log, 'agents_selected').map((e) => e.selected));
    expect(state.value.usage).toEqual(ofType(log, 'run_paused')[0]?.totals.usage);

    // A fresh process: new controller, new scripted models, ids that continue past the log's.
    const second = scripted({
      store: first.store,
      ids: new SequentialIdGenerator(1_000),
      resume: { resume: state.value },
    });
    expect(second.controller.runId).toBe(first.controller.runId);
    expect(second.controller.ended).toEqual({ status: 'paused', reason: 'user_paused' });
    expect(!(await second.controller.start({ content: 'again' })).ok).toBe(true);
    expect((await second.controller.resume()).ok).toBe(true);
    const finished = await second.controller.run();
    expect(
      finished.ok && [finished.value.status, finished.value.reason, finished.value.rounds],
    ).toEqual(['completed', 'completed', 4]);
    expect(shape(second.controller)).toEqual(shape(reference.controller));
    expect(finished.ok && uninterrupted.ok && finished.value.totals.usage).toEqual(
      uninterrupted.ok ? uninterrupted.value.totals.usage : null,
    );
    const whole = await first.store.eventsFor(first.controller.runId);
    expect(whole.map((e) => e.seq)).toEqual(whole.map((_, i) => i));
    expect(whole.map((e) => e.type).filter((t) => t.startsWith('run_'))).toEqual([
      'run_started',
      'run_paused',
      'run_resumed',
      'run_terminated',
    ]);
  });

  it('replays the conflict tracker and the stall rule', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    const runId = fx.runId;
    const at = (seq: number) => ({
      id: `00000000-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`,
      runId,
      seq,
      at: '2026-01-01T00:00:00.000Z',
    });
    const h1 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const h2 = fx.entry('hypothesis', {
      confidence: 0.5,
      supportedBy: [],
      contradictedBy: [h1.id],
    });
    const critique = fx.entry('critique', { target: h1.id, severity: 'major' });
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const events: BoardEvent[] = [
      {
        ...at(0),
        type: 'run_started',
        problemEntry: problem,
        config: { ...rehydrateConfig(), stallRounds: 2 },
        profile: null,
      },
      { ...at(1), type: 'entry_committed', round: 0, entry: problem },
      { ...at(2), type: 'round_started', round: 1 },
      { ...at(3), type: 'agents_selected', round: 1, selected: ['solver'], eligible: [] },
      { ...at(4), type: 'entry_committed', round: 1, entry: { ...h1, round: 1 } },
      { ...at(5), type: 'entry_committed', round: 1, entry: { ...h2, round: 1 } },
      { ...at(6), type: 'round_completed', round: 1, newEntries: 2, usage },
      { ...at(7), type: 'round_started', round: 2 },
      { ...at(8), type: 'agents_selected', round: 2, selected: ['critic'], eligible: [] },
      { ...at(9), type: 'entry_committed', round: 2, entry: { ...critique, round: 2 } },
      { ...at(10), type: 'round_completed', round: 2, newEntries: 1, usage },
      { ...at(11), type: 'round_started', round: 3 },
      { ...at(12), type: 'agents_selected', round: 3, selected: ['planner'], eligible: [] },
      { ...at(13), type: 'round_completed', round: 3, newEntries: 0, usage },
      { ...at(14), type: 'round_started', round: 4 },
      { ...at(15), type: 'agents_selected', round: 4, selected: ['planner'], eligible: [] },
      { ...at(16), type: 'round_completed', round: 4, newEntries: 0, usage },
    ];
    const state = rehydrate(events);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // Two hypotheses contradict and one was critiqued: a decision is required; two empty
    // rounds in a row used up the one reframe and raised the stall flag for the next round.
    expect(state.value.flags).toEqual({
      stallDetected: true,
      criticForced: false,
      decisionRequired: true,
      synthesisForced: false,
    });
    expect(state.value.synthesisPending).toBe(false);
    expect(state.value.reframeUsed).toBe(true);
    expect(state.value.consecutiveEmptyRounds).toBe(0);
    expect(state.value.history).toEqual([['solver'], ['critic'], ['planner'], ['planner']]);
    expect(state.value.completedRounds).toBe(4);
    expect(state.value.ended).toBeNull();
    // Never paused or ended: the time between first and last event counts as consumed.
    expect(state.value.elapsedMs).toBe(0);
  });

  it('rejects an empty log and one that does not start with run_started', () => {
    expect(rehydrate([])).toEqual({ ok: false, error: { kind: 'empty_log' } });
    const fx = new BoardFixture();
    fx.startRound(1);
    expect(rehydrate(fx.events)).toEqual({ ok: false, error: { kind: 'no_run_started' } });
  });
});

const rehydrateConfig = () =>
  ({
    maxRounds: 12,
    maxCostUsd: 0.25,
    maxTokens: 400_000,
    maxWallClockMs: 900_000,
    parallelism: 2,
    maxOutputTokens: 4096,
    synthesisThreshold: 0.8,
    synthesisFromRound: 8,
    stallRounds: 2,
    view: {
      maxFocusEntries: 20,
      maxFocusChars: 12_000,
      maxEntryChars: 1_000,
      maxSummaryChars: 4_000,
    },
  }) as const;

describe('stop()', () => {
  it('ends a paused run at once and a live run after its round', async () => {
    const { controller, events } = scripted({
      onEvent: (event, c) => {
        if (event.type === 'round_completed' && event.round === 1) c.requestPause();
      },
    });
    expect(!(await controller.stop()).ok).toBe(true);
    await controller.start({ content: 'P' });
    await controller.run();
    expect(controller.ended).toEqual({ status: 'paused', reason: 'user_paused' });
    expect((await controller.stop()).ok).toBe(true);
    expect(controller.ended).toEqual({ status: 'stopped', reason: 'user_stopped' });
    expect(events.at(-1)).toMatchObject({ type: 'run_terminated', round: 1, status: 'stopped' });
    expect(!(await controller.stop()).ok).toBe(true);

    const live = scripted();
    await live.controller.start({ content: 'P' });
    expect((await live.controller.stop()).ok).toBe(true);
    const result = await live.controller.run();
    expect(result.ok && [result.value.status, result.value.rounds]).toEqual(['stopped', 0]);
  });
});

describe('rehydrate: a log that paused, resumed and ended', () => {
  it('ends up terminal, with the warning remembered and the elapsed time from the end event', async () => {
    const { controller, store, events } = scripted({
      onEvent: (event, c) => {
        if (event.type === 'round_completed' && event.round === 1) c.requestPause();
      },
    });
    await controller.start({ content: 'P' });
    await controller.run();
    await controller.resume();
    await controller.run();
    const log = [...(await store.eventsFor(controller.runId))];
    // Splice a budget warning in where the controller would have emitted one.
    const warning: BoardEvent = {
      id: '00000000-0000-7000-8000-00000000ffff',
      runId: controller.runId,
      seq: log.length,
      at: events.at(-1)?.at ?? '2026-01-01T00:00:00.000Z',
      type: 'budget_warning',
      round: 4,
      spentUsd: 4.1,
      limitUsd: 5,
    };
    const state = rehydrate([...log, warning]);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const terminated = log.find((e) => e.type === 'run_terminated');
    expect(state.value.ended).toEqual({ status: 'completed', reason: 'completed' });
    expect(state.value.monthlyWarningSent).toBe(true);
    expect(state.value.completedRounds).toBe(4);
    expect(state.value.elapsedMs).toBe(
      terminated?.type === 'run_terminated' ? terminated.totals.elapsedMs : -1,
    );
    const endUsage = terminated?.type === 'run_terminated' ? terminated.totals.usage : null;
    expect(endUsage).not.toBeNull();
    if (endUsage === null) return;
    const { costUsd, ...tokens } = state.value.usage;
    const { costUsd: endCost, ...endTokens } = endUsage;
    expect(tokens).toEqual(endTokens);
    expect(costUsd).toBeCloseTo(endCost, 10);
    expect(log.filter((e) => e.type === 'run_resumed').length).toBe(1);
  });
});

describe('a round the host left in flight', () => {
  // The whole scripted run, and the same log cut where a dying process would have left it.
  const cutRun = async () => {
    const whole = scripted();
    await whole.controller.start({ content: 'P' });
    await whole.controller.run();
    const log = await whole.store.eventsFor(whole.controller.runId);
    const selected = log.findIndex((e) => e.type === 'agents_selected' && e.round === 3);
    const committed = log.findIndex((e) => e.type === 'entry_committed' && e.round === 3);
    expect(selected).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(selected);
    return { runId: whole.controller.runId, log, selected, committed };
  };

  it('is found by orphanedRound with what it committed, and only while it is open', async () => {
    const { log, selected, committed } = await cutRun();
    expect(orphanedRound(log)).toBeNull();
    expect(orphanedRound(log.slice(0, selected + 1))).toEqual({
      round: 3,
      newEntries: 0,
      usage: zeroUsage(),
    });
    const entry = log[committed];
    expect(orphanedRound(log.slice(0, committed + 1))).toEqual({
      round: 3,
      newEntries: 1,
      usage: entry?.type === 'entry_committed' ? entry.entry.usage : null,
    });
    // A round completed before the cut is not an orphan.
    const completed = log.findIndex((e) => e.type === 'round_completed' && e.round === 3);
    expect(orphanedRound(log.slice(0, completed + 1))).toBeNull();
  });

  it('is abandoned at recovery and the resumed run goes on from the next round', async () => {
    const { runId, log, committed } = await cutRun();
    const cut = log.slice(0, committed + 1);
    const store = new InMemoryBoardStore();
    for (const event of cut) expect((await store.append(event)).ok).toBe(true);

    // What the run manager appends at start-up: the abandoned round, then the pause.
    const orphan = orphanedRound(cut);
    expect(orphan).not.toBeNull();
    if (orphan === null) return;
    const at = cut.at(-1)?.at ?? '';
    const abandoned: BoardEvent = {
      id: sequentialId(900),
      runId,
      seq: cut.length,
      at,
      type: 'round_abandoned',
      ...orphan,
    };
    expect((await store.append(abandoned)).ok).toBe(true);
    const interrupted = rehydrate([...cut, abandoned]);
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const roundUsage = ofType(cut, 'round_completed').map((e) => e.usage);
    expect(interrupted.value).toMatchObject({ completedRounds: 3, ended: null });
    expect(interrupted.value.history.length).toBe(3);
    expect(interrupted.value.usage).toEqual(
      addUsage(
        roundUsage.reduce((a, b) => addUsage(a, b), zeroUsage()),
        orphan.usage,
      ),
    );
    const paused: BoardEvent = {
      id: sequentialId(901),
      runId,
      seq: cut.length + 1,
      at,
      type: 'run_paused',
      round: 3,
      reason: 'interrupted',
      totals: {
        rounds: 3,
        entries: buildBoardView(runId, [...cut, abandoned]).entries.length,
        usage: interrupted.value.usage,
        elapsedMs: interrupted.value.elapsedMs,
      },
    };
    expect((await store.append(paused)).ok).toBe(true);

    const state = rehydrate(await store.eventsFor(runId));
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const second = scripted({
      store,
      ids: new SequentialIdGenerator(1_000),
      resume: { resume: state.value },
    });
    expect((await second.controller.resume()).ok).toBe(true);
    const finished = await second.controller.run();
    expect(finished.ok && finished.value.status).toBe('completed');

    const whole = await store.eventsFor(runId);
    const starts = ofType(whole, 'round_started').map((e) => e.round);
    expect(starts.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(ofType(whole, 'round_abandoned').map((e) => e.round)).toEqual([3]);
    expect(ofType(whole, 'round_completed').map((e) => e.round)).not.toContain(3);
    expect(whole.map((e) => e.seq)).toEqual(whole.map((_, i) => i));
    // The abandoned round's one entry is still on the board the resumed run built on.
    const entry = cut[committed];
    expect(
      entry?.type === 'entry_committed' && second.controller.currentView().byId(entry.entry.id),
    ).toBeTruthy();
  });
});
