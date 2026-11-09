import type { ZodType } from 'zod';

import type { BoardView } from '../board/board-view';
import type { Model, ModelError, ModelRequest, ModelResponse } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import type { Contribution } from '../schemas/contribution';
import type { AgentRole } from '../schemas/role';
import type { RunConfig } from '../schemas/run-config';
import { renderAgentPrompt, renderRepairPrompt } from './prompt';

// Controller-owned flags the triggers may read (docs/PLAN.md §2.3 steps 7–8).
export interface ControlFlags {
  stallDetected: boolean;
  criticForced: boolean;
  decisionRequired: boolean;
}

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
  models: ModelGateway;
}

// Result of evaluating an agent's trigger rules against the board.
export interface Trigger {
  eligible: boolean;
  priority: number;
  targetIds: readonly string[];
  reason: string;
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
});

export const notEligible = (reason: string): Trigger => ({
  eligible: false,
  priority: 0,
  targetIds: [],
  reason,
});

export interface AgentOutput {
  contributions: readonly Contribution[];
}

export type AgentError = { kind: 'model'; error: CallError };

export interface AgentResult {
  contributions: readonly Contribution[];
}

// An agent is a function of (boardView, config) → contributions (ADR-0005).
// It never sees another agent; its models are bound at construction from the roster.
export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly outputSchema: ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
  act(view: BoardView, ctx: AgentContext): Promise<Result<AgentResult, AgentError>>;
}

// What a role module declares; `createRoleAgent` binds it to models.
export interface RoleDefinition {
  readonly role: AgentRole;
  readonly outputSchema: ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
}

// The profile's choice for a role, plus the profile-wide fallback (ADR-0009).
export interface RoleModels {
  model: Model;
  fallback?: Model;
}

const accept = (response: ModelResponse<AgentOutput>): Result<AgentResult, AgentError> =>
  ok({ contributions: response.object.contributions });

const reject = (error: CallError): Result<AgentResult, AgentError> => err({ kind: 'model', error });

// The malformed-output path (docs/PLAN.md §2.3 step 5): validate → one repair attempt
// on the same model → the profile's fallback model → discard. Only schema failures take
// this path. Provider errors are classified by the provider layer and decided by the
// controller; retrying or falling back on them here would spend money blindly.
export const createRoleAgent = (definition: RoleDefinition, models: RoleModels): Agent => ({
  id: definition.role,
  role: definition.role,
  outputSchema: definition.outputSchema,
  trigger: (view, ctx) => definition.trigger(view, ctx),
  async act(view, ctx) {
    const { system, prompt } = renderAgentPrompt(definition.role, view, ctx);
    const request: ModelRequest<AgentOutput> = {
      schema: definition.outputSchema,
      system,
      prompt,
      maxOutputTokens: ctx.config.maxOutputTokens,
      tags: { role: definition.role, runId: ctx.runId, round: ctx.round },
    };
    const first = await ctx.models.call(models.model, request);
    if (first.ok) return accept(first.value);
    if (first.error.kind !== 'invalid_output') return reject(first.error);

    const repaired = await ctx.models.call(models.model, {
      ...request,
      prompt: renderRepairPrompt(prompt, first.error),
    });
    if (repaired.ok) return accept(repaired.value);
    if (repaired.error.kind !== 'invalid_output' || models.fallback === undefined) {
      return reject(repaired.error);
    }

    const fallback = await ctx.models.call(models.fallback, request);
    return fallback.ok ? accept(fallback.value) : reject(fallback.error);
  },
});
