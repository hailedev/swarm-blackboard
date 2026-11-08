import type { ZodType } from 'zod';

import type { BoardView } from '../board/board-view';
import type { Model, ModelError } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import type { Contribution } from '../schemas/contribution';
import type { Usage } from '../schemas/common';
import type { RunConfig } from '../schemas/run-config';
import { renderAgentPrompt } from './prompt';

export const AGENT_ROLES = ['planner', 'researcher', 'solver', 'critic', 'synthesizer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// Controller-owned flags the triggers may read (docs/PLAN.md §2.3 steps 7–8).
export interface ControlFlags {
  stallDetected: boolean;
  criticForced: boolean;
  decisionRequired: boolean;
}

export interface AgentContext {
  runId: string;
  round: number;
  config: RunConfig;
  flags: ControlFlags;
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

export type AgentError = { kind: 'model'; error: ModelError };

export interface AgentResult {
  contributions: readonly Contribution[];
  usage: Usage;
}

// An agent is a function of (boardView, config) → contributions (ADR-0005).
// It never sees another agent; its model is bound at construction from the roster.
export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly outputSchema: ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
  act(view: BoardView, ctx: AgentContext): Promise<Result<AgentResult, AgentError>>;
}

// What a role module declares; `createRoleAgent` binds it to a model.
export interface RoleDefinition {
  readonly role: AgentRole;
  readonly outputSchema: ZodType<AgentOutput>;
  trigger(view: BoardView, ctx: AgentContext): Trigger;
}

export const createRoleAgent = (definition: RoleDefinition, model: Model): Agent => ({
  id: definition.role,
  role: definition.role,
  outputSchema: definition.outputSchema,
  trigger: (view, ctx) => definition.trigger(view, ctx),
  async act(view, ctx) {
    const { system, prompt } = renderAgentPrompt(definition.role, view, ctx);
    const response = await model.generateObject({
      schema: definition.outputSchema,
      system,
      prompt,
      tags: { role: definition.role, runId: ctx.runId, round: ctx.round },
    });
    if (!response.ok) return err({ kind: 'model', error: response.error });
    return ok({ contributions: response.value.object.contributions, usage: response.value.usage });
  },
});
