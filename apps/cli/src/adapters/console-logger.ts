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
