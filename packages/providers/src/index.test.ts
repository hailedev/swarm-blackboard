import { UsageSchema } from '@team/core';
import { describe, expect, it } from 'vitest';

import { createFakeModel } from './index';

describe('@team/providers', () => {
  it('exposes FakeModel from the provider layer', async () => {
    const model = createFakeModel({
      script: [
        {
          object: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: 0,
          },
        },
      ],
    });
    const result = await model.generateObject({
      schema: UsageSchema,
      system: '',
      prompt: '',
      tags: { role: 'planner', runId: 'run', round: 0 },
    });
    expect(result.ok && result.value.object.outputTokens).toBe(2);
  });
});
