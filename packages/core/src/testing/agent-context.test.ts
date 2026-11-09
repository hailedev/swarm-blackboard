import { describe, expect, it } from 'vitest';

import { agentContext } from './agent-context';

describe('agentContext', () => {
  it('defaults to round 1 with default config and no flags', () => {
    const ctx = agentContext();
    expect(ctx.round).toBe(1);
    expect(ctx.config.maxRounds).toBe(12);
    expect(ctx.flags).toEqual({
      stallDetected: false,
      criticForced: false,
      decisionRequired: false,
      synthesisForced: false,
    });
    expect(ctx.targetIds).toEqual([]);
  });

  it('applies overrides', () => {
    const ctx = agentContext({
      round: 4,
      config: { maxRounds: 5 },
      flags: { criticForced: true },
      targetIds: ['t1'],
    });
    expect(ctx.round).toBe(4);
    expect(ctx.config.maxRounds).toBe(5);
    expect(ctx.flags.criticForced).toBe(true);
    expect(ctx.flags.stallDetected).toBe(false);
    expect(ctx.targetIds).toEqual(['t1']);
  });
});
