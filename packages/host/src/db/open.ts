import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: Db;
  sqlite: Database.Database;
  /** The file path, or `:memory:`. */
  path: string;
  close(): void;
}

export const IN_MEMORY = ':memory:';

/** `file:./data/team.db` → `./data/team.db`; `:memory:` and plain paths pass through. */
export const databasePathFromUrl = (url: string): string => {
  const trimmed = url.trim();
  if (trimmed === '') return IN_MEMORY;
  if (trimmed.startsWith('file:')) return trimmed.slice('file:'.length) || IN_MEMORY;
  return trimmed;
};

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Open (creating if needed) the database named by DATABASE_URL and bring its schema up
 * to date with the committed migrations. Pragmas live here, not in the schema, so the
 * schema stays Postgres-portable (ADR-0007).
 */
export const openDatabase = (
  url: string,
  options: { migrationsFolder?: string } = {},
): OpenedDatabase => {
  const path = databasePathFromUrl(url);
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  if (path !== IN_MEMORY) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
  return {
    db,
    sqlite,
    path,
    close: () => {
      sqlite.close();
    },
  };
};
