import type {
  Agent,
  AgentContext,
  AgentError,
  AgentResult,
  CallError,
  ControlFlags,
  ModelGateway,
} from '../agents/agent';
import { buildBoardView, type BoardView } from '../board/board-view';
import type { BoardStore, StoreError } from '../ports/board-store';
import { isoFromMs, type Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { Model, ModelError, ModelRequest, ModelResponse } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import type { PeriodBudget } from '../ports/spend-ledger';
import { addUsage, HUMAN_AUTHOR, promptTokens, zeroUsage, type Usage } from '../schemas/common';
import {
  HumanNoteEntrySchema,
  ProblemEntrySchema,
  type Entry,
  type EntryOf,
} from '../schemas/entry';
import type {
  AgentFailureReason,
  BoardEvent,
  EligibilityRecord,
  RunTotals,
} from '../schemas/event';
import type { HumanNotePriority } from '../schemas/payloads';
import type { RunProfile } from '../schemas/roster';
import { RunConfigSchema, type RunConfig, type RunConfigInput } from '../schemas/run-config';
import {
  isPauseReason,
  terminalStatusFor,
  type FailureReason,
  type PauseReason,
  type RunEnd,
  type RunEndReason,
  type RunStatus,
  type TerminalReason,
} from '../schemas/run-end';
import { BudgetTracker } from './budgets';
import { prepareEntries } from './commit';
import { ConflictTracker } from './conflict';
import { calendarMonth } from './period';
import type { RehydratedState, RunEndState } from './rehydrate';
import { estimateInputTokens, estimateUndershot, fitCall } from './reservation';
import { selectAgents } from './selection';
import { checkTermination, synthesisReady } from './termination';

export interface ProblemInput {
  content: string;
  constraints?: readonly string[];
  successCriteria?: readonly string[];
}

export interface HumanNoteInput {
  content: string;
  priority: HumanNotePriority;
}

export interface ControllerDeps {
  store: BoardStore;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  agents: readonly Agent[];
  /** Month-to-date guard for paid profiles. Omit for the dev profile: it spends nothing. */
  periodBudget?: PeriodBudget;
  /** Recorded on run_started so the run stays reproducible after agents.yaml changes. */
  profile?: RunProfile;
  /** Called synchronously after every event is stored (CLI printing now, SSE later). */
  onEvent?: (event: BoardEvent) => void;
}

export interface ControllerOptions {
  runId?: string;
  /** Pick a paused run up from its own log (controller/rehydrate.ts) instead of starting fresh. */
  resume?: RehydratedState;
}

export type ControllerError =
  | { kind: 'store'; error: StoreError }
  | { kind: 'ledger'; message: string }
  | { kind: 'not_started' }
  | { kind: 'already_started' }
  | { kind: 'not_paused' }
  | { kind: 'terminated'; reason: TerminalReason }
  | { kind: 'paused'; reason: PauseReason }
  | { kind: 'invalid_config'; issues: readonly string[] }
  | { kind: 'invalid_problem'; issues: readonly string[] }
  | { kind: 'invalid_note'; issues: readonly string[] }
  /** Refused before the first call: the run's cap would overrun the month's limit. */
  | {
      kind: 'monthly_budget';
      spentUsd: number;
      limitUsd: number;
      requestedCapUsd: number;
      fitsCapUsd: number;
    };

export interface AgentFailure {
  agentId: string;
  reason: AgentFailureReason;
  detail: string;
}

export interface RoundReport {
  round: number;
  eligible: readonly EligibilityRecord[];
  selected: readonly string[];
  committed: readonly Entry[];
  failures: readonly AgentFailure[];
  usage: Usage;
  ended: RunEnd | null;
}

export interface RunSummary {
  runId: string;
  rounds: number;
  status: RunStatus;
  reason: RunEndReason;
  totals: RunTotals;
  view: BoardView;
}

export interface Controller {
  readonly runId: string;
  start(
    problem: ProblemInput,
    config?: RunConfigInput,
  ): Promise<Result<EntryOf<'problem'>, ControllerError>>;
  /** One controller cycle (docs/PLAN.md §2.3). */
  runRound(): Promise<Result<RoundReport, ControllerError>>;
  /** Rounds until the run ends or pauses. */
  run(): Promise<Result<RunSummary, ControllerError>>;
  /** Pause after the round in flight, if any, has committed what it produced. */
  requestPause(): void;
  /** End the run as `user_stopped` after the round in flight, if any. */
  requestStop(): void;
  /** Pick a paused run up again; `run()` or `runRound()` then continues it. */
  resume(): Promise<Result<void, ControllerError>>;
  /** Commit a human note now; the next round sees it (docs/PLAN.md §2.3, human-in-the-loop). */
  injectNote(note: HumanNoteInput): Promise<Result<EntryOf<'human_note'>, ControllerError>>;
  currentView(): BoardView;
  readonly flags: Readonly<ControlFlags>;
  /** How the run has stopped, or null while it is live. */
  readonly ended: RunEnd | null;
  readonly completedRounds: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<BoardEvent, 'id' | 'runId' | 'seq' | 'at'>;

type AgentException = { kind: 'exception'; message: string };
type ActOutcome = Result<AgentResult, AgentError | AgentException>;

interface SettledCall {
  agentId: string;
  usage: Usage;
}

const usd = (amount: number): string => `$${amount.toFixed(4)}`;

const describeCallError = (error: CallError): string => {
  switch (error.kind) {
    case 'invalid_output':
      return `invalid output: ${error.issues.join('; ')}`;
    case 'billing':
    case 'auth':
    case 'invalid_request':
      return `${error.kind}: ${error.message}`;
    case 'rate_limit':
    case 'overloaded':
    case 'network':
      return `${error.kind} after ${String(error.attempts)} attempt(s): ${error.message}`;
    case 'script_exhausted':
      return `script exhausted after ${String(error.calls)} calls`;
    case 'budget_exhausted':
      return `budget exhausted: ${usd(error.remainingUsd)} left, the smallest useful call costs ${usd(error.worstCaseUsd)}`;
  }
};

const failureOf = (agentId: string, error: AgentError | AgentException): AgentFailure =>
  error.kind === 'exception'
    ? { agentId, reason: 'exception', detail: error.message }
    : { agentId, reason: error.error.kind, detail: describeCallError(error.error) };

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

const sumUsage = (calls: readonly SettledCall[]): Usage =>
  calls.reduce((total, call) => addUsage(total, call.usage), zeroUsage());

// After a round, the failures decide whether the run can go on (docs/budget-guardrails.md §4).
const fatalReason = (reasons: ReadonlySet<AgentFailureReason>): FailureReason | null =>
  reasons.has('billing') ? 'billing' : reasons.has('auth') ? 'auth' : null;

const pauseReason = (reasons: ReadonlySet<AgentFailureReason>): PauseReason | null =>
  reasons.has('rate_limit') || reasons.has('overloaded')
    ? 'rate_limit'
    : reasons.has('network')
      ? 'provider_unreachable'
      : null;

export const createController = (
  deps: ControllerDeps,
  options: ControllerOptions = {},
): Controller => {
  const resumed = options.resume;
  const runId = resumed?.runId ?? options.runId ?? deps.ids.next();
  const events: BoardEvent[] = resumed === undefined ? [] : [...resumed.events];
  const history: string[][] = resumed === undefined ? [] : resumed.history.map((h) => [...h]);
  const flags: ControlFlags =
    resumed === undefined
      ? { stallDetected: false, criticForced: false, decisionRequired: false }
      : { ...resumed.flags };
  const conflicts = resumed?.conflicts ?? new ConflictTracker();
  let view = buildBoardView(runId, events);
  let config: RunConfig | undefined = resumed?.config;
  let budgets: BudgetTracker | undefined =
    resumed === undefined
      ? undefined
      : new BudgetTracker(resumed.config, deps.clock, {
          usage: resumed.usage,
          rounds: resumed.completedRounds,
          elapsedMs: resumed.elapsedMs,
          running: resumed.ended === null,
        });
  let completedRounds = resumed?.completedRounds ?? 0;
  let consecutiveEmptyRounds = resumed?.consecutiveEmptyRounds ?? 0;
  let reframeUsed = resumed?.reframeUsed ?? false;
  let monthlyWarningSent = resumed?.monthlyWarningSent ?? false;
  let ended: RunEndState | null = resumed?.ended ?? null;
  let pauseRequested = false;
  // Read through functions: TypeScript would otherwise narrow these to `false` for the rest
  // of a round, while a callback may well set them while the round is in flight.
  const requested = { pause: (): boolean => pauseRequested, stop: (): boolean => stopRequested };
  let stopRequested = false;
  const profileName = deps.profile?.name ?? resumed?.profile?.name ?? null;

  // Events are appended one at a time, in order, whoever asks: a note injected while a
  // round is in flight queues behind the round's own events instead of colliding on seq.
  let chain: Promise<unknown> = Promise.resolve();
  const emit = (body: EventBody): Promise<Result<BoardEvent, ControllerError>> => {
    const task = chain.then(async (): Promise<Result<BoardEvent, ControllerError>> => {
      const event: BoardEvent = {
        id: deps.ids.next(),
        runId,
        seq: events.length,
        at: isoFromMs(deps.clock.nowMs()),
        ...body,
      };
      const stored = await deps.store.append(event);
      if (!stored.ok) return err({ kind: 'store', error: stored.error });
      events.push(event);
      view = buildBoardView(runId, events);
      deps.onEvent?.(event);
      return ok(event);
    });
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const totals = (tracker: BudgetTracker): RunTotals => ({
    rounds: completedRounds,
    entries: view.entries.length,
    usage: tracker.usage,
    elapsedMs: tracker.elapsedMs(),
  });

  // Month-to-date spend from the host's ledger, or null when no monthly budget applies.
  const monthToDate = async (): Promise<
    Result<{ spentUsd: number; budget: PeriodBudget } | null, ControllerError>
  > => {
    const budget = deps.periodBudget;
    if (budget === undefined) return ok(null);
    const period = calendarMonth(deps.clock.nowMs(), budget.timeZone);
    if (!period.ok) {
      return err({ kind: 'invalid_config', issues: [`unknown time zone "${budget.timeZone}"`] });
    }
    try {
      const spentUsd = await budget.ledger.spentUsd(period.value);
      return ok({ spentUsd, budget });
    } catch (cause) {
      // Fail closed: if we cannot see what the month has cost, we do not spend more.
      const message = cause instanceof Error ? cause.message : 'spend ledger unavailable';
      return err({ kind: 'ledger', message });
    }
  };

  const terminate = async (
    tracker: BudgetTracker,
    round: number,
    reason: TerminalReason,
  ): Promise<Result<void, ControllerError>> => {
    const status = terminalStatusFor(reason);
    ended = { status, reason };
    tracker.pause();
    deps.logger.info('run terminated', { runId, round, status, reason });
    const result = await emit({
      type: 'run_terminated',
      round,
      status,
      reason,
      totals: totals(tracker),
    });
    return result.ok ? ok(undefined) : result;
  };

  const pause = async (
    tracker: BudgetTracker,
    round: number,
    reason: PauseReason,
  ): Promise<Result<void, ControllerError>> => {
    ended = { status: 'paused', reason };
    pauseRequested = false;
    tracker.pause();
    deps.logger.info('run paused', { runId, round, reason });
    const result = await emit({ type: 'run_paused', round, reason, totals: totals(tracker) });
    return result.ok ? ok(undefined) : result;
  };

  const finish = (tracker: BudgetTracker, round: number, reason: RunEndReason) =>
    isPauseReason(reason) ? pause(tracker, round, reason) : terminate(tracker, round, reason);

  // The gateway every agent's model calls go through (docs/budget-guardrails.md §2).
  // Reservation happens synchronously before the first await, so parallel agents
  // cannot both claim the last cents.
  const gatewayFor = (
    tracker: BudgetTracker,
    runConfig: RunConfig,
    agentId: string,
    round: number,
    settled: SettledCall[],
  ): ModelGateway => ({
    async call<T>(
      model: Model,
      request: ModelRequest<T>,
    ): Promise<Result<ModelResponse<T>, CallError>> {
      const inputTokens = estimateInputTokens(request, model.charsPerToken);
      const requested = request.maxOutputTokens ?? runConfig.maxOutputTokens;
      const fit = fitCall({
        pricing: model.pricing,
        inputTokens,
        maxOutputTokens: requested,
        remainingUsd: tracker.remainingUsd(),
      });
      if (!fit.fits) {
        deps.logger.warn('model call skipped: it cannot fit the cost cap', {
          runId,
          round,
          agentId,
          modelId: model.id,
          remainingUsd: fit.remainingUsd,
          worstCaseUsd: fit.worstCaseUsd,
        });
        return err({
          kind: 'budget_exhausted',
          remainingUsd: fit.remainingUsd,
          worstCaseUsd: fit.worstCaseUsd,
        });
      }
      if (fit.shrunk) {
        deps.logger.info('output allowance shrunk to fit the cost cap', {
          runId,
          round,
          agentId,
          modelId: model.id,
          requested,
          granted: fit.maxOutputTokens,
        });
      }
      const reservation = tracker.reserve(fit.worstCaseUsd);
      let outcome: Result<ModelResponse<T>, ModelError> | undefined;
      try {
        outcome = await model.generateObject({ ...request, maxOutputTokens: fit.maxOutputTokens });
      } finally {
        if (outcome === undefined) tracker.release(reservation);
      }
      // On invalid_output the model answered, so the tokens were billed even though the
      // answer is unusable; on any other error nothing was billed.
      const usage = outcome.ok
        ? outcome.value.usage
        : outcome.error.kind === 'invalid_output'
          ? outcome.error.usage
          : null;
      if (usage === null) {
        tracker.release(reservation);
        return outcome;
      }
      tracker.settle(reservation, usage);
      settled.push({ agentId, usage });
      const actual = promptTokens(usage);
      if (estimateUndershot(inputTokens, actual)) {
        deps.logger.warn('input token estimate undershot by more than 20%', {
          runId,
          round,
          agentId,
          modelId: model.id,
          estimated: inputTokens,
          actual,
        });
      }
      return outcome;
    },
  });

  const runAgent = async (
    agent: Agent,
    roundView: BoardView,
    ctx: AgentContext,
  ): Promise<ActOutcome> => {
    try {
      return await agent.act(roundView, ctx);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'agent threw a non-Error value';
      return err({ kind: 'exception', message });
    }
  };

  const start: Controller['start'] = async (problem, configInput = {}) => {
    if (config !== undefined) return err({ kind: 'already_started' });
    const parsedConfig = RunConfigSchema.safeParse(configInput);
    if (!parsedConfig.success) {
      return err({ kind: 'invalid_config', issues: issuesOf(parsedConfig.error) });
    }
    const parsedProblem = ProblemEntrySchema.safeParse({
      id: deps.ids.next(),
      runId,
      type: 'problem',
      round: 0,
      author: HUMAN_AUTHOR,
      createdAt: isoFromMs(deps.clock.nowMs()),
      parents: [],
      status: 'active',
      content: problem.content,
      payload: {
        constraints: problem.constraints ?? [],
        successCriteria: problem.successCriteria ?? [],
      },
      usage: zeroUsage(),
    });
    if (!parsedProblem.success) {
      return err({ kind: 'invalid_problem', issues: issuesOf(parsedProblem.error) });
    }

    // Before the first call: would this run's cap overrun the month (docs/budget-guardrails.md §3)?
    const month = await monthToDate();
    if (!month.ok) return month;
    if (month.value !== null) {
      const { spentUsd, budget } = month.value;
      if (spentUsd + parsedConfig.data.maxCostUsd > budget.limitUsd) {
        return err({
          kind: 'monthly_budget',
          spentUsd,
          limitUsd: budget.limitUsd,
          requestedCapUsd: parsedConfig.data.maxCostUsd,
          fitsCapUsd: Math.max(0, budget.limitUsd - spentUsd),
        });
      }
    }

    config = parsedConfig.data;
    budgets = new BudgetTracker(config, deps.clock);
    const started = await emit({
      type: 'run_started',
      problemEntry: parsedProblem.data,
      config,
      profile: deps.profile ?? null,
    });
    if (!started.ok) return started;
    const committed = await emit({ type: 'entry_committed', round: 0, entry: parsedProblem.data });
    if (!committed.ok) return committed;
    deps.logger.info('run started', {
      runId,
      maxRounds: config.maxRounds,
      maxCostUsd: config.maxCostUsd,
      profile: profileName,
    });
    return ok(parsedProblem.data);
  };

  const runRound: Controller['runRound'] = async () => {
    if (config === undefined || budgets === undefined) return err({ kind: 'not_started' });
    if (ended !== null) {
      return ended.status === 'paused'
        ? err({ kind: 'paused', reason: ended.reason })
        : err({ kind: 'terminated', reason: ended.reason });
    }
    const runConfig = config;
    const tracker = budgets;
    const round = completedRounds + 1;
    const emptyReport = (end: RunEnd | null): RoundReport => ({
      round: completedRounds,
      eligible: [],
      selected: [],
      committed: [],
      failures: [],
      usage: zeroUsage(),
      ended: end,
    });

    // The user's wishes come first: a stop or pause asked for between rounds happens now.
    if (requested.stop()) {
      const stopped = await terminate(tracker, completedRounds, 'user_stopped');
      return stopped.ok ? ok(emptyReport(ended)) : stopped;
    }
    if (requested.pause()) {
      const paused = await pause(tracker, completedRounds, 'user_paused');
      return paused.ok ? ok(emptyReport(ended)) : paused;
    }

    // Budgets are checked before any model call is made: the run's own caps first…
    const preBudget = tracker.exceeded();
    if (preBudget !== null) {
      const stopped = await terminate(tracker, completedRounds, preBudget);
      return stopped.ok ? ok(emptyReport(ended)) : stopped;
    }
    // …then the month, re-read from the ledger every round.
    const month = await monthToDate();
    if (!month.ok) return month;
    if (month.value !== null) {
      const { spentUsd, budget } = month.value;
      if (spentUsd >= budget.limitUsd) {
        const paused = await pause(tracker, completedRounds, 'monthly_budget');
        return paused.ok ? ok(emptyReport(ended)) : paused;
      }
      if (!monthlyWarningSent && spentUsd >= budget.limitUsd * budget.warnAtFraction) {
        monthlyWarningSent = true;
        deps.logger.warn('monthly budget warning', { runId, spentUsd, limitUsd: budget.limitUsd });
        const warned = await emit({
          type: 'budget_warning',
          round: completedRounds,
          spentUsd,
          limitUsd: budget.limitUsd,
        });
        if (!warned.ok) return warned;
      }
    }

    const startedRound = await emit({ type: 'round_started', round });
    if (!startedRound.ok) return startedRound;

    // 1–2. Snapshot and eligibility.
    const roundView = view;
    const shared = { runId, round, config: runConfig, flags: { ...flags } };
    const evaluations = deps.agents.map((agent) => ({
      agent,
      trigger: agent.trigger(roundView, { ...shared, targetIds: [], models: unusedGateway }),
    }));
    const eligible: EligibilityRecord[] = evaluations
      .filter((e) => e.trigger.eligible)
      .map((e) => ({
        agentId: e.agent.id,
        priority: e.trigger.priority,
        reason: e.trigger.reason,
      }));

    // 4. Selection (rule-based priority; bidding is Phase 5).
    const selectedIds = selectAgents(
      evaluations.map((e) => ({ agentId: e.agent.id, trigger: e.trigger })),
      runConfig.parallelism,
      history,
    );
    history.push(selectedIds);
    const selected = selectedIds.flatMap((id) => {
      const found = evaluations.find((e) => e.agent.id === id);
      return found === undefined ? [] : [found];
    });
    const selectedAgents = selected.map((e) => e.agent);
    const selectedEvent = await emit({
      type: 'agents_selected',
      round,
      selected: selectedIds,
      eligible,
    });
    if (!selectedEvent.ok) return selectedEvent;

    // 5. Execution, in parallel, each agent seeing the same snapshot and reserving
    //    budget through its own gateway before its first call is dispatched.
    const settled: SettledCall[] = [];
    const results = await Promise.all(
      selected.map(({ agent, trigger }) =>
        runAgent(agent, roundView, {
          ...shared,
          targetIds: trigger.targetIds,
          models: gatewayFor(tracker, runConfig, agent.id, round, settled),
        }),
      ),
    );

    // 6. Commit, in selection order.
    const committed: Entry[] = [];
    const failures: AgentFailure[] = [];
    const critiqueTargets = new Set<string>();
    for (const [index, agent] of selectedAgents.entries()) {
      const result = results[index];
      if (result === undefined) continue;
      if (!result.ok) {
        const failure = failureOf(agent.id, result.error);
        failures.push(failure);
        deps.logger.warn('agent failed', { runId, round, ...failure });
        const failed = await emit({ type: 'agent_failed', round, ...failure });
        if (!failed.ok) return failed;
        continue;
      }
      const batch = prepareEntries({
        contributions: result.value.contributions,
        view,
        ids: deps.ids,
        runId,
        round,
        author: agent.id,
        createdAt: isoFromMs(deps.clock.nowMs()),
        usage: sumUsage(settled.filter((call) => call.agentId === agent.id)),
      });
      for (const entry of batch.entries) {
        const stored = await emit({ type: 'entry_committed', round, entry });
        if (!stored.ok) return stored;
        committed.push(entry);
        if (entry.type === 'critique') critiqueTargets.add(entry.payload.target);
      }
      if (batch.problems.length > 0) {
        const failure: AgentFailure = {
          agentId: agent.id,
          reason: 'invalid_links',
          detail: batch.problems.join(' | '),
        };
        failures.push(failure);
        deps.logger.warn('agent output partly discarded', { runId, round, ...failure });
        const failed = await emit({ type: 'agent_failed', round, ...failure });
        if (!failed.ok) return failed;
      }
    }

    completedRounds = round;
    tracker.recordRound();
    const roundUsage = sumUsage(settled);
    const roundDone = await emit({
      type: 'round_completed',
      round,
      newEntries: committed.length,
      usage: roundUsage,
    });
    if (!roundDone.ok) return roundDone;

    // 7. Conflict check → flags for the next round.
    const assessment = conflicts.assess(view, critiqueTargets);
    flags.criticForced = assessment.criticForced;
    flags.decisionRequired = assessment.decisionRequired;

    // 8. Termination: provider failures first, then the user's requests, then stall
    //    detection and the ordered checks.
    flags.stallDetected = false;
    consecutiveEmptyRounds = committed.length === 0 ? consecutiveEmptyRounds + 1 : 0;
    let stalled = false;
    if (consecutiveEmptyRounds >= runConfig.stallRounds) {
      if (reframeUsed) {
        stalled = true;
      } else {
        reframeUsed = true;
        flags.stallDetected = true;
        consecutiveEmptyRounds = 0;
        deps.logger.info('stall detected, allowing one reframe', { runId, round });
      }
    }
    const failureKinds = new Set(failures.map((f) => f.reason));
    const starved =
      selectedAgents.length > 0 &&
      failures.filter((f) => f.reason === 'budget_exhausted').length >= selectedAgents.length;
    const reason: RunEndReason | null =
      fatalReason(failureKinds) ??
      (requested.stop() ? 'user_stopped' : null) ??
      pauseReason(failureKinds) ??
      (requested.pause() ? 'user_paused' : null) ??
      checkTermination({
        view,
        config: runConfig,
        budget: tracker.exceeded(),
        starved,
        stalled,
        eligibleCount: eligible.length,
        decisionRequired: flags.decisionRequired,
      });
    if (reason === null && flags.decisionRequired && synthesisReady(view, runConfig)) {
      deps.logger.info('synthesis held back: a contradiction between hypotheses is undecided', {
        runId,
        round,
      });
    }
    deps.logger.info('round completed', {
      runId,
      round,
      selected: selectedIds,
      newEntries: committed.length,
      failures: failures.length,
      costUsd: tracker.usage.costUsd,
    });
    if (reason !== null) {
      const finished = await finish(tracker, round, reason);
      if (!finished.ok) return finished;
    }
    return ok({
      round,
      eligible,
      selected: selectedIds,
      committed,
      failures,
      usage: roundUsage,
      ended,
    });
  };

  const run: Controller['run'] = async () => {
    for (;;) {
      const report = await runRound();
      if (!report.ok) return report;
      if (report.value.ended !== null) break;
    }
    if (budgets === undefined || ended === null) return err({ kind: 'not_started' });
    return ok({
      runId,
      rounds: completedRounds,
      status: ended.status,
      reason: ended.reason,
      totals: totals(budgets),
      view,
    });
  };

  const resume: Controller['resume'] = async () => {
    if (config === undefined || budgets === undefined) return err({ kind: 'not_started' });
    if (ended === null || ended.status !== 'paused') return err({ kind: 'not_paused' });
    const from = ended.reason;
    const resumedEvent = await emit({ type: 'run_resumed', round: completedRounds, from });
    if (!resumedEvent.ok) return err(resumedEvent.error);
    ended = null;
    pauseRequested = false;
    budgets.resume();
    deps.logger.info('run resumed', { runId, round: completedRounds, from });
    return ok(undefined);
  };

  const injectNote: Controller['injectNote'] = async (note) => {
    if (config === undefined) return err({ kind: 'not_started' });
    if (ended !== null && ended.status !== 'paused') {
      return err({ kind: 'terminated', reason: ended.reason });
    }
    const problem = view.problem();
    const parsed = HumanNoteEntrySchema.safeParse({
      id: deps.ids.next(),
      runId,
      type: 'human_note',
      round: completedRounds,
      author: HUMAN_AUTHOR,
      createdAt: isoFromMs(deps.clock.nowMs()),
      parents: problem === undefined ? [] : [problem.id],
      status: 'active',
      content: note.content,
      payload: { priority: note.priority },
      usage: zeroUsage(),
    });
    if (!parsed.success) return err({ kind: 'invalid_note', issues: issuesOf(parsed.error) });
    const stored = await emit({
      type: 'entry_committed',
      round: completedRounds,
      entry: parsed.data,
    });
    if (!stored.ok) return err(stored.error);
    deps.logger.info('human note injected', {
      runId,
      round: completedRounds,
      entryId: parsed.data.id,
    });
    return ok(parsed.data);
  };

  return {
    runId,
    start,
    runRound,
    run,
    requestPause: () => {
      pauseRequested = true;
    },
    requestStop: () => {
      stopRequested = true;
    },
    resume,
    injectNote,
    currentView: () => view,
    get flags(): Readonly<ControlFlags> {
      return { ...flags };
    },
    get ended(): RunEnd | null {
      return ended;
    },
    get completedRounds(): number {
      return completedRounds;
    },
  };
};

// Triggers are pure functions over the board and never call a model; this gateway
// exists only so the context handed to them is complete.
const unusedGateway: ModelGateway = {
  call: () =>
    Promise.resolve(err({ kind: 'invalid_request', message: 'triggers must not call models' })),
};
