import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AGENT_ROLES, err, ok, type AgentRole, type Result, type Roster } from '@team/core';

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'unknown error';

export type RolePrompts = Record<AgentRole, string>;

// Role prompts are documents, never inline code (CLAUDE.md). agents.yaml names one file
// per role; the paths are resolved relative to the roster file so `pnpm solve` works from
// any directory. Errors are one human-readable line for the terminal.
const readPrompt = async (what: string, path: string): Promise<Result<string, string>> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    return err(`cannot read the ${what} prompt at ${path}: ${messageOf(cause)}`);
  }
  if (text.trim().length === 0) return err(`the ${what} prompt at ${path} is empty`);
  return ok(text.trim());
};

/**
 * The prompt of the final write-up, when agents.yaml names one (`writeUp.prompt`), resolved
 * like a role prompt; `undefined` when the roster has no such block, in which case the host
 * gives the controller nothing to write up with and a run ends on its last draft.
 */
export const loadWriteUpPrompt = async (
  roster: Roster,
  rosterPath: string,
): Promise<Result<string | undefined, string>> => {
  if (roster.writeUp === undefined) return ok(undefined);
  return readPrompt('write-up', resolve(dirname(resolve(rosterPath)), roster.writeUp.prompt));
};

export const loadPromptFiles = async (
  roster: Roster,
  rosterPath: string,
): Promise<Result<RolePrompts, string>> => {
  const base = dirname(resolve(rosterPath));
  const prompts: Partial<RolePrompts> = {};
  for (const role of AGENT_ROLES) {
    const text = await readPrompt(role, resolve(base, roster.agents[role].prompt));
    if (!text.ok) return text;
    prompts[role] = text.value;
  }
  return ok(prompts as RolePrompts);
};
