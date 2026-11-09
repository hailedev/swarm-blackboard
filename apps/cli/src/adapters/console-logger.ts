import type { LogFields, Logger } from '@team/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const format = (level: LogLevel, message: string, fields: LogFields | undefined): string =>
  fields === undefined || Object.keys(fields).length === 0
    ? `[${level}] ${message}`
    : `[${level}] ${message} ${JSON.stringify(fields)}`;

// Line-oriented logger for the CLI. Never receives prompt or response contents:
// the controller logs ids, counts and reasons only (CLAUDE.md secrets rules).
export const createConsoleLogger = (
  write: (line: string) => void,
  minimum: LogLevel = 'warn',
): Logger => {
  const log =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (rank[level] >= rank[minimum]) write(format(level, message, fields));
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
};

/** Controller warnings the CLI already renders from board events; printing them too would repeat them. */
export const WARNINGS_RENDERED_FROM_EVENTS: ReadonlySet<string> = new Set([
  'agent failed',
  'agent output partly discarded',
  'monthly budget warning',
  'model call skipped: it cannot fit the cost cap',
]);

// What `pnpm solve` prints from the controller: warnings by default (for example the
// input-token estimate undershooting), minus the ones the board rendering already shows;
// everything from info up with --verbose.
export const createCliLogger = (write: (line: string) => void, verbose: boolean): Logger => {
  const base = createConsoleLogger(write, verbose ? 'info' : 'warn');
  return {
    ...base,
    warn: (message, fields) => {
      if (verbose || !WARNINGS_RENDERED_FROM_EVENTS.has(message)) base.warn(message, fields);
    },
  };
};
