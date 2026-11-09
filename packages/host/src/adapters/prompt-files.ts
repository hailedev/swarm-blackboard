import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AGENT_ROLES, err, ok, type AgentRole, type Result, type Roster } from '@team/core';

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'unknown error';

export type RolePrompts = Record<AgentRole, string>;

// Role prompts are documents, never inline code (CLAUDE.md). agents.yaml names one file
// per role; the paths are resolved relative to the roster file so `pnpm solve` works from
// any directory. Errors are one human-readable line for the terminal.
export const loadPromptFiles = async (
  roster: Roster,
  rosterPath: string,
): Promise<Result<RolePrompts, string>> => {
  const base = dirname(resolve(rosterPath));
  const prompts: Partial<RolePrompts> = {};
  for (const role of AGENT_ROLES) {
    const path = resolve(base, roster.agents[role].prompt);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      return err(`cannot read the ${role} prompt at ${path}: ${messageOf(cause)}`);
    }
    if (text.trim().length === 0) return err(`the ${role} prompt at ${path} is empty`);
    prompts[role] = text.trim();
  }
  return ok(prompts as RolePrompts);
};
