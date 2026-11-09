// pnpm ledger:import [file] [--db <url>] — one-shot import of the Phase 2 JSONL spend
// ledger into model_calls, so the month's spend survives the move to one ledger
// (ADR-0010). Running it twice imports nothing new.
import { parseArgs } from 'node:util';

import { createUuidV7Generator, importSpendJsonl, openDatabase, systemClock } from '@team/host';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: the process environment alone applies.
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { db: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});
const file = positionals[0] ?? 'data/spend.jsonl';
const url = values.db ?? process.env['DATABASE_URL'] ?? 'file:./data/team.db';

const opened = openDatabase(url);
try {
  const report = await importSpendJsonl(file, opened.db, createUuidV7Generator(systemClock));
  console.log(
    `Imported ${String(report.imported)} paid call(s) from ${file} into ${opened.path}; ${String(report.skipped)} already there.`,
  );
} finally {
  opened.close();
}
