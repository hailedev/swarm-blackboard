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

  it('reports a missing file, a syntax error and a roster rule as one line each', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-roster-'));
    tempDirs.push(dir);

    const missing = await loadRosterFile(join(dir, 'nope.yaml'));
    expect(!missing.ok && missing.error).toMatch(/^cannot read .*nope\.yaml: /);

    const broken = join(dir, 'broken.yaml');
    await writeFile(broken, 'models:\n  - oops\n');
    const syntax = await loadRosterFile(broken);
    expect(!syntax.ok && syntax.error).toMatch(
      /broken\.yaml: line 2: sequences are not supported$/,
    );

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
