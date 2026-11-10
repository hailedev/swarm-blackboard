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
}

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
  outputSchema(refs: ModelReferenceSchemas): ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
}

// The profile's choice for a role, plus the profile-wide fallback (ADR-0009).
export interface RoleModels {
  model: Model;
  fallback?: Model;
}

const reject = (error: CallError): Result<AgentResult, AgentError> => err({ kind: 'model', error });

// One call, with the model's handles mapped back to entry ids before anyone else sees the
// contributions. The enum came from the same view, so an unknown handle means a bug rather
// than a model error, but it takes the schema-failure path all the same.
const callAndResolve = async (
  ctx: AgentContext,
  model: Model,
  request: ModelRequest<AgentOutput>,
  view: BoardView,
): Promise<Result<AgentResult, CallError>> => {
  const response = await ctx.models.call(model, request);
  if (!response.ok) return err(response.error);
  const resolved = resolveHandles(response.value.object.contributions, view);
  if (resolved.ok) return ok({ contributions: resolved.value });
  return err({
    kind: 'invalid_output',
    issues: resolved.error,
    raw: JSON.stringify(response.value.object),
    usage: response.value.usage,
  });
};

// The malformed-output path (docs/PLAN.md §2.3 step 5): validate → one repair attempt
// on the same model → the profile's fallback model → discard. Only schema failures take
// this path. Provider errors are classified by the provider layer and decided by the
// controller; retrying or falling back on them here would spend money blindly.
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
    const first = await callAndResolve(ctx, models.model, request, view);
    if (first.ok) return first;
    if (first.error.kind !== 'invalid_output') return reject(first.error);

    const repaired = await callAndResolve(
      ctx,
      models.model,
      { ...request, prompt: renderRepairPrompt(request.prompt, first.error) },
      view,
    );
    if (repaired.ok) return repaired;
    if (repaired.error.kind !== 'invalid_output' || models.fallback === undefined) {
      return reject(repaired.error);
    }

    const fallback = await callAndResolve(ctx, models.fallback, request, view);
    return fallback.ok ? fallback : reject(fallback.error);
  },
});
