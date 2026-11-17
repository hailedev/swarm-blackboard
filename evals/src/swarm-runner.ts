import {
  AGENT_ROLES,
  createController,
  createDefaultAgents,
  err,
  latestSynthesis,
  ok,
  type AgentRole,
  type BoardEvent,
  type Controller,
  type ControllerDeps,
  type ControllerError,
  type Model,
  type Result,
  type TraceSink,
} from '@team/core';
import { createScriptedModels } from '@team/core/testing';
import { traceModel } from '@team/providers';

import { loopFigures } from './loop';
import type { SwarmOutcome, SwarmWriteUp } from './pass';
import type { Problem } from './problems';

// One swarm run on one problem, as the eval commands make it: a controller on the host's
// store with the profile's models, the run capped in dollars, its final write-up given an
// output allowance, and what came of it read back from the board, the event log and the
// traced calls. Shared by `pnpm eval` (cli.ts) and `pnpm eval:measure` (measure-cli.ts).

export interface SwarmModels {
  roles: Record<AgentRole, Model>;
  fallback: Model | undefined;
}

export interface SwarmRunnerDeps extends Pick<
  ControllerDeps,
  'store' | 'clock' | 'ids' | 'logger' | 'periodBudget' | 'profile'
> {
  models: SwarmModels;
  /** The role prompts, as the host loaded them. */
  prompts: Parameters<typeof createDefaultAgents>[1];
  /** The write-up's system prompt; undefined ends a run on its last draft. */
  writeUpPrompt: string | undefined;
  /** The run's traced calls, for the loop figures. */
  calls: { forRun(runId: string): readonly { outcome: string }[] };
  /** Told of each controller before it starts: scripted models read its board. */
  onController?: ((controller: Controller) => void) | undefined;
}

/**
 * Runs the swarm on a problem under a cost cap; the controller enforces the cap.
 * `writeUpMaxOutputTokens` is the output allowance of the run's final write-up; null
 * leaves the run's default.
 */
export type RunSwarm = (
  problem: Problem,
  maxCostUsd: number,
  writeUpMaxOutputTokens: number | null,
) => Promise<Result<SwarmOutcome, string>>;

/** A controller error in one line, with the issues of a refused config rather than its kind alone. */
export const describeControllerError = (error: ControllerError): string => {
  switch (error.kind) {
    case 'invalid_config':
    case 'invalid_problem':
    case 'invalid_note':
      return `${error.kind}: ${error.issues.join('; ')}`;
    case 'monthly_budget':
      return `monthly_budget: ${error.spentUsd.toFixed(4)} of ${error.limitUsd.toFixed(2)} spent, a cap of ${error.requestedCapUsd.toFixed(4)} does not fit`;
    case 'ledger':
      return `ledger: ${error.message}`;
    case 'store':
      return `store: ${error.error.kind}`;
    case 'terminated':
    case 'paused':
      return `${error.kind}: ${error.reason}`;
    case 'not_started':
    case 'already_started':
    case 'not_paused':
      return error.kind;
  }
};

/** The final write-up's call as the run's log has it, or null when it never started. */
export const writeUpOf = (events: readonly BoardEvent[]): SwarmWriteUp | null => {
  const started = events.findLast((e) => e.type === 'write_up_started');
  if (started?.type !== 'write_up_started') return null;
  const completed = events.findLast((e) => e.type === 'write_up_completed');
  const done = completed?.type === 'write_up_completed' ? completed : undefined;
  return {
    maxOutputTokens: started.maxOutputTokens,
    wordBudget: started.wordBudget,
    written: (done?.newEntries ?? 0) > 0,
    costUsd: done?.usage.costUsd ?? 0,
    attempts: done?.attempts ?? 1,
    short: done?.short ?? false,
    retriedFor: done?.retriedFor ?? [],
    leaks: done?.leaks ?? [],
  };
};

/**
 * Why a run's answer is not its write-up: what the controller logged against the
 * Synthesizer after the last round ended, or that no write-up was attempted at all.
 */
export const writeUpFailureOf = (events: readonly BoardEvent[]): string => {
  const lastRound = events.map((e) => e.type).lastIndexOf('round_completed');
  const failure = events
    .slice(lastRound + 1)
    .findLast((e) => e.type === 'agent_failed' && e.agentId === 'synthesizer');
  if (failure?.type === 'agent_failed') return `${failure.reason}: ${failure.detail}`;
  return events.some((e) => e.type === 'write_up_started')
    ? 'the write-up committed nothing'
    : 'no final write-up was attempted';
};

export const createSwarmRunner =
  (deps: SwarmRunnerDeps): RunSwarm =>
  async (problem, maxCostUsd, writeUpMaxOutputTokens) => {
    const agents = createDefaultAgents(deps.models.roles, deps.prompts, deps.models.fallback);
    const events: BoardEvent[] = [];
    const controller = createController({
      store: deps.store,
      clock: deps.clock,
      ids: deps.ids,
      logger: deps.logger,
      agents,
      // The run ends with the Synthesizer's model writing the answer (docs/PLAN.md §2.3 step 9).
      writeUp:
        deps.writeUpPrompt === undefined
          ? undefined
          : {
              model: deps.models.roles.synthesizer,
              fallback: deps.models.fallback,
              prompt: deps.writeUpPrompt,
            },
      periodBudget: deps.periodBudget,
      profile: deps.profile,
      onEvent: (event) => events.push(event),
    });
    deps.onController?.(controller);
    const started = await controller.start(
      {
        content: problem.statement,
        constraints: problem.constraints,
        successCriteria: problem.successCriteria,
      },
      {
        maxCostUsd,
        // The other arm's output allowance, so the write-up is asked for the same words.
        ...(writeUpMaxOutputTokens === null
          ? {}
          : { writeUp: { maxOutputTokens: writeUpMaxOutputTokens } }),
      },
    );
    if (!started.ok) return err(`could not start: ${describeControllerError(started.error)}`);
    const result = await controller.run();
    if (!result.ok) return err(`run failed: ${describeControllerError(result.error)}`);
    const synthesis = latestSynthesis(result.value.view);
    const stage = synthesis?.payload.stage ?? null;
    return ok({
      runId: result.value.runId,
      answer: synthesis?.content ?? null,
      confidence: synthesis?.payload.confidence ?? null,
      stage,
      writeUp: writeUpOf(events),
      writeUpFailure: stage === 'final' ? null : writeUpFailureOf(events),
      loop: loopFigures(result.value.view, events, deps.calls.forRun(result.value.runId)),
      rounds: result.value.rounds,
      status: result.value.status,
      reason: result.value.reason,
      entries: result.value.totals.entries,
      usage: result.value.totals.usage,
      costUsd: result.value.totals.usage.costUsd,
      elapsedMs: result.value.totals.elapsedMs,
    });
  };

/**
 * The scripted swarm of `--fake`: every role answers from the board of the controller it
 * was last told of (`onController`), traced like a real model and billed as `fake`.
 */
export const createScriptedSwarm = (
  sink: TraceSink,
  now: () => number,
): { models: SwarmModels; onController: (controller: Controller) => void } => {
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const scripted = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  });
  return {
    models: {
      roles: Object.fromEntries(
        AGENT_ROLES.map((role) => [role, traceModel(scripted[role], sink, now)]),
      ) as Record<AgentRole, Model>,
      fallback: undefined,
    },
    onController: (controller) => {
      ref.controller = controller;
    },
  };
};
