import type { AgentContext, ControlFlags, ModelGateway } from '../agents/agent';
import { defaultRunConfig, type RunConfigInput } from '../schemas/run-config';
import { RunConfigSchema } from '../schemas/run-config';

// A gateway with no budget: calls go straight to the model. For agent-level tests;
// the controller supplies the real, reserving gateway.
export const directGateway: ModelGateway = {
  call: (model, request) => model.generateObject(request),
};

export interface AgentContextOverrides {
  runId?: string;
  round?: number;
  config?: RunConfigInput;
  flags?: Partial<ControlFlags>;
  models?: ModelGateway;
}

export const agentContext = (overrides: AgentContextOverrides = {}): AgentContext => ({
  runId: overrides.runId ?? 'run',
  round: overrides.round ?? 1,
  config:
    overrides.config === undefined ? defaultRunConfig() : RunConfigSchema.parse(overrides.config),
  flags: { stallDetected: false, criticForced: false, decisionRequired: false, ...overrides.flags },
  models: overrides.models ?? directGateway,
});
