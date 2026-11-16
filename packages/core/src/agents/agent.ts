import type { ZodType } from 'zod';

import type { BoardView } from '../board/board-view';
import type { Model, ModelError, ModelRequest, ModelResponse } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import type {
  Contribution,
  ModelContribution,
  ModelReferenceSchemas,
} from '../schemas/contribution';
import type { AgentRole } from '../schemas/role';
import type { RunConfig } from '../schemas/run-config';
import { buildAgentRequest, resolveHandles } from './handles';
import { renderRepairPrompt } from './prompt';

// Controller-owned flags the triggers may read (docs/PLAN.md §2.3 steps 7–8).
export interface ControlFlags {
  stallDetected: boolean;
  criticForced: boolean;
  decisionRequired: boolean;
  /** The user asked for a synthesis; on for the one round that serves the request. */
  synthesisForced: boolean;
}

export const noControlFlags = (): ControlFlags => ({
  stallDetected: false,
  criticForced: false,
  decisionRequired: false,
  synthesisForced: false,
});

// A call the controller refused because it could not fit the remaining cost cap
// even with the output allowance shrunk to the floor (docs/budget-guardrails.md §2).
export type CallError =
  ModelError | { kind: 'budget_exhausted'; remainingUsd: number; worstCaseUsd: number };

// Every model call an agent makes goes through the controller's gateway, which
// reserves budget before dispatch and records usage after. Budgets are enforced
// here, in code, not in prompts (CLAUDE.md architecture rule 4).
export interface ModelGateway {
  call<T>(model: Model, request: ModelRequest<T>): Promise<Result<ModelResponse<T>, CallError>>;
}

export interface AgentContext {
  runId: string;
  round: number;
  config: RunConfig;
  flags: ControlFlags;
  /** Entries the agent's trigger matched this round; empty while triggers are evaluated. */
  targetIds: readonly string[];
  models: ModelGateway;
}

// Result of evaluating an agent's trigger rules against the board.
export interface Trigger {
  eligible: boolean;
  priority: number;
  targetIds: readonly string[];
  reason: string;
  /** Selected ahead of every other agent and exempt from the diversity rule. */
  mandatory: boolean;
}

export const eligible = (
  priority: number,
  targetIds: readonly string[],
  reason: string,
): Trigger => ({
  eligible: true,
  priority,
  targetIds,
  reason,
  mandatory: false,
});

export const notEligible = (reason: string): Trigger => ({
  eligible: false,
  priority: 0,
  targetIds: [],
  reason,
  mandatory: false,
});

/** Priority recorded for a mandatory trigger; selection puts it first whatever the number. */
export const MANDATORY_PRIORITY = 100;

/** Eligible and certain to be selected this round, e.g. because the user asked for it. */
export const mandatory = (targetIds: readonly string[], reason: string): Trigger => ({
  eligible: true,
  priority: MANDATORY_PRIORITY,
  targetIds,
  reason,
  mandatory: true,
});

/** What a model returns: references by handle and paragraphs until `resolveHandles` runs. */
export interface AgentOutput {
  contributions: readonly ModelContribution[];
}

export type AgentError = { kind: 'model'; error: CallError };

/** What an agent hands the controller: contributions whose references are entry ids. */
export interface AgentResult {
  contributions: readonly Contribution[];
  /** Set when the model returned more than the role may post and the rest was dropped. */
  trimmed?: Trimmed;
}

export interface Trimmed {
  kept: number;
  dropped: number;
  /** The contributions were ranked before the cut (the Critic's: most severe first). */
  ranked: boolean;
}

/**
 * How many contributions a role may post in one call, and which to keep when a model
 * returns more. A reply over the limit is not rejected: the first `max` are kept, after
 * ranking when the role has an order of importance. Rejecting it threw away the whole
 * call, repair and fallback included: Anthropic's structured output drops `maxItems` from
 * the schema, so the model never saw the limit, and 16 of the 27 Critic calls of the
 * step2a runs were lost that way.
 */
export interface RoleLimit {
  max: number;
  /** Most important first. Ties keep the model's own order. */
  rank?: (a: Contribution, b: Contribution) => number;
}

/**
 * The bound a role's schema puts on its array instead of the role's own limit: generous
 * enough that an over-long reply still validates and can be trimmed, finite so that a
 * local model decoding against the schema's grammar cannot run on for ever.
 */
export const CONTRIBUTIONS_SCHEMA_MAX = 24;

/** The first `limit.max` contributions, ranked first if the role ranks, and what was cut. */
export const keepWithinLimit = (
  limit: RoleLimit | undefined,
  contributions: readonly Contribution[],
): AgentResult => {
  if (limit === undefined || contributions.length <= limit.max) return { contributions };
  const rank = limit.rank;
  const ordered =
    rank === undefined
      ? contributions
      : contributions
          .map((contribution, index) => ({ contribution, index }))
          .sort((a, b) => rank(a.contribution, b.contribution) || a.index - b.index)
          .map(({ contribution }) => contribution);
  return {
    contributions: ordered.slice(0, limit.max),
    trimmed: {
      kept: limit.max,
      dropped: contributions.length - limit.max,
      ranked: rank !== undefined,
    },
  };
};

// An agent is a function of (boardView, config) → contributions (ADR-0005).
// It never sees another agent; its models are bound at construction from the roster.
export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
  act(view: BoardView, ctx: AgentContext): Promise<Result<AgentResult, AgentError>>;
}

// What a role module declares; `createRoleAgent` binds it to models. The output schema is
// built per call from the references the agent's view names (agents/handles.ts).
export interface RoleDefinition {
  readonly role: AgentRole;
  /** Absent for a role whose schema already fixes the count (the Synthesizer's one synthesis). */
  readonly limit?: RoleLimit;
  /**
   * The schema for one call. `flags` are the controller's for the round: a role may admit
   * something only while a flag is on (the Synthesizer's decisions, while one is owed).
   */
  outputSchema(refs: ModelReferenceSchemas, flags?: ControlFlags): ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
}

// The profile's choice for a role, plus the profile-wide fallback (ADR-0009).
export interface RoleModels {
  model: Model;
  fallback?: Model;
}

const reject = (error: CallError): Result<AgentResult, AgentError> => err({ kind: 'model', error });

/**
 * The malformed-output path (docs/PLAN.md §2.3 step 5), for any structured call: validate →
 * one repair attempt on the same model → the profile's fallback model → give up. `resolve`
 * turns the model's object into what the caller wants (handles into entry ids); what it
 * rejects takes the schema-failure path like any other invalid output, with its issues in
 * the repair prompt. Only schema failures take this path. Provider errors are classified by
 * the provider layer and decided by the controller; retrying or falling back on them here
 * would spend money blindly. Every attempt goes through the gateway, so each is fitted to
 * the budget that is left and may be refused.
 */
export const callWithRepair = async <T, R>(
  gateway: ModelGateway,
  models: RoleModels,
  request: ModelRequest<T>,
  resolve: (object: T) => Result<R, string[]>,
): Promise<Result<R, CallError>> => {
  const attempt = async (
    model: Model,
    attempted: ModelRequest<T>,
  ): Promise<Result<R, CallError>> => {
    const response = await gateway.call(model, attempted);
    if (!response.ok) return err(response.error);
    const resolved = resolve(response.value.object);
    if (resolved.ok) return ok(resolved.value);
    return err({
      kind: 'invalid_output',
      issues: resolved.error,
      raw: JSON.stringify(response.value.object),
      usage: response.value.usage,
    });
  };

  const first = await attempt(models.model, request);
  if (first.ok || first.error.kind !== 'invalid_output') return first;

  const repaired = await attempt(models.model, {
    ...request,
    prompt: renderRepairPrompt(request.prompt, first.error),
  });
  if (repaired.ok) return repaired;
  if (repaired.error.kind !== 'invalid_output' || models.fallback === undefined) return repaired;

  return attempt(models.fallback, request);
};

// An agent's call: the model's handles are mapped back to entry ids before anyone else sees
// the contributions. The enum came from the same view, so an unknown handle means a bug
// rather than a model error, but it takes the schema-failure path all the same.
export const createRoleAgent = (
  definition: RoleDefinition,
  models: RoleModels,
  rolePrompt: string,
): Agent => ({
  id: definition.role,
  role: definition.role,
  trigger: (view, ctx) => definition.trigger(view, ctx),
  async act(view, ctx) {
    const built = buildAgentRequest(definition, view, ctx, rolePrompt);
    if (!built.ok) {
      return reject({
        kind: 'invalid_request',
        message: 'nothing on the board is visible to this agent, so it has nothing to link to',
      });
    }
    const request: ModelRequest<AgentOutput> = {
      schema: built.value.schema,
      system: built.value.system,
      prompt: built.value.prompt,
      maxOutputTokens: ctx.config.maxOutputTokens,
      tags: { role: definition.role, runId: ctx.runId, round: ctx.round },
    };
    const result = await callWithRepair(ctx.models, models, request, (object) =>
      resolveHandles(object.contributions, view),
    );
    return result.ok ? ok(keepWithinLimit(definition.limit, result.value)) : reject(result.error);
  },
});
