import {
  buildBoardView,
  createController,
  createDefaultAgents,
  describeRosterError,
  err,
  isoFromMs,
  ok,
  rehydrate,
  resolveProfile,
  type Agent,
  type AgentRole,
  type BoardEvent,
  type BoardView,
  type Clock,
  type Controller,
  type ControllerDeps,
  type ControllerError,
  type EntryOf,
  type HumanNoteInput,
  type IdGenerator,
  type Logger,
  type Model,
  type ProblemInput,
  type RehydrateError,
  type ResolvedModel,
  type Result,
  type Roster,
  type RunConfigInput,
  type RunProfile,
  type TraceSink,
} from '@team/core';
import {
  ModelCallStore,
  RunRepository,
  SqliteBoardStore,
  SqliteSpendLedger,
  type Db,
  type MonthlyBudgetSettings,
  type RolePrompts,
  type RunRecord,
} from '@team/host';

// One controller loop per run, in-process (docs/PLAN.md §6, Phase 3). The manager owns
// the live controllers, fans their events out to subscribers (SSE), and turns a paused
// run's event log back into a controller when it is resumed, stopped or annotated after
// the process that ran it has gone.

/** What the manager asks the host for when a run needs models. */
export interface ModelsRequest {
  profile: RunProfile;
  sink: TraceSink;
  charsPerToken: (resolved: ResolvedModel, providerDefault: number) => number | undefined;
  /** The run's live board once its controller exists; scripted stand-ins read it. */
  currentView: () => BoardView;
}

export interface RunModels {
  roles: Record<AgentRole, Model>;
  fallback: Model | undefined;
}

export type RunModelsSource = (
  request: ModelsRequest,
) => Promise<Result<RunModels, { message: string }>>;

export interface RunManagerDeps {
  db: Db;
  roster: Roster;
  prompts: RolePrompts;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  monthlyBudget: MonthlyBudgetSettings;
  models: RunModelsSource;
}

export interface StartRunInput {
  problem: ProblemInput;
  profile?: string;
  config?: RunConfigInput;
}

export type RunManagerError =
  | { kind: 'not_found' }
  /** The run is not in a state that allows the action (e.g. pausing a finished run). */
  | { kind: 'not_live'; status: string }
  | { kind: 'roster'; message: string }
  | { kind: 'models'; message: string }
  | { kind: 'rehydrate'; error: RehydrateError }
  | { kind: 'controller'; error: ControllerError };

type Listener = (event: BoardEvent) => void;

interface Handle {
  controller: Controller;
  loop: Promise<void> | null;
}

export class RunManager {
  readonly #deps: RunManagerDeps;
  readonly store: SqliteBoardStore;
  readonly calls: ModelCallStore;
  readonly ledger: SqliteSpendLedger;
  readonly runs: RunRepository;
  readonly #handles = new Map<string, Handle>();
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(deps: RunManagerDeps) {
    this.#deps = deps;
    this.store = new SqliteBoardStore(deps.db);
    this.calls = new ModelCallStore(deps.db, { ids: deps.ids, logger: deps.logger });
    this.ledger = new SqliteSpendLedger(deps.db);
    this.runs = new RunRepository(deps.db);
  }

  list(): RunRecord[] {
    return this.runs.list();
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Live events of a run as they are stored. The backlog comes from the store. */
  subscribe(runId: string, listener: Listener): () => void {
    const set = this.#listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(runId);
    };
  }

  /** Resolves once the run's loop has paused or ended (tests, graceful shutdown). */
  async settled(runId: string): Promise<void> {
    await this.#handles.get(runId)?.loop;
  }

  async start(input: StartRunInput): Promise<Result<RunRecord, RunManagerError>> {
    const profile = resolveProfile(this.#deps.roster, input.profile);
    if (!profile.ok) return err({ kind: 'roster', message: describeRosterError(profile.error) });
    const built = await this.#build(profile.value);
    if (!built.ok) return built;
    const controller = createController(this.#controllerDeps(profile.value, built.value.agents));
    built.value.attach(controller);
    const started = await controller.start(input.problem, input.config);
    if (!started.ok) return err({ kind: 'controller', error: started.error });
    this.#drive({ controller, loop: null });
    return this.#record(controller.runId);
  }

  async pause(runId: string): Promise<Result<RunRecord, RunManagerError>> {
    const handle = this.#live(runId);
    if (!handle.ok) return handle;
    handle.value.controller.requestPause();
    await handle.value.loop;
    return this.#record(runId);
  }

  async resume(runId: string): Promise<Result<RunRecord, RunManagerError>> {
    const handle = await this.#attach(runId);
    if (!handle.ok) return handle;
    const resumed = await handle.value.controller.resume();
    if (!resumed.ok) return err({ kind: 'controller', error: resumed.error });
    this.#drive(handle.value);
    return this.#record(runId);
  }

  async stop(runId: string): Promise<Result<RunRecord, RunManagerError>> {
    const handle = await this.#attach(runId);
    if (!handle.ok) return handle;
    const stopped = await handle.value.controller.stop();
    if (!stopped.ok) return err({ kind: 'controller', error: stopped.error });
    await handle.value.loop;
    return this.#record(runId);
  }

  async inject(
    runId: string,
    note: HumanNoteInput,
  ): Promise<Result<EntryOf<'human_note'>, RunManagerError>> {
    const handle = await this.#attach(runId);
    if (!handle.ok) return handle;
    const injected = await handle.value.controller.injectNote(note);
    return injected.ok ? injected : err({ kind: 'controller', error: injected.error });
  }

  /** Ask for a synthesis in the next round to start; a paused run takes it up on resume. */
  async forceSynthesis(runId: string): Promise<Result<RunRecord, RunManagerError>> {
    const handle = await this.#attach(runId);
    if (!handle.ok) return handle;
    const requested = await handle.value.controller.forceSynthesis();
    if (!requested.ok) return err({ kind: 'controller', error: requested.error });
    return this.#record(runId);
  }

  /**
   * At start-up: a run the database still shows as running belonged to a process that
   * died. Pause it as `interrupted` so it can be resumed from its log. Returns how many.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of this.runs.list()) {
      if (record.status !== 'running' || this.#handles.has(record.id)) continue;
      const events = await this.store.eventsFor(record.id);
      const state = rehydrate(events);
      if (!state.ok) {
        this.#deps.logger.error('cannot recover run', {
          runId: record.id,
          error: state.error.kind,
        });
        continue;
      }
      const paused: BoardEvent = {
        id: this.#deps.ids.next(),
        runId: record.id,
        seq: events.length,
        at: isoFromMs(this.#deps.clock.nowMs()),
        type: 'run_paused',
        round: state.value.completedRounds,
        reason: 'interrupted',
        totals: {
          rounds: state.value.completedRounds,
          entries: buildBoardView(record.id, events).entries.length,
          usage: state.value.usage,
          elapsedMs: state.value.elapsedMs,
        },
      };
      const stored = await this.store.append(paused);
      if (!stored.ok) {
        this.#deps.logger.error('cannot pause interrupted run', {
          runId: record.id,
          error: stored.error.kind,
        });
        continue;
      }
      this.#deps.logger.warn('run interrupted by the last shutdown; paused', { runId: record.id });
      count += 1;
    }
    return count;
  }

  #record(runId: string): Result<RunRecord, RunManagerError> {
    const record = this.runs.get(runId);
    return record === undefined ? err({ kind: 'not_found' }) : ok(record);
  }

  #live(runId: string): Result<Handle, RunManagerError> {
    const handle = this.#handles.get(runId);
    if (handle === undefined) {
      const record = this.runs.get(runId);
      return record === undefined
        ? err({ kind: 'not_found' })
        : err({ kind: 'not_live', status: record.status });
    }
    if (handle.controller.ended !== null) {
      return err({ kind: 'not_live', status: handle.controller.ended.status });
    }
    return ok(handle);
  }

  /** The in-memory handle, or a controller rebuilt from the log for a paused run. */
  async #attach(runId: string): Promise<Result<Handle, RunManagerError>> {
    const existing = this.#handles.get(runId);
    if (existing !== undefined) return ok(existing);
    const record = this.runs.get(runId);
    if (record === undefined) return err({ kind: 'not_found' });
    if (record.status !== 'paused') return err({ kind: 'not_live', status: record.status });
    const events = await this.store.eventsFor(runId);
    const state = rehydrate(events);
    if (!state.ok) return err({ kind: 'rehydrate', error: state.error });
    if (state.value.profile === null) {
      return err({
        kind: 'models',
        message: 'the run recorded no profile to rebuild its models from',
      });
    }
    const built = await this.#build(state.value.profile);
    if (!built.ok) return built;
    const controller = createController(
      this.#controllerDeps(state.value.profile, built.value.agents),
      { resume: state.value },
    );
    built.value.attach(controller);
    const handle: Handle = { controller, loop: null };
    this.#handles.set(runId, handle);
    return ok(handle);
  }

  async #build(
    profile: RunProfile,
  ): Promise<Result<{ agents: Agent[]; attach: (c: Controller) => void }, RunManagerError>> {
    let controller: Controller | undefined;
    const models = await this.#deps.models({
      profile,
      sink: this.calls.sink,
      charsPerToken: (resolved, providerDefault) =>
        this.calls.charsPerToken(resolved, providerDefault),
      currentView: () => {
        if (controller === undefined) throw new Error('the run has not started');
        return controller.currentView();
      },
    });
    if (!models.ok) return err({ kind: 'models', message: models.error.message });
    return ok({
      agents: createDefaultAgents(models.value.roles, this.#deps.prompts, models.value.fallback),
      attach: (c) => {
        controller = c;
      },
    });
  }

  #controllerDeps(profile: RunProfile, agents: readonly Agent[]): ControllerDeps {
    return {
      store: this.store,
      clock: this.#deps.clock,
      ids: this.#deps.ids,
      logger: this.#deps.logger,
      agents,
      periodBudget: profile.paid ? { ...this.#deps.monthlyBudget, ledger: this.ledger } : undefined,
      profile,
      onEvent: (event) => {
        for (const listener of this.#listeners.get(event.runId) ?? []) listener(event);
      },
    };
  }

  #drive(handle: Handle): void {
    const { controller } = handle;
    this.#handles.set(controller.runId, handle);
    handle.loop = controller
      .run()
      .then((result) => {
        if (!result.ok) {
          this.#deps.logger.error('run loop failed', {
            runId: controller.runId,
            error: result.error.kind,
          });
        }
      })
      .catch((cause: unknown) => {
        this.#deps.logger.error('run loop threw', {
          runId: controller.runId,
          message: cause instanceof Error ? cause.message : 'unknown error',
        });
      });
  }
}
