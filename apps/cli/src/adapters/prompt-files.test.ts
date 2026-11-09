import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_ROLES, type Roster } from '@team/core';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPromptFiles } from './prompt-files';
import { loadRosterFile } from './roster-file';
import { REPO_AGENTS_YAML } from './roster-file.test';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const rosterNaming = (prompt: string): Roster => ({
  defaultProfile: 'dev',
  models: {},
  profiles: {},
  agents: {
    planner: { prompt },
    researcher: { prompt },
    solver: { prompt },
    critic: { prompt },
    synthesizer: { prompt },
  },
});

describe('loadPromptFiles', () => {
  it('loads the five role prompts named in the repository agents.yaml', async () => {
    const roster = await loadRosterFile(REPO_AGENTS_YAML);
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    const prompts = await loadPromptFiles(roster.value, REPO_AGENTS_YAML);
    expect(prompts.ok).toBe(true);
    if (!prompts.ok) return;
    expect(Object.keys(prompts.value).sort()).toEqual([...AGENT_ROLES].sort());
    for (const role of AGENT_ROLES) {
      const text = prompts.value[role];
      expect(text.startsWith(`# ${role[0]?.toUpperCase() ?? ''}${role.slice(1)}`)).toBe(true);
      expect(text).toContain('Return only JSON matching the schema');
      expect(text).toContain('Never invent an id');
    }
  });

  it('reports a missing or empty prompt file as one line naming the role and the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-prompts-'));
    tempDirs.push(dir);
    const rosterPath = join(dir, 'agents.yaml');

    const missing = await loadPromptFiles(rosterNaming('prompts/none.md'), rosterPath);
    expect(!missing.ok && missing.error).toMatch(/^cannot read the planner prompt at .*none\.md: /);

    await writeFile(join(dir, 'empty.md'), '  \n');
    const empty = await loadPromptFiles(rosterNaming('empty.md'), rosterPath);
    expect(!empty.ok && empty.error).toMatch(/^the planner prompt at .*empty\.md is empty$/);
  });
});
