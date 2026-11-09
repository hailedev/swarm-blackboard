import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  AGENT_ROLES,
  calendarMonth,
  createController,
  createDefaultAgents,
  InMemoryBoardStore,
  isPaidProvider,
  PRICE_TABLE_STALE_AFTER_DAYS,
  priceTableAgeDays,
  resolveProfile,
  describeRosterError,
  type AgentRole,
  type BoardEvent,
  type Clock,
  type Controller,
  type ControllerError,
  type Model,
  type ModelPricing,
  type PeriodBudget,
  type RunConfigInput,
  type RunProfile,
} from '@team/core';
import {
  createScriptedModels,
  SCENARIO_TOKENS,
  SequentialIdGenerator,
  type ScenarioPricing,
} from '@team/core/testing';
import { createFakeModel, PRICE_TABLE, pricingFor, traceModel } from '@team/providers';

import { createConsoleLogger } from './adapters/console-logger';
import { JsonlSpendLedger, spendRecordFromTrace } from './adapters/jsonl-spend-ledger';
import { loadPromptFiles } from './adapters/prompt-files';
import { loadRosterFile } from './adapters/roster-file';
import { systemClock } from './adapters/system-clock';
import { monthlyBudgetFromEnv, type Env } from './budget-env';
import {
  renderBoard,
  renderBudgetBanner,
  renderFailure,
  renderRoundHeader,
  renderSummary,
} from './render';

export interface SolveIo {
  write(line: string): void;
  /** Interactive yes/no. Absent when stdin is not a terminal: then `--yes` is required. */
  confirm?(question: string): Promise<boolean>;
}

export const USAGE = [
  'Usage: pnpm solve "<problem>" --fake [--profile <name>] [--yes] [--max-cost <usd>]',
  '                 [--max-rounds N] [--parallelism N] [--json <file>] [--verbose]',
  '',
  '  --fake            run the scripted swarm (FakeModel); real model adapters arrive later in Phase 2',
  '  --profile <name>  profile from agents.yaml (default: its defaultProfile)',
  '  --yes             skip the confirmation a paid profile asks for',
  '  --max-cost <usd>  per-run cost cap (default 0.25)',
  '  --max-rounds N    hard limit on rounds (default 12)',
  '  --parallelism N   agents per round (default 2)',
  '  --roster <file>   roster to load (default ./agents.yaml)',
  '  --ledger <file>   spend ledger (default ./data/spend.jsonl)',
  '  --json <file>     write every board event to <file> as JSON',
  '  --verbose         print controller info logs',
];

const options = {
  fake: { type: 'boolean', default: false },
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'max-cost': { type: 'string' },
  'max-rounds': { type: 'string' },
  parallelism: { type: 'string' },
  roster: { type: 'string', default: 'agents.yaml' },
  ledger: { type: 'string', default: 'data/spend.jsonl' },
  json: { type: 'string' },
  verbose: { type: 'boolean', default: false },
} as const;

const parseArguments = (argv: readonly string[]) => {
  try {
    const result = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return { ok: true as const, result };
  } catch (cause) {
    return {
      ok: false as const,
      message: cause instanceof Error ? cause.message : 'invalid arguments',
    };
  }
};

const usd = (amount: number): string => `$${amount.toFixed(4)}`;

const describeError = (error: ControllerError): string => {
  switch (error.kind) {
    case 'invalid_config':
      return `invalid config: ${error.issues.join('; ')}`;
    case 'invalid_problem':
      return `invalid problem: ${error.issues.join('; ')}`;
    case 'store':
      return `store error: ${error.error.kind}`;
    case 'ledger':
      return `spend ledger: ${error.message}`;
    case 'not_started':
    case 'already_started':
      return error.kind.replace('_', ' ');
    case 'terminated':
      return `run already terminated: ${error.reason}`;
    case 'paused':
      return `run is paused: ${error.reason}`;
    case 'monthly_budget':
      return `monthly budget: ${usd(error.spentUsd)} of ${usd(error.limitUsd)} already spent this month; a per-run cap of ${usd(error.fitsCapUsd)} or less would fit, ${usd(error.requestedCapUsd)} was asked for`;
  }
};

const integerOption = (name: string, raw: string | undefined): number | undefined | Error => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : new Error(`--${name} must be a positive integer, got "${raw}"`);
};

const moneyOption = (name: string, raw: string | undefined): number | undefined | Error => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : new Error(`--${name} must be a non-negative number of dollars, got "${raw}"`);
};

// Fake models stand in for the profile's models but carry their price, so a `--fake`
// run exercises the same reservations the real run would.
const pricingForProfile = (profile: RunProfile): ScenarioPricing | Error => {
  const pricing: Partial<Record<AgentRole, ModelPricing | null>> = {};
  for (const role of AGENT_ROLES) {
    const resolved = pricingOf(profile.roles[role]);
    if (resolved instanceof Error) return resolved;
    pricing[role] = resolved;
  }
  return pricing;
};

const pricingOf = (model: RunProfile['fallback']): ModelPricing | null | Error => {
  if (model === null || !isPaidProvider(model.provider)) return null;
  const price = pricingFor(model.model);
  return (
    price ??
    new Error(
      `no price for ${model.provider}/${model.model} in the price table; add it to packages/providers/src/pricing.ts`,
    )
  );
};

export const main = async (
  argv: readonly string[],
  io: SolveIo,
  env: Env = {},
  clock: Clock = systemClock,
): Promise<number> => {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    io.write(parsed.message);
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }
  const { values, positionals } = parsed.result;

  const problem = positionals.join(' ').trim();
  if (problem.length === 0) {
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }

  const maxRounds = integerOption('max-rounds', values['max-rounds']);
  const parallelism = integerOption('parallelism', values.parallelism);
  const maxCostUsd = moneyOption('max-cost', values['max-cost']);
  for (const option of [maxRounds, parallelism, maxCostUsd]) {
    if (option instanceof Error) {
      io.write(option.message);
      return 2;
    }
  }
  const config: RunConfigInput = {};
  if (typeof maxRounds === 'number') config.maxRounds = maxRounds;
  if (typeof parallelism === 'number') config.parallelism = parallelism;
  if (typeof maxCostUsd === 'number') config.maxCostUsd = maxCostUsd;

  const roster = await loadRosterFile(values.roster);
  if (!roster.ok) {
    io.write(roster.error);
    return 2;
  }
  const profile = resolveProfile(roster.value, values.profile);
  if (!profile.ok) {
    io.write(describeRosterError(profile.error));
    return 2;
  }
  const prompts = await loadPromptFiles(roster.value, values.roster);
  if (!prompts.ok) {
    io.write(prompts.error);
    return 2;
  }
  if (!values.fake) {
    io.write(
      `Real model adapters arrive later in Phase 2. Run with --fake to let scripted models stand in for profile "${profile.value.name}".`,
    );
    return 2;
  }

  const ageDays = priceTableAgeDays(PRICE_TABLE, clock.nowMs());
  if (ageDays > PRICE_TABLE_STALE_AFTER_DAYS) {
    io.write(
      `[warn] the price table is ${String(ageDays)} days old (as of ${PRICE_TABLE.asOf}); check packages/providers/src/pricing.ts against the vendor's price list`,
    );
  }

  const pricing = pricingForProfile(profile.value);
  if (pricing instanceof Error) {
    io.write(pricing.message);
    return 2;
  }
  const fallbackPricing = pricingOf(profile.value.fallback);
  if (fallbackPricing instanceof Error) {
    io.write(fallbackPricing.message);
    return 2;
  }

  // The monthly guard applies only to profiles that can spend (docs/budget-guardrails.md §3).
  const settings = monthlyBudgetFromEnv(env);
  if (!settings.ok) {
    io.write(settings.error);
    return 2;
  }
  const ledger = new JsonlSpendLedger(values.ledger);
  let periodBudget: PeriodBudget | undefined;
  if (profile.value.paid) {
    periodBudget = { ...settings.value, ledger };
    const period = calendarMonth(clock.nowMs(), settings.value.timeZone);
    if (!period.ok) {
      io.write(`BUDGET_TIMEZONE "${period.error.timeZone}" is not a known time zone`);
      return 2;
    }
    let spentUsd: number;
    try {
      spentUsd = await ledger.spentUsd(period.value);
    } catch (cause) {
      io.write(`spend ledger: ${cause instanceof Error ? cause.message : 'unreadable'}`);
      return 2;
    }
    renderBudgetBanner({
      profile: profile.value,
      maxCostUsd: config.maxCostUsd ?? 0.25,
      month: {
        spentUsd,
        limitUsd: settings.value.limitUsd,
        warnAtFraction: settings.value.warnAtFraction,
      },
      fake: true,
    }).forEach((line) => {
      io.write(line);
    });
    if (!values.yes) {
      if (io.confirm === undefined) {
        io.write('Refusing to start a paid profile without confirmation: pass --yes.');
        return 2;
      }
      if (!(await io.confirm('Proceed? [y/N] '))) {
        io.write('Aborted.');
        return 2;
      }
    }
  }

  // Every model call is traced; billed calls go to the ledger (none do under --fake).
  const pendingRecords: Promise<void>[] = [];
  const traced = (model: Model): Model =>
    traceModel(
      model,
      (trace) => {
        const record = spendRecordFromTrace(trace);
        if (record !== null) pendingRecords.push(ledger.record(record));
      },
      () => clock.nowMs(),
    );

  const ref: { controller: Controller | undefined } = { controller: undefined };
  const scripted = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  }, pricing);
  const roleModels = Object.fromEntries(
    AGENT_ROLES.map((role) => [role, traced(scripted[role])]),
  ) as Record<AgentRole, Model>;
  const fallback =
    profile.value.fallback === null
      ? undefined
      : traced(
          createFakeModel({
            id: `fake-fallback-${profile.value.fallback.alias}`,
            pricing: fallbackPricing,
            script: () => ({ object: { contributions: [] }, usage: SCENARIO_TOKENS }),
          }),
        );
  const agents = createDefaultAgents(roleModels, prompts.value, fallback);

  const events: BoardEvent[] = [];
  const controller = createController({
    store: new InMemoryBoardStore(),
    clock,
    // Deterministic ids in --fake mode make the demo reproducible.
    ids: new SequentialIdGenerator(),
    // Failures are rendered from events below; controller warnings would repeat them.
    logger: createConsoleLogger(io.write.bind(io), values.verbose ? 'info' : 'error'),
    agents,
    periodBudget,
    profile: profile.value,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'agents_selected')
        io.write(renderRoundHeader(event.round, event.selected));
      if (event.type === 'agent_failed') {
        io.write(renderFailure(event.agentId, event.reason, event.detail));
      }
      if (event.type === 'budget_warning') {
        io.write(
          `  ! monthly budget warning: ${usd(event.spentUsd)} of ${usd(event.limitUsd)} spent this month`,
        );
      }
      if (event.type === 'round_completed' && ref.controller !== undefined) {
        renderBoard(ref.controller.currentView()).forEach((line) => {
          io.write(line);
        });
        io.write('');
      }
    },
  });
  ref.controller = controller;

  const started = await controller.start({ content: problem }, config);
  if (!started.ok) {
    io.write(`Could not start: ${describeError(started.error)}`);
    return 2;
  }
  io.write(`Problem: ${problem}`);
  io.write(
    `Run ${controller.runId} — profile "${profile.value.name}", scripted models, ${String(agents.length)} agents`,
  );
  io.write('');

  const result = await controller.run();
  await Promise.all(pendingRecords);
  if (!result.ok) {
    io.write(`Run failed: ${describeError(result.error)}`);
    return 1;
  }
  renderSummary(result.value).forEach((line) => {
    io.write(line);
  });

  if (values.json !== undefined) {
    await writeFile(values.json, JSON.stringify(events, null, 2), 'utf8');
    io.write(`Wrote ${String(events.length)} events to ${values.json}`);
  }
  return 0;
};
