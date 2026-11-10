import {
  buildBoardView,
  latestSynthesis,
  synthesisPending,
  zeroUsage,
  type BoardEvent,
} from '@team/core';
import type { ModelCallSummary } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { recordedEvents, recordedRunId } from '../testing/recorded-run';
import { nextEnvelope, scriptedRun } from '../testing/scripted-run';
import {
  agentSpendOf,
  agentStatesOf,
  boardAt,
  completedRounds,
  elapsedMsOf,
  eventsAt,
  eventsThrough,
  feedOf,
  lastEventMs,
  runStateOf,
  usageOf,
} from './selectors';

const ofType = <T extends BoardEvent['type']>(events: readonly BoardEvent[], type: T) =>
  events.filter((e): e is Extract<BoardEvent, { type: T }> => e.type === type);

describe('the board at a round', () => {
  const events = recordedEvents();
  const runId = recordedRunId();

  it('folds the recorded run to its final board, with the handles the agents used', () => {
    const view = boardAt(runId, events, null);
    expect(view.entries.length).toBe(96);
    expect(view.live.length).toBe(86);
    expect(view.entries.slice(0, 4).map((e) => view.handleOf(e.id))).toEqual([
      'P1',
      'S1',
      'S2',
      'S3',
    ]);
    const answer = latestSynthesis(view);
    expect(answer === undefined ? undefined : view.handleOf(answer.id)).toBe('A4');
    expect(completedRounds(events)).toBe(12);
  });

  it('shows a replayed round as the fold of the log cut before the next round starts', () => {
    for (const round of [0, 1, 3, 7, 12]) {
      const prefix = eventsThrough(events, round);
      const committed = ofType(events, 'entry_committed').filter((e) => e.round <= round);
      expect(boardAt(runId, events, round).entries.map((e) => e.id)).toEqual(
        committed.map((e) => e.entry.id),
      );
      // Nothing of a later round is in the prefix, and the prefix is a prefix.
      expect(prefix.every((e) => !('round' in e) || e.round <= round)).toBe(true);
      expect(prefix).toEqual(events.slice(0, prefix.length));
    }
    expect(boardAt(runId, events, 3).entries.length).toBe(27);
    expect(eventsThrough(events, 0).at(-1)?.type).toBe('entry_committed');
    expect(eventsThrough(events, 3).at(-1)).toMatchObject({ type: 'round_completed', round: 3 });
    // The last round takes the end of the run with it; a round past the end is the whole log.
    expect(eventsThrough(events, 12)).toBe(events);
    expect(eventsThrough(events, 99)).toBe(events);
    expect(eventsAt(events, null)).toBe(events);
  });

  it('keeps what happened between two rounds with the earlier one', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.injectNote({ content: 'Prefer SQLite', priority: 'high' });
    await run.controller.forceSynthesis();
    await run.controller.runRound();
    const afterOne = eventsThrough(run.events, 1);
    expect(afterOne.slice(-2).map((e) => e.type)).toEqual([
      'entry_committed',
      'synthesis_requested',
    ]);
    const view = buildBoardView(run.controller.runId, afterOne);
    expect(view.liveOfType('human_note').map((n) => view.handleOf(n.id))).toEqual(['N1']);
    // Owed after round 1, served by round 2.
    expect(synthesisPending(afterOne)).toBe(true);
    expect(synthesisPending(run.events)).toBe(false);
  });
});

describe('runStateOf', () => {
  it('reads the recorded run: completed on the round limit', () => {
    expect(runStateOf(recordedEvents())).toMatchObject({
      runId: recordedRunId(),
      status: 'completed',
      reason: 'budget_rounds',
      round: 12,
      completedRounds: 12,
      roundInFlight: false,
      profile: { name: 'cheap' },
      config: { maxRounds: 12, maxCostUsd: 0.25 },
    });
    expect(runStateOf([])).toBeUndefined();
    expect(runStateOf(recordedEvents().slice(1))).toBeUndefined();
  });

  it('follows a run through pause, resume and its end, with a reason whenever it is not running', async () => {
    const seen: [string, string | null, boolean][] = [];
    const snapshot = (events: readonly BoardEvent[]): void => {
      const state = runStateOf(events);
      if (state !== undefined) seen.push([state.status, state.reason, state.roundInFlight]);
    };
    const run = await scriptedRun((event, controller) => {
      if (event.type === 'round_completed' && event.round === 2) controller.requestPause();
    });
    snapshot(run.events);
    await run.controller.run();
    snapshot(run.events);
    await run.controller.resume();
    snapshot(run.events);
    await run.controller.run();
    snapshot(run.events);
    expect(seen).toEqual([
      ['running', null, false],
      ['paused', 'user_paused', false],
      ['running', null, false],
      ['completed', 'completed', false],
    ]);
    // Mid-round: the round has started and not completed.
    const midRound = run.events.slice(
      0,
      run.events.findIndex((e) => e.type === 'agents_selected' && e.round === 2) + 1,
    );
    expect(runStateOf(midRound)).toMatchObject({
      status: 'running',
      round: 2,
      completedRounds: 1,
      roundInFlight: true,
    });
  });

  it('reads a stopped run and a failed one', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.stop();
    await run.controller.run();
    expect(runStateOf(run.events)).toMatchObject({ status: 'stopped', reason: 'user_stopped' });

    const failed: BoardEvent[] = [
      ...run.events.slice(0, -1),
      {
        ...nextEnvelope(run.events.slice(0, -1)),
        type: 'run_terminated',
        round: 1,
        status: 'failed',
        reason: 'billing',
        totals: {
          rounds: 1,
          entries: 3,
          usage: usageOf(run.events),
          elapsedMs: 10,
        },
      },
    ];
    expect(runStateOf(failed)).toMatchObject({ status: 'failed', reason: 'billing' });
  });
});

describe('usage and time', () => {
  it('sums the rounds to what the run itself reported at its end', () => {
    const events = recordedEvents();
    const end = ofType(events, 'run_terminated')[0];
    if (end === undefined) throw new Error('the recorded run did not end');
    const { costUsd, ...tokens } = usageOf(events);
    const { costUsd: endCost, ...endTokens } = end.totals.usage;
    expect(tokens).toEqual(endTokens);
    expect(costUsd).toBeCloseTo(endCost, 10);
    expect(costUsd).toBeCloseTo(0.0238, 4);
    // Spend so far at an earlier round is the sum of the rounds up to it.
    const three = ofType(events, 'round_completed')
      .filter((e) => e.round <= 3)
      .reduce((sum, e) => sum + e.usage.costUsd, 0);
    expect(usageOf(eventsThrough(events, 3)).costUsd).toBeCloseTo(three, 10);
  });

  it('takes the elapsed time from a pause or an end, and counts on from the clock while running', async () => {
    const recorded = recordedEvents();
    expect(elapsedMsOf(recorded, Date.parse('2030-01-01T00:00:00Z'))).toBe(467_993);

    const run = await scriptedRun((event, controller, clock) => {
      clock.advance(1_000);
      if (event.type === 'round_completed' && event.round === 1) controller.requestPause();
    });
    const startedMs = lastEventMs(run.events.slice(0, 1));
    expect(elapsedMsOf(run.events, startedMs + 5_000)).toBe(5_000);
    // A clock behind the log (a reload, a skewed machine) never counts backwards.
    expect(elapsedMsOf(run.events, startedMs - 5_000)).toBe(0);
    await run.controller.run();
    const paused = ofType(run.events, 'run_paused')[0]?.totals.elapsedMs ?? -1;
    expect(paused).toBeGreaterThan(0);
    // Paused: the figure stands still however late it gets.
    expect(elapsedMsOf(run.events, startedMs + 3_600_000)).toBe(paused);
    await run.controller.resume();
    const resumedMs = lastEventMs(run.events);
    expect(elapsedMsOf(run.events, resumedMs + 2_000)).toBe(paused + 2_000);
    expect(lastEventMs([])).toBe(0);
  });
});

describe('agentStatesOf', () => {
  it('shows the selected agents as running while their round is in flight, idle after', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.runRound();
    const inFlight = run.events.slice(
      0,
      run.events.findIndex((e) => e.type === 'agents_selected' && e.round === 2) + 1,
    );
    expect(agentStatesOf(inFlight).map((a) => [a.role, a.activity])).toEqual([
      ['planner', 'idle'],
      ['researcher', 'running'],
      ['solver', 'running'],
      ['critic', 'idle'],
      ['synthesizer', 'idle'],
    ]);
    const after = agentStatesOf(run.events);
    expect(after.every((a) => a.activity === 'idle')).toBe(true);
    expect(after.find((a) => a.role === 'solver')).toMatchObject({
      rounds: 1,
      lastSelectedRound: 2,
      lastEligibility: 'open subproblems or unexplained evidence',
      failure: null,
    });
    expect(after.find((a) => a.role === 'critic')).toMatchObject({ rounds: 0, failure: null });
  });

  it('shows an agent whose last call was refused as failed, with the reason and the detail', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.runRound();
    const done = run.events.findIndex((e) => e.type === 'round_completed' && e.round === 2);
    const detail =
      'invalid_request: prompt (~30000 tokens) plus output allowance (4096) exceeds the 32768-token context of qwen3.6:35b-mlx';
    const before = run.events.slice(0, done);
    const failed: BoardEvent[] = [
      ...before,
      {
        ...nextEnvelope(before),
        type: 'agent_failed',
        round: 2,
        agentId: 'researcher',
        reason: 'invalid_request',
        detail,
      },
    ];
    const researcher = agentStatesOf(failed).find((a) => a.role === 'researcher');
    // Still in flight: running wins until the round completes.
    expect(researcher?.activity).toBe('running');
    const completed: BoardEvent[] = [
      ...failed,
      {
        ...nextEnvelope(failed),
        type: 'round_completed',
        round: 2,
        newEntries: 2,
        usage: usageOf([]),
      },
    ];
    expect(agentStatesOf(completed).find((a) => a.role === 'researcher')).toMatchObject({
      activity: 'failed',
      failure: { round: 2, reason: 'invalid_request', detail },
    });
    expect(agentStatesOf(completed).find((a) => a.role === 'solver')?.activity).toBe('idle');
  });

  it('counts every selection of the recorded run and leaves nobody running at its end', () => {
    const events = recordedEvents();
    const states = agentStatesOf(events);
    expect(states.reduce((sum, a) => sum + a.rounds, 0)).toBe(
      ofType(events, 'agents_selected').reduce((sum, e) => sum + e.selected.length, 0),
    );
    expect(states.every((a) => a.activity === 'idle')).toBe(true);
  });
});

describe('agentSpendOf', () => {
  const call = (overrides: Partial<ModelCallSummary>): ModelCallSummary => ({
    id: 'c',
    runId: 'r',
    round: 1,
    role: 'solver',
    modelId: 'm',
    billing: 'api',
    at: '2026-01-01T00:00:00.000Z',
    outcome: 'ok',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    estimateChars: 300,
    estimateCharsPerToken: 3,
    estimateTokens: 100,
    actualInputTokens: 100,
    latencyMs: 1_000,
    maxOutputTokens: 4096,
    error: null,
    warningsJson: '[]',
    source: 'trace',
    ...overrides,
  });

  it('adds up calls, tokens, cost and time per role, up to the round on screen', () => {
    const calls = [
      call({ id: 'a', round: 1 }),
      call({ id: 'b', round: 3, costUsd: 0.002, latencyMs: 3_000, cacheReadTokens: 50 }),
      call({
        id: 'c',
        round: 2,
        role: 'critic',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      }),
    ];
    const all = agentSpendOf(calls, null);
    expect(all.get('solver')).toMatchObject({ calls: 2, tokens: 290, latencyMs: 4_000 });
    expect(all.get('solver')?.costUsd).toBeCloseTo(0.003, 10);
    // A refused call cost nothing and read nothing, but it was a call.
    expect(all.get('critic')).toEqual({ calls: 1, costUsd: 0, tokens: 0, latencyMs: 1_000 });
    expect(all.get('planner')).toBeUndefined();
    expect(agentSpendOf(calls, 2).get('solver')).toMatchObject({ calls: 1, costUsd: 0.001 });
  });
});

describe('feedOf', () => {
  it('writes one line per event, naming entries by handle and linking them', async () => {
    const run = await scriptedRun((event, controller) => {
      if (event.type === 'round_completed' && event.round === 1) controller.requestPause();
    });
    await run.controller.run();
    await run.controller.injectNote({ content: 'Prefer SQLite', priority: 'high' });
    await run.controller.forceSynthesis();
    await run.controller.resume();
    await run.controller.run();
    const view = buildBoardView(run.controller.runId, run.events);
    const feed = feedOf(run.events, view);
    expect(feed.map((line) => line.seq)).toEqual(run.events.map((e) => e.seq));
    const titles = feed.map((line) => line.title);
    expect(titles.slice(0, 5)).toEqual([
      'Run started',
      'P1 · problem by you',
      'Round 1 started',
      'Selected: planner',
      'S1 · subproblem by planner',
    ]);
    expect(titles).toContain('Paused — at your request');
    expect(titles).toContain('N1 · note by you');
    expect(titles).toContain('You asked for a synthesis');
    expect(titles).toContain('Resumed');
    expect(titles).toContain('Selected: synthesizer, solver');
    expect(titles.at(-1)).toBe('Completed — answer reached');
    const note = feed.find((line) => line.title === 'N1 · note by you');
    expect(note).toMatchObject({ tone: 'accent', detail: 'Prefer SQLite' });
    expect(note?.entryId).toBe(view.byHandle('N1')?.id);
    expect(feed.find((line) => line.title === 'Selected: synthesizer, solver')?.detail).toBe(
      'synthesizer: forced by the user · solver: open subproblems or unexplained evidence',
    );
    expect(feed.find((line) => line.title === 'Round 1 completed')?.detail).toBe(
      '2 new entries · $0.0027 · 1.5K tokens',
    );
  });

  it('says why an agent failed, in the words the controller recorded', async () => {
    const run = await scriptedRun();
    const detail =
      'invalid_request: prompt (~30000 tokens) plus output allowance (4096) exceeds the 32768-token context of qwen3.6:35b-mlx';
    const events: BoardEvent[] = [
      ...run.events,
      {
        ...nextEnvelope(run.events),
        type: 'agent_failed',
        round: 1,
        agentId: 'solver',
        reason: 'invalid_request',
        detail,
      },
    ];
    const withWarning: BoardEvent[] = [
      ...events,
      { ...nextEnvelope(events), type: 'budget_warning', round: 1, spentUsd: 4.1, limitUsd: 5 },
    ];
    const feed = feedOf(withWarning, buildBoardView(run.controller.runId, withWarning));
    expect(feed.at(-2)).toMatchObject({
      tone: 'critical',
      title: 'solver failed: request refused',
      detail,
    });
    expect(feed.at(-1)).toMatchObject({
      tone: 'warning',
      title: 'Monthly budget warning',
      detail: '$4.10 of $5.00 spent this month',
    });
  });

  it('covers the recorded run without a gap', () => {
    const events = recordedEvents();
    const feed = feedOf(events, buildBoardView(recordedRunId(), events));
    expect(feed.length).toBe(134);
    expect(feed.at(-1)?.title).toBe('Completed — round limit reached');
    expect(feed.filter((line) => line.entryId !== null).length).toBe(96);
  });
});

describe('a round the host left in flight', () => {
  // The log a dying server left after selecting round 2's agents, then what recovery appends.
  const interruptedLog = async () => {
    const run = await scriptedRun();
    await run.controller.run();
    const cut = run.events.slice(
      0,
      run.events.findIndex((e) => e.type === 'agents_selected' && e.round === 2) + 1,
    );
    const usage = { ...zeroUsage(), inputTokens: 10, costUsd: 0.001 };
    const abandoned: BoardEvent = {
      ...nextEnvelope(cut),
      type: 'round_abandoned',
      round: 2,
      newEntries: 1,
      usage,
    };
    const withAbandoned = [...cut, abandoned];
    const paused: BoardEvent = {
      ...nextEnvelope(withAbandoned),
      type: 'run_paused',
      round: 2,
      reason: 'interrupted',
      totals: { rounds: 2, entries: 3, usage, elapsedMs: 0 },
    };
    return { runId: run.controller.runId, cut, events: [...withAbandoned, paused], usage };
  };

  it('counts as ended: the run is paused with nothing in flight and its usage is in the total', async () => {
    const { cut, events, usage } = await interruptedLog();
    expect(runStateOf(cut)).toMatchObject({ round: 2, completedRounds: 1, roundInFlight: true });
    expect(runStateOf(events)).toMatchObject({
      status: 'paused',
      reason: 'interrupted',
      round: 2,
      completedRounds: 2,
      roundInFlight: false,
    });
    expect(completedRounds(events)).toBe(2);
    expect(usageOf(events).costUsd).toBeCloseTo(usageOf(cut).costUsd + usage.costUsd, 10);
    expect(agentStatesOf(events).every((state) => state.activity !== 'running')).toBe(true);
  });

  it('is one warning line in the feed that says where the run goes on', async () => {
    const { runId, events } = await interruptedLog();
    const feed = feedOf(events, buildBoardView(runId, events));
    expect(feed.map((line) => line.seq)).toEqual(events.map((e) => e.seq));
    expect(feed.at(-2)).toMatchObject({
      tone: 'warning',
      title: 'Round 2 abandoned',
      detail: 'The process running it stopped after 1 entry; the run continues at round 3.',
    });
    expect(feed.at(-1)?.title).toBe('Paused — interrupted by a server restart');
  });
});
