import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Model, TraceSink } from '@team/core';
import {
  createUuidV7Generator,
  databasePathFromUrl,
  IN_MEMORY,
  ModelCallStore,
  openDatabase,
  systemClock,
} from '@team/host';

import { traceModel } from './trace';

// Test-only support for the `*.llm.test.ts` contract tests: every call they make is
// recorded in the same model_calls table the CLI and the server write (ADR-0010), so a
// paid test call counts against the month like any other. `@team/host` is a dev
// dependency of this package for exactly this file; nothing under src/ that ships to a
// consumer may import it.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface LlmTestLedger {
  /** Where the calls are going. */
  path: string;
  /** Wrap a model so each attempt is recorded, and optionally seen by the test too. */
  recorded(model: Model, also?: TraceSink): Model;
  close(): void;
}

/** Opens DATABASE_URL (default data/team.db at the repository root), never an in-memory stand-in. */
export const openLlmTestLedger = (): LlmTestLedger => {
  const path = databasePathFromUrl(process.env['DATABASE_URL'] ?? 'file:./data/team.db');
  const absolute = path === IN_MEMORY || isAbsolute(path) ? path : resolve(REPO_ROOT, path);
  const opened = openDatabase(absolute);
  const store = new ModelCallStore(opened.db, { ids: createUuidV7Generator(systemClock) });
  return {
    path: opened.path,
    recorded: (model, also) =>
      traceModel(model, (trace) => {
        store.sink(trace);
        also?.(trace);
      }),
    close: () => {
      opened.close();
    },
  };
};
