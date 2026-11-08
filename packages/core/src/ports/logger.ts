export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const noop = (): undefined => undefined;

export const nullLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
