// The API server: `pnpm dev`. One process owns the database, the run loops and the
// event stream (docs/PLAN.md §6, Phase 3). Configuration comes from .env.
//
// `--fake` (`pnpm dev:fake`, the Playwright smoke) swaps in the scripted swarm and an
// in-memory database: no model is called, nothing is billed, and data/team.db is never
// opened (ADR-0011). FAKE_DELAY_MS sets how long each scripted call takes.
import { serve } from '@hono/node-server';
import { PRICE_TABLE_STALE_AFTER_DAYS, priceTableAgeDays } from '@team/core';
import {
  createConsoleLogger,
  createUuidV7Generator,
  IN_MEMORY,
  loadPromptFiles,
  loadRosterFile,
  monthlyBudgetFromEnv,
  openDatabase,
  systemClock,
} from '@team/host';
import { PRICE_TABLE } from '@team/providers';

import { createApp } from './api/app';
import { DEFAULT_FAKE_DELAY_MS, realModels, scriptedModels } from './models';
import { RunManager } from './run-manager';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: the process environment alone applies.
}

const logger = createConsoleLogger((line) => {
  console.log(line);
}, 'info');

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const rosterPath = process.env['AGENTS_YAML'] ?? 'agents.yaml';
const roster = await loadRosterFile(rosterPath);
if (!roster.ok) fail(roster.error);
const prompts = roster.ok ? await loadPromptFiles(roster.value, rosterPath) : undefined;
if (prompts === undefined || !prompts.ok)
  fail(prompts?.ok === false ? prompts.error : 'no prompts');
const monthlyBudget = monthlyBudgetFromEnv(process.env);
if (!monthlyBudget.ok) fail(monthlyBudget.error);

const fake = process.argv.includes('--fake');
const fakeDelayMs = Number(process.env['FAKE_DELAY_MS'] ?? String(DEFAULT_FAKE_DELAY_MS));
if (fake && !(Number.isFinite(fakeDelayMs) && fakeDelayMs >= 0)) {
  fail(`FAKE_DELAY_MS must be a non-negative number of milliseconds`);
}

if (roster.ok && prompts?.ok === true && monthlyBudget.ok) {
  const opened = openDatabase(
    fake ? IN_MEMORY : (process.env['DATABASE_URL'] ?? 'file:./data/team.db'),
  );
  if (fake) {
    logger.warn('fake mode: scripted models, in-memory database; nothing is billed or kept', {
      delayMs: fakeDelayMs,
    });
  }
  const manager = new RunManager({
    db: opened.db,
    roster: roster.value,
    prompts: prompts.value,
    clock: systemClock,
    ids: createUuidV7Generator(systemClock),
    logger,
    monthlyBudget: monthlyBudget.value,
    models: fake ? scriptedModels({ delayMs: fakeDelayMs }) : realModels(process.env, logger),
  });
  const interrupted = await manager.recover();
  if (interrupted > 0) {
    logger.warn('runs left running by the last shutdown were paused as interrupted', {
      count: interrupted,
    });
  }
  const ageDays = priceTableAgeDays(PRICE_TABLE, systemClock.nowMs());
  if (ageDays > PRICE_TABLE_STALE_AFTER_DAYS) {
    logger.warn('the price table is stale; check packages/providers/src/pricing.ts', {
      ageDays,
      asOf: PRICE_TABLE.asOf,
    });
  }
  const app = createApp({
    manager,
    roster: roster.value,
    monthlyBudget: monthlyBudget.value,
    clock: systemClock,
  });
  const port = Number(process.env['PORT'] ?? '3001');
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info('listening', { port: info.port, database: opened.path });
  });
  const shutdown = (): void => {
    logger.info('shutting down');
    opened.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
