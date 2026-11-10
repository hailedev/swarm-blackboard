import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRosterFile } from './roster-file';

export const REPO_AGENTS_YAML = fileURLToPath(new URL('../../../../agents.yaml', import.meta.url));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadRosterFile', () => {
  it('loads the repository agents.yaml, whose default profile spends nothing', async () => {
    const result = await loadRosterFile(REPO_AGENTS_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultProfile).toBe('dev');
    expect(Object.keys(result.value.profiles)).toEqual(['dev', 'cheap', 'quality']);
    expect(result.value.profiles['dev']?.fallback).toBe('none');
    expect(
      Object.values(result.value.profiles['dev']?.roles ?? {}).every(
        (alias) => result.value.models[alias]?.provider === 'ollama',
      ),
    ).toBe(true);
  });

  it('keeps the fast local build to dev and the trialled one to the paid profiles', async () => {
    // ADR-0008, amendment of 2026-11-10: `dev` runs on `local-fast`; the worker roles of
    // `cheap` and `quality` stay on `local` until the Phase 5 evals compare the two.
    const result = await loadRosterFile(REPO_AGENTS_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { models, profiles } = result.value;
    expect(models['local-fast']).toEqual({
      provider: 'ollama',
      model: 'qwen3.6:35b-mlx',
      think: false,
    });
    expect(models['local']?.model).toBe('qwen3.6:35b-a3b-q8_0');
    expect(new Set(Object.values(profiles['dev']?.roles ?? {}))).toEqual(new Set(['local-fast']));
    for (const name of ['cheap', 'quality']) {
      expect(profiles[name]?.roles.researcher).toBe('local');
      expect(profiles[name]?.roles.solver).toBe('local');
      expect(Object.values(profiles[name]?.roles ?? {})).not.toContain('local-fast');
    }
  });

  it('reports a missing file, a syntax error and a roster rule as one line each', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-roster-'));
    tempDirs.push(dir);

    const missing = await loadRosterFile(join(dir, 'nope.yaml'));
    expect(!missing.ok && missing.error).toMatch(/^cannot read .*nope\.yaml: /);

    const broken = join(dir, 'broken.yaml');
    await writeFile(broken, 'models: {\n  local: oops\n');
    const syntax = await loadRosterFile(broken);
    expect(!syntax.ok && syntax.error).toMatch(/broken\.yaml: \S/);
    expect(!syntax.ok && syntax.error).not.toContain('\n');

    const unknown = join(dir, 'unknown.yaml');
    await writeFile(
      unknown,
      [
        'defaultProfile: prod',
        'models:',
        '  local: { provider: ollama, model: m }',
        'profiles:',
        '  dev:',
        '    fallback: none',
        '    roles: { planner: local, researcher: local, solver: local, critic: local, synthesizer: local }',
        'agents:',
        '  planner: { prompt: p }',
        '  researcher: { prompt: p }',
        '  solver: { prompt: p }',
        '  critic: { prompt: p }',
        '  synthesizer: { prompt: p }',
      ].join('\n'),
    );
    const rule = await loadRosterFile(unknown);
    expect(!rule.ok && rule.error).toMatch(
      /defaultProfile "prod" is not defined; profiles are "dev"$/,
    );
  });
});

describe('thinking on the Claude aliases (ADR-0013)', () => {
  it('turns thinking off for sonnet and haiku and keeps thinking aliases for experiments', async () => {
    const result = await loadRosterFile(REPO_AGENTS_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { models } = result.value;
    expect(models['sonnet']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      think: false,
    });
    expect(models['haiku']).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      think: false,
    });
    expect(models['sonnet-think']?.think).toBe(true);
    expect(models['haiku-think']?.think).toBe(true);
  });
});
