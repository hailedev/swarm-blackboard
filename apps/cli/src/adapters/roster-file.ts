import { readFile } from 'node:fs/promises';

import { describeRosterError, err, loadRoster, type Result, type Roster } from '@team/core';

import { parseYamlSubset } from './yaml-subset';

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'unknown error';

/** Read and validate agents.yaml. Errors are one human-readable line for the terminal. */
export const loadRosterFile = async (path: string): Promise<Result<Roster, string>> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    return err(`cannot read ${path}: ${messageOf(cause)}`);
  }
  let raw: unknown;
  try {
    raw = parseYamlSubset(text);
  } catch (cause) {
    return err(`${path}: ${messageOf(cause)}`);
  }
  const roster = loadRoster(raw);
  return roster.ok ? roster : err(`${path}: ${describeRosterError(roster.error)}`);
};
