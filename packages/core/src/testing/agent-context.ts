import {
  noControlFlags,
  type AgentContext,
  type ControlFlags,
  type ModelGateway,
} from '../agents/agent';
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
  targetIds?: readonly string[];
  models?: ModelGateway;
}

export const agentContext = (overrides: AgentContextOverrides = {}): AgentContext => ({
  runId: overrides.runId ?? 'run',
  round: overrides.round ?? 1,
  config:
    overrides.config === undefined ? defaultRunConfig() : RunConfigSchema.parse(overrides.config),
  flags: { ...noControlFlags(), ...overrides.flags },
  targetIds: overrides.targetIds ?? [],
  models: overrides.models ?? directGateway,
});
