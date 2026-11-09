import type { RunProfile } from '@team/core';
import { describe, expect, it } from 'vitest';

import type { Fetch } from './ollama-preflight';
import { PRICE_TABLE } from './pricing';
import { createProfileModels, describeProfileModelsError, localTags } from './profile-models';

const haiku = { alias: 'haiku', provider: 'anthropic' as const, model: 'claude-haiku-5-5' };
const local = { alias: 'local', provider: 'ollama' as const, model: 'qwen3.6:35b-a3b-q8_0' };
const localThink = { ...local, alias: 'local-think', think: true };

const cheap: RunProfile = {
  name: 'cheap',
  roles: {
    planner: haiku,
    researcher: local,
    solver: localThink,
    critic: haiku,
    synthesizer: haiku,
  },
  bidder: haiku,
  fallback: haiku,
  paid: true,
};
const dev: RunProfile = {
  name: 'dev',
  roles: { planner: local, researcher: local, solver: local, critic: local, synthesizer: local },
  bidder: null,
  fallback: null,
  paid: false,
};
const allPaid: RunProfile = {
  ...cheap,
  roles: { planner: haiku, researcher: haiku, solver: haiku, critic: haiku, synthesizer: haiku },
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const ollamaUp: Fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.40.15' }));
  return Promise.resolve(json({ done: true }));
};

const base = { ollamaBaseUrl: 'http://mini:11434', priceTable: PRICE_TABLE };

describe('localTags', () => {
  it('lists each local model once and ignores paid ones', () => {
    expect(localTags(cheap)).toEqual(['qwen3.6:35b-a3b-q8_0']);
    expect(localTags(dev)).toEqual(['qwen3.6:35b-a3b-q8_0']);
    expect(localTags(allPaid)).toEqual([]);
    expect(localTags({ ...allPaid, fallback: { ...local, model: 'other:7b' } })).toEqual([
      'other:7b',
    ]);
  });
});

describe('createProfileModels', () => {
  it('builds every role and the fallback, then checks and warms the local tags', async () => {
    const progress: string[] = [];
    const result = await createProfileModels(cheap, {
      ...base,
      anthropicApiKey: 'sk-test',
      preflight: { fetch: ollamaUp },
      onProgress: (line) => progress.push(line),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roles.planner.billing).toBe('api');
    expect(result.value.roles.researcher.billing).toBe('local');
    expect(result.value.roles.researcher.id).toBe('qwen3.6:35b-a3b-q8_0');
    expect(result.value.fallback?.id).toBe('claude-haiku-5-5');
    // One model per alias: the solver's thinking alias is a different instance.
    expect(result.value.roles.planner === result.value.roles.critic).toBe(true);
    expect(result.value.roles.researcher === result.value.roles.solver).toBe(false);
    expect(result.value.ollama).toEqual({ version: '0.40.15', models: ['qwen3.6:35b-a3b-q8_0'] });
    expect(progress).toEqual([
      'Checking Ollama at http://mini:11434 and warming qwen3.6:35b-a3b-q8_0…',
      'Ollama 0.40.15 is ready.',
    ]);
  });

  it('skips the pre-flight when told to, and when nothing is local', async () => {
    const skipped = await createProfileModels(dev, { ...base, preflight: false });
    expect(skipped.ok && skipped.value.ollama).toBeNull();
    expect(skipped.ok && skipped.value.fallback).toBeUndefined();
    const nothingLocal = await createProfileModels(allPaid, {
      ...base,
      anthropicApiKey: 'sk-test',
      preflight: { fetch: () => Promise.reject(new Error('must not be called')) },
    });
    expect(nothingLocal.ok && nothingLocal.value.ollama).toBeNull();
  });

  it('reports a missing API key before touching Ollama', async () => {
    const result = await createProfileModels(cheap, {
      ...base,
      preflight: { fetch: () => Promise.reject(new Error('must not be called')) },
    });
    expect(!result.ok && result.error.kind).toBe('factory');
    if (!result.ok) expect(describeProfileModelsError(result.error)).toContain('ANTHROPIC_API_KEY');
  });

  it('reports an unreachable Ollama server as a described error', async () => {
    const result = await createProfileModels(dev, {
      ...base,
      preflight: { fetch: () => Promise.reject(new Error('ECONNREFUSED')), timeoutMs: 10 },
    });
    expect(!result.ok && result.error.kind).toBe('ollama');
    if (!result.ok) {
      expect(describeProfileModelsError(result.error)).toContain(
        'unreachable at http://mini:11434',
      );
    }
  });
});
