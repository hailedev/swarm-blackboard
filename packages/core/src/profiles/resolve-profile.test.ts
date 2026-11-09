import { describe, expect, it } from 'vitest';

import { RosterSchema } from '../schemas/roster';

import { describeRosterError, loadRoster, resolveProfile } from './resolve-profile';

// A roster in the shape of agents.yaml (docs/budget-guardrails.md §1), not a copy of it:
// here the Solver thinks and `quality` has no bidder, to exercise those paths.
const roster = {
  defaultProfile: 'dev',
  models: {
    sonnet: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    haiku: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    local: { provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
    'local-think': { provider: 'ollama', model: 'qwen3.6:35b-mlx', think: true },
  },
  profiles: {
    dev: {
      fallback: 'none',
      roles: {
        planner: 'local',
        researcher: 'local',
        solver: 'local-think',
        critic: 'local',
        synthesizer: 'local',
        bidder: 'local',
      },
    },
    cheap: {
      fallback: 'haiku',
      roles: {
        planner: 'haiku',
        researcher: 'local',
        solver: 'local-think',
        critic: 'haiku',
        synthesizer: 'haiku',
        bidder: 'haiku',
      },
    },
    quality: {
      fallback: 'haiku',
      roles: {
        planner: 'haiku',
        researcher: 'local',
        solver: 'local-think',
        critic: 'sonnet',
        synthesizer: 'sonnet',
      },
    },
  },
  agents: {
    planner: { prompt: 'prompts/planner.md' },
    researcher: { prompt: 'prompts/researcher.md' },
    solver: { prompt: 'prompts/solver.md' },
    critic: { prompt: 'prompts/critic.md' },
    synthesizer: { prompt: 'prompts/synthesizer.md' },
  },
};

const withProfile = (name: string, profile: unknown) => ({
  ...roster,
  profiles: { ...roster.profiles, [name]: profile },
});

const load = (raw: unknown) => {
  const result = loadRoster(raw);
  if (!result.ok) throw new Error(describeRosterError(result.error));
  return result.value;
};

describe('loadRoster', () => {
  it('accepts the documented roster', () => {
    expect(loadRoster(roster).ok).toBe(true);
  });

  it('rejects a malformed file with the schema issues', () => {
    const result = loadRoster({
      ...roster,
      models: { sonnet: { provider: 'openai', model: 'x' } },
    });
    expect(!result.ok && result.error.kind).toBe('invalid_roster');
    expect(!result.ok && describeRosterError(result.error)).toContain('models.sonnet.provider');
  });

  it('rejects an unknown default profile and lists the valid ones', () => {
    const result = loadRoster({ ...roster, defaultProfile: 'prod' });
    expect(!result.ok && result.error).toEqual({
      kind: 'unknown_default_profile',
      name: 'prod',
      known: ['dev', 'cheap', 'quality'],
    });
  });

  it('rejects a role or fallback that names an unknown model alias', () => {
    const badRole = loadRoster(
      withProfile('dev', {
        ...roster.profiles.dev,
        roles: { ...roster.profiles.dev.roles, critic: 'opus' },
      }),
    );
    expect(!badRole.ok && badRole.error).toMatchObject({
      kind: 'unknown_model_alias',
      profile: 'dev',
      role: 'critic',
      alias: 'opus',
    });
    const badFallback = loadRoster(
      withProfile('cheap', { ...roster.profiles.cheap, fallback: 'opus' }),
    );
    expect(!badFallback.ok && badFallback.error).toMatchObject({
      kind: 'unknown_fallback_alias',
      profile: 'cheap',
      alias: 'opus',
    });
  });

  it('rejects a local-only profile whose fallback is a paid model', () => {
    const result = loadRoster(withProfile('dev', { ...roster.profiles.dev, fallback: 'haiku' }));
    expect(!result.ok && result.error).toEqual({
      kind: 'paid_fallback_on_local_profile',
      profile: 'dev',
      fallback: 'haiku',
    });
    expect(!result.ok && describeRosterError(result.error)).toContain('fallback: none');
  });

  it('allows a paid fallback once any role, including the bidder, is paid', () => {
    const bidderOnly = withProfile('dev', {
      fallback: 'haiku',
      roles: { ...roster.profiles.dev.roles, bidder: 'haiku' },
    });
    expect(loadRoster(bidderOnly).ok).toBe(true);
  });
});

describe('resolveProfile', () => {
  it('resolves the default profile to local models with no fallback and no spend', () => {
    const result = resolveProfile(load(roster));
    expect(result.ok && result.value).toEqual({
      name: 'dev',
      roles: {
        planner: { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
        researcher: { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
        solver: { alias: 'local-think', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: true },
        critic: { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
        synthesizer: { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
      },
      bidder: { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-mlx', think: false },
      fallback: null,
      paid: false,
    });
  });

  it('marks a profile paid when any model is on the API provider', () => {
    const result = resolveProfile(load(roster), 'quality');
    expect(result.ok && result.value.paid).toBe(true);
    expect(result.ok && result.value.fallback).toEqual({
      alias: 'haiku',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
    expect(result.ok && result.value.roles.critic.model).toBe('claude-sonnet-5-5');
    expect(result.ok && result.value.bidder).toBeNull();
  });

  it('rejects an unknown profile name with the list of valid ones', () => {
    const result = resolveProfile(load(roster), 'prod');
    expect(!result.ok && result.error).toEqual({
      kind: 'unknown_profile',
      name: 'prod',
      known: ['dev', 'cheap', 'quality'],
    });
    expect(!result.ok && describeRosterError(result.error)).toBe(
      'unknown profile "prod"; valid profiles are "dev", "cheap", "quality"',
    );
  });
});

describe('resolveProfile on a roster that skipped loadRoster', () => {
  const odd = (profile: unknown) =>
    RosterSchema.parse({ ...roster, defaultProfile: 'odd', profiles: { odd: profile } });

  it('still refuses an unknown role alias', () => {
    const result = resolveProfile(
      odd({ fallback: 'none', roles: { ...roster.profiles.dev.roles, critic: 'phantom' } }),
    );
    expect(!result.ok && result.error).toMatchObject({
      kind: 'unknown_model_alias',
      profile: 'odd',
      role: 'critic',
      alias: 'phantom',
    });
    expect(!result.ok && describeRosterError(result.error)).toContain(
      'unknown model alias "phantom"',
    );
  });

  it('checks the bidder and the fallback aliases too', () => {
    const bidder = resolveProfile(
      odd({ fallback: 'none', roles: { ...roster.profiles.dev.roles, bidder: 'spectre' } }),
    );
    expect(!bidder.ok && bidder.error).toMatchObject({
      kind: 'unknown_model_alias',
      role: 'bidder',
      alias: 'spectre',
    });
    const fallback = resolveProfile(odd({ fallback: 'ghost', roles: roster.profiles.dev.roles }));
    expect(!fallback.ok && fallback.error).toMatchObject({
      kind: 'unknown_fallback_alias',
      alias: 'ghost',
    });
    expect(!fallback.ok && describeRosterError(fallback.error)).toContain(
      'falls back to the unknown model alias "ghost"',
    );
  });
});
