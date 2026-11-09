import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import {
  AGENT_ROLES,
  calendarMonth,
  createController,
  createDefaultAgents,
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
  type ModelCallTrace,
  type ModelPricing,
  type PeriodBudget,
  type RunConfigInput,
  type RunProfile,
} from '@team/core';
import { createScriptedModels, SCENARIO_TOKENS, type ScenarioPricing } from '@team/core/testing';
import {
  createCliLogger,
  createUuidV7Generator,
  loadPromptFiles,
  loadRosterFile,
  ModelCallStore,
  monthlyBudgetFromEnv,
  openDatabase,
  SqliteBoardStore,
  SqliteSpendLedger,
  systemClock,
  type Env,
  type OpenedDatabase,
} from '@team/host';
import {
  createFakeModel,
  createProfileModels,
  describeProfileModelsError,
  PRICE_TABLE,
  pricingFor,
  traceModel,
} from '@team/providers';

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

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_DATABASE_URL = 'file:./data/team.db';

export const USAGE = [
  'Usage: pnpm solve "<problem>" [--profile <name>] [--yes] [--max-cost <usd>] [--trace <file>]',
  '                 [--fake] [--max-rounds N] [--parallelism N] [--json <file>] [--verbose]',
  '',
  '  --profile <name>  profile from agents.yaml (default: its defaultProfile)',
  '  --yes             skip the confirmation a paid profile asks for',
  '  --max-cost <usd>  per-run cap (default 0.25)',
  '  --trace <file>    append every model call to <file> as JSON lines, as it happens',
  '  --fake            run the scripted swarm (FakeModel) instead of real models',
  '  --max-rounds N    hard limit on rounds (default 12)',
  '  --parallelism N   agents per round (default 2)',
  '  --roster <file>   roster to load (default ./agents.yaml)',
  '  --db <url>        SQLite database for runs, traces and the spend ledger (default',
  `                    DATABASE_URL or ${DEFAULT_DATABASE_URL}; ":memory:" keeps nothing)`,
  '  --json <file>     write every board event to <file> as JSON',
  '  --verbose         print controller info logs',
  '',
  'Environment (.env): ANTHROPIC_API_KEY for paid profiles; OLLAMA_BASE_URL for local',
  `models (default ${DEFAULT_OLLAMA_BASE_URL}); DATABASE_URL for the database.`,
];

const options = {
  fake: { type: 'boolean', default: false },
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'max-cost': { type: 'string' },
  'max-rounds': { type: 'string' },
  parallelism: { type: 'string' },
  roster: { type: 'string', default: 'agents.yaml' },
  db: { type: 'string' },
  trace: { type: 'string' },
  json: { type: 'string' },
  verbose: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options }>>['values'];

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
    case 'invalid_note':
      return `invalid problem: ${error.issues.join('; ')}`;
    case 'store':
      return `store error: ${error.error.kind}`;
    case 'ledger':
      return `spend ledger: ${error.message}`;
    case 'not_started':
    case 'not_paused':
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

interface RunModels {
  roles: Record<AgentRole, Model>;
  fallback: Model | undefined;
  label: string;
}

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

  // One database for runs, traces and the spend ledger, shared with the server (ADR-0010).
  let opened: OpenedDatabase;
  try {
    opened = openDatabase(values.db ?? env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  } catch (cause) {
    io.write(
      `cannot open the database: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
    return 2;
  }
  try {
    return await solve({
      values,
      problem,
      config,
      profile: profile.value,
      prompts: prompts.value,
      opened,
      io,
      env,
      clock,
    });
  } finally {
    opened.close();
  }
};

interface SolveInput {
  values: Values;
  problem: string;
  config: RunConfigInput;
  profile: RunProfile;
  prompts: Record<AgentRole, string>;
  opened: OpenedDatabase;
  io: SolveIo;
  env: Env;
  clock: Clock;
}

const solve = async ({
  values,
  problem,
  config,
  profile,
  prompts,
  opened,
  io,
  env,
  clock,
}: SolveInput): Promise<number> => {
  const logger = createCliLogger(io.write.bind(io), values.verbose);
  const ids = createUuidV7Generator(clock);
  const store = new SqliteBoardStore(opened.db);
  const calls = new ModelCallStore(opened.db, { ids, logger });
  const ledger = new SqliteSpendLedger(opened.db);
  const now = (): number => clock.nowMs();

  // Every model call is traced into model_calls; with --trace every call is also appended
  // to the trace file as it happens, so an interrupted run keeps its trace.
  const pendingWrites: Promise<void>[] = [];
  let traceCount = 0;
  const traceFile = values.trace;
  const appendTrace = async (trace: ModelCallTrace): Promise<void> => {
    if (traceFile === undefined) return;
    await mkdir(dirname(traceFile), { recursive: true });
    await appendFile(traceFile, `${JSON.stringify(trace)}\n`, 'utf8');
  };
  const sink = (trace: ModelCallTrace): void => {
    traceCount += 1;
    calls.sink(trace);
    pendingWrites.push(appendTrace(trace));
  };

  // Models: real ones from the shared builder (nothing is spent before the key check and
  // the Ollama pre-flight pass), or scripted stand-ins priced like the profile under --fake.
  const ref: { controller: Controller | undefined } = { controller: undefined };
  let models: RunModels;
  if (values.fake) {
    const pricing = pricingForProfile(profile);
    if (pricing instanceof Error) {
      io.write(pricing.message);
      return 2;
    }
    const fallbackPricing = pricingOf(profile.fallback);
    if (fallbackPricing instanceof Error) {
      io.write(fallbackPricing.message);
      return 2;
    }
    const scripted = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('controller not ready');
      return ref.controller.currentView();
    }, pricing);
    models = {
      roles: Object.fromEntries(
        AGENT_ROLES.map((role) => [role, traceModel(scripted[role], sink, now)]),
      ) as Record<AgentRole, Model>,
      fallback:
        profile.fallback === null
          ? undefined
          : traceModel(
              createFakeModel({
                id: `fake-fallback-${profile.fallback.alias}`,
                pricing: fallbackPricing,
                script: () => ({ object: { contributions: [] }, usage: SCENARIO_TOKENS }),
              }),
              sink,
              now,
            ),
      label: 'scripted models',
    };
  } else {
    const built = await createProfileModels(profile, {
      anthropicApiKey: env['ANTHROPIC_API_KEY'],
      ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
      priceTable: PRICE_TABLE,
      sink,
      now,
      charsPerToken: (resolved, providerDefault) => calls.charsPerToken(resolved, providerDefault),
      onProgress: (line) => {
        io.write(line);
      },
    });
    if (!built.ok) {
      io.write(describeProfileModelsError(built.error));
      return 2;
    }
    models = { roles: built.value.roles, fallback: built.value.fallback, label: 'real models' };
  }

  const ageDays = priceTableAgeDays(PRICE_TABLE, clock.nowMs());
  if (ageDays > PRICE_TABLE_STALE_AFTER_DAYS) {
    io.write(
      `[warn] the price table is ${String(ageDays)} days old (as of ${PRICE_TABLE.asOf}); check packages/providers/src/pricing.ts against the vendor's price list`,
    );
  }

  // The monthly guard applies only to profiles that can spend (docs/budget-guardrails.md §3).
  const settings = monthlyBudgetFromEnv(env);
  if (!settings.ok) {
    io.write(settings.error);
    return 2;
  }
  let periodBudget: PeriodBudget | undefined;
  if (profile.paid) {
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
      profile,
      maxCostUsd: config.maxCostUsd ?? 0.25,
      month: {
        spentUsd,
        limitUsd: settings.value.limitUsd,
        warnAtFraction: settings.value.warnAtFraction,
      },
      fake: values.fake,
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

  const agents = createDefaultAgents(models.roles, prompts, models.fallback);

  const events: BoardEvent[] = [];
  const controller = createController({
    store,
    clock,
    ids,
    // Failures are rendered from events below; the CLI logger skips those warnings.
    logger,
    agents,
    periodBudget,
    profile,
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
    `Run ${controller.runId} — profile "${profile.name}", ${models.label}, ${String(agents.length)} agents`,
  );
  io.write('');

  const result = await controller.run();
  await Promise.all(pendingWrites);
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
  if (traceFile !== undefined) {
    io.write(`Wrote ${String(traceCount)} model-call traces to ${traceFile}`);
  }
  if (opened.path !== ':memory:') {
    io.write(`Recorded in ${opened.path}`);
  }
  return 0;
};
