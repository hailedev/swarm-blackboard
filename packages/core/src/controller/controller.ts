import type { Agent, AgentContext, AgentError, AgentResult, ControlFlags } from '../agents/agent';
import { buildBoardView, type BoardView } from '../board/board-view';
import type { BoardStore, StoreError } from '../ports/board-store';
import { isoFromMs, type Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { ModelError } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import { addUsage, HUMAN_AUTHOR, zeroUsage, type Usage } from '../schemas/common';
import { ProblemEntrySchema, type Entry, type EntryOf } from '../schemas/entry';
import type {
  AgentFailureReason,
  BoardEvent,
  EligibilityRecord,
  RunTotals,
  TerminationReason,
} from '../schemas/event';
import { RunConfigSchema, type RunConfig, type RunConfigInput } from '../schemas/run-config';
import { BudgetTracker } from './budgets';
import { prepareEntries } from './commit';
import { ConflictTracker } from './conflict';
import { selectAgents } from './selection';
import { checkTermination } from './termination';

export interface ProblemInput {
  content: string;
  constraints?: readonly string[];
  successCriteria?: readonly string[];
}

export interface ControllerDeps {
  store: BoardStore;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  agents: readonly Agent[];
  /** Called synchronously after every event is stored (CLI printing now, SSE later). */
  onEvent?: (event: BoardEvent) => void;
}

export type ControllerError =
  | { kind: 'store'; error: StoreError }
  | { kind: 'not_started' }
  | { kind: 'already_started' }
  | { kind: 'terminated'; reason: TerminationReason }
  | { kind: 'invalid_config'; issues: readonly string[] }
  | { kind: 'invalid_problem'; issues: readonly string[] };

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
  terminated: TerminationReason | null;
}

export interface RunSummary {
  runId: string;
  rounds: number;
  reason: TerminationReason;
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
  /** Rounds until a termination condition holds. */
  run(): Promise<Result<RunSummary, ControllerError>>;
  currentView(): BoardView;
  readonly flags: Readonly<ControlFlags>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<BoardEvent, 'id' | 'runId' | 'seq' | 'at'>;

const describeModelError = (error: ModelError): string => {
  switch (error.kind) {
    case 'invalid_output':
      return `invalid output: ${error.issues.join('; ')}`;
    case 'provider_error':
      return `provider error: ${error.message}`;
    case 'timeout':
      return `timed out after ${String(error.afterMs)} ms`;
    case 'script_exhausted':
      return `script exhausted after ${String(error.calls)} calls`;
  }
};

const failureReason = (error: AgentError): AgentFailureReason =>
  error.error.kind === 'invalid_output' ? 'invalid_output' : 'model_error';

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

export const createController = (
  deps: ControllerDeps,
  options: { runId?: string } = {},
): Controller => {
  const runId = options.runId ?? deps.ids.next();
  const events: BoardEvent[] = [];
  const history: string[][] = [];
  const flags: ControlFlags = {
    stallDetected: false,
    criticForced: false,
    decisionRequired: false,
  };
  const conflicts = new ConflictTracker();
  let view = buildBoardView(runId, []);
  let config: RunConfig | undefined;
  let budgets: BudgetTracker | undefined;
  let completedRounds = 0;
  let consecutiveEmptyRounds = 0;
  let reframeUsed = false;
  let terminated: TerminationReason | null = null;

  const emit = async (body: EventBody): Promise<Result<BoardEvent, ControllerError>> => {
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
  };

  const totals = (tracker: BudgetTracker): RunTotals => ({
    rounds: completedRounds,
    entries: view.entries.length,
    usage: tracker.usage,
    elapsedMs: tracker.elapsedMs(),
  });

  const terminate = async (
    tracker: BudgetTracker,
    round: number,
    reason: TerminationReason,
  ): Promise<Result<void, ControllerError>> => {
    terminated = reason;
    deps.logger.info('run terminated', { runId, round, reason });
    const result = await emit({ type: 'run_terminated', round, reason, totals: totals(tracker) });
    return result.ok ? ok(undefined) : result;
  };

  const runAgent = async (
    agent: Agent,
    roundView: BoardView,
    ctx: AgentContext,
  ): Promise<Result<AgentResult, AgentError>> => {
    try {
      return await agent.act(roundView, ctx);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'agent threw a non-Error value';
      return err({ kind: 'model', error: { kind: 'provider_error', message } });
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
    config = parsedConfig.data;
    budgets = new BudgetTracker(config, deps.clock);
    const started = await emit({ type: 'run_started', problemEntry: parsedProblem.data, config });
    if (!started.ok) return started;
    const committed = await emit({ type: 'entry_committed', round: 0, entry: parsedProblem.data });
    if (!committed.ok) return committed;
    deps.logger.info('run started', { runId, maxRounds: config.maxRounds });
    return ok(parsedProblem.data);
  };

  const runRound: Controller['runRound'] = async () => {
    if (config === undefined || budgets === undefined) return err({ kind: 'not_started' });
    if (terminated !== null) return err({ kind: 'terminated', reason: terminated });
    const tracker = budgets;
    const round = completedRounds + 1;
    const emptyReport = (terminatedBy: TerminationReason | null): RoundReport => ({
      round: completedRounds,
      eligible: [],
      selected: [],
      committed: [],
      failures: [],
      usage: zeroUsage(),
      terminated: terminatedBy,
    });

    // Budgets are checked before any model call is made.
    const preBudget = tracker.exceeded();
    if (preBudget !== null) {
      const reason: TerminationReason = `budget:${preBudget}`;
      const ended = await terminate(tracker, completedRounds, reason);
      return ended.ok ? ok(emptyReport(reason)) : ended;
    }

    const startedRound = await emit({ type: 'round_started', round });
    if (!startedRound.ok) return startedRound;

    // 1–2. Snapshot and eligibility.
    const roundView = view;
    const ctx: AgentContext = { runId, round, config, flags: { ...flags } };
    const evaluations = deps.agents.map((agent) => ({
      agent,
      trigger: agent.trigger(roundView, ctx),
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
      config.parallelism,
      history,
    );
    history.push(selectedIds);
    const selectedAgents = selectedIds.flatMap((id) => {
      const found = evaluations.find((e) => e.agent.id === id);
      return found === undefined ? [] : [found.agent];
    });
    const selectedEvent = await emit({
      type: 'agents_selected',
      round,
      selected: selectedIds,
      eligible,
    });
    if (!selectedEvent.ok) return selectedEvent;

    // 5. Execution, in parallel, each agent seeing the same snapshot.
    const results = await Promise.all(
      selectedAgents.map((agent) => runAgent(agent, roundView, ctx)),
    );

    // 6. Commit, in selection order.
    const committed: Entry[] = [];
    const failures: AgentFailure[] = [];
    const critiqueTargets = new Set<string>();
    let roundUsage = zeroUsage();
    for (const [index, agent] of selectedAgents.entries()) {
      const result = results[index];
      if (result === undefined) continue;
      if (!result.ok) {
        const failure: AgentFailure = {
          agentId: agent.id,
          reason: failureReason(result.error),
          detail: describeModelError(result.error.error),
        };
        failures.push(failure);
        deps.logger.warn('agent failed', { runId, round, ...failure });
        const failed = await emit({ type: 'agent_failed', round, ...failure });
        if (!failed.ok) return failed;
        continue;
      }
      roundUsage = addUsage(roundUsage, result.value.usage);
      tracker.recordUsage(result.value.usage);
      const batch = prepareEntries({
        contributions: result.value.contributions,
        view,
        ids: deps.ids,
        runId,
        round,
        author: agent.id,
        createdAt: isoFromMs(deps.clock.nowMs()),
        usage: result.value.usage,
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

    // 8. Termination: stall detection, then the ordered checks.
    flags.stallDetected = false;
    consecutiveEmptyRounds = committed.length === 0 ? consecutiveEmptyRounds + 1 : 0;
    let stalled = false;
    if (consecutiveEmptyRounds >= config.stallRounds) {
      if (reframeUsed) {
        stalled = true;
      } else {
        reframeUsed = true;
        flags.stallDetected = true;
        consecutiveEmptyRounds = 0;
        deps.logger.info('stall detected, allowing one reframe', { runId, round });
      }
    }
    const reason = checkTermination({
      view,
      config,
      budget: tracker.exceeded(),
      stalled,
      eligibleCount: eligible.length,
    });
    deps.logger.info('round completed', {
      runId,
      round,
      selected: selectedIds,
      newEntries: committed.length,
      failures: failures.length,
    });
    if (reason !== null) {
      const ended = await terminate(tracker, round, reason);
      if (!ended.ok) return ended;
    }
    return ok({
      round,
      eligible,
      selected: selectedIds,
      committed,
      failures,
      usage: roundUsage,
      terminated: reason,
    });
  };

  const run: Controller['run'] = async () => {
    for (;;) {
      const report = await runRound();
      if (!report.ok) return report;
      if (report.value.terminated !== null) break;
    }
    if (budgets === undefined || terminated === null) return err({ kind: 'not_started' });
    return ok({
      runId,
      rounds: completedRounds,
      reason: terminated,
      totals: totals(budgets),
      view,
    });
  };

  return {
    runId,
    start,
    runRound,
    run,
    currentView: () => view,
    get flags(): Readonly<ControlFlags> {
      return { ...flags };
    },
  };
};
