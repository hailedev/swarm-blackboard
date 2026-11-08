import { describe, expect, it } from 'vitest';

import { createFakeModel } from '../model/fake-model';
import { AGENT_ROLES } from './agent';
import { createDefaultAgents } from './roster';

describe('createDefaultAgents', () => {
  it('binds one agent per role, in roster order', () => {
    const model = createFakeModel({ script: [] });
    const agents = createDefaultAgents({
      planner: model,
      researcher: model,
      solver: model,
      critic: model,
      synthesizer: model,
    });
    expect(agents.map((a) => a.id)).toEqual([...AGENT_ROLES]);
    expect(agents.map((a) => a.role)).toEqual([...AGENT_ROLES]);
  });
});
