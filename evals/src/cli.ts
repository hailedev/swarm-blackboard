import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import {
  AGENT_ROLES,
  calendarMonth,
  createController,
  createDefaultAgents,
  describeRosterError,
  err,
  isPaidProvider,
  latestSynthesis,
  ok,
  resolveEvalModels,
  resolveProfile,
  type AgentRole,
  type Clock,
  type Controller,
  type Model,
  type ResolvedEvalModels,
  type ResolvedModel,
  type Result,
  type RunProfile,
} from '@team/core';
import { createScriptedModels, SCENARIO_PRICING } from '@team/core/testing';
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
} from '@team/host';
import {
  createModelFactory,
  createProfileModels,
  describeFactoryError,
  describeProfileModelsError,
  PRICE_TABLE,
  traceModel,
} from '@team/providers';

import { BaselineRecordSchema, type BaselineCache, type BaselineRecord } from './baseline';
import { createFakeBaseline, createFakeJudge } from './fake';
import { mulberry32 } from './judge';
import { runPass, type PassResult, type SwarmOutcome } from './pass';
import { parseProblemFile, type Problem } from './problems';
import { renderPair, renderReport, selectPairs } from './report';

// pnpm eval — the swarm against a single-call baseline at equal cost, judged blind
// (docs/PLAN.md §6 Phase 5, ADR-0012, docs/budget-guardrails.md §9). The wiring mirrors
// `pnpm solve`: the same host store, ledger and traced models; only the orchestration and
// the two extra models are new.

export interface EvalIo {
  write(line: string): void;
  confirm?(question: string): Promise<boolean>;
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_DATABASE_URL = 'file:./data/team.db';
export const DEFAULT_PASS_CAP_USD = 1;
export const DEFAULT_RUN_CAP_USD = 0.08;
export const DEFAULT_PROBLEMS_DIR = 'evals/problems';
export const DEFAULT_RESULTS_DIR = 'evals/results';

export const USAGE = [
  'Usage: pnpm eval [--profile <name>] [--yes] [--max-cost <usd>] [--run-cap <usd>] [--label <name>]',
  '                 [--problems a,b] [--limit N] [--judge-orders 1|2] [--refresh-baselines] [--seed N]',
  '                 [--fake] [--roster <file>] [--db <url>] [--problems-dir <dir>] [--out <dir>]',
  '',
  '  --profile <name>     swarm profile from agents.yaml (default: its defaultProfile); the',
  '                       baseline and judge come from its `evals` entry',
  '  --yes                skip the confirmation a paid pass asks for',
  `  --max-cost <usd>     cap on the whole pass (default ${String(DEFAULT_PASS_CAP_USD)})`,
  `  --run-cap <usd>      cap on each swarm run (default ${String(DEFAULT_RUN_CAP_USD)})`,
  '  --label <name>       names the results folder: <out>/<date>-<label>',
  '  --problems a,b       only these problem ids; --limit N takes the first N',
  '  --judge-orders 1|2   judge each pair once, or in both orders (default 2)',
  '  --refresh-baselines  redo cached baseline answers',
  '  --seed N             seed for the blind order (default: from the clock)',
  '  --fake               scripted swarm, baseline and judge; nothing is billed',
  '  --roster <file>      roster to load (default ./agents.yaml)',
  `  --db <url>           SQLite database for runs, traces and the ledger (default DATABASE_URL or ${DEFAULT_DATABASE_URL})`,
  `  --problems-dir <dir> where the problem files are (default ${DEFAULT_PROBLEMS_DIR})`,
  `  --out <dir>          where the report goes (default ${DEFAULT_RESULTS_DIR}; baselines are cached in <out>/baselines)`,
];

const options = {
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'max-cost': { type: 'string' },
  'run-cap': { type: 'string' },
  label: { type: 'string' },
  problems: { type: 'string' },
  limit: { type: 'string' },
  'judge-orders': { type: 'string' },
  'refresh-baselines': { type: 'boolean', default: false },
  seed: { type: 'string' },
  fake: { type: 'boolean', default: false },
  roster: { type: 'string', default: 'agents.yaml' },
  db: { type: 'string' },
  'problems-dir': { type: 'string', default: DEFAULT_PROBLEMS_DIR },
  out: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; strict: true }>>['values'];

const money = (raw: string | undefined, name: string, fallback: number): Result<number, string> => {
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? ok(value)
    : err(`${name} must be a dollar amount, got "${raw}"`);
};

const integer = (
  raw: string | undefined,
  name: string,
  fallback: number,
): Result<number, string> => {
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? ok(value)
    : err(`${name} must be a non-negative integer, got "${raw}"`);
};

/** The problem files of a directory, in file-name order. */
export const loadProblems = async (dir: string): Promise<Result<Problem[], string>> => {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return err(`cannot read the problems directory ${dir}`);
  }
  const problems: Problem[] = [];
  for (const name of names) {
    const parsed = parseProblemFile(await readFile(join(dir, name), 'utf8'), join(dir, name));
    if (!parsed.ok) return parsed;
    problems.push(parsed.value);
  }
  const ids = new Set<string>();
  for (const p of problems) {
    if (ids.has(p.id)) return err(`two problem files share the id "${p.id}"`);
    ids.add(p.id);
  }
  return ok(problems);
};

/** One JSON file per problem and model under `dir`, validated on the way in. */
export const fileBaselineCache = (dir: string): BaselineCache => {
  const file = (problemId: string, modelId: string): string =>
    join(dir, `${problemId}--${modelId.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  return {
    async get(problemId, modelId) {
      let text: string;
      try {
        text = await readFile(file(problemId, modelId), 'utf8');
      } catch {
        return undefined;
      }
      const parsed = BaselineRecordSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    },
    async put(record: BaselineRecord) {
      await mkdir(dir, { recursive: true });
      await writeFile(
        file(record.problemId, record.modelId),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    },
  };
};

const gitCommit = async (): Promise<string | null> => {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const modelRow = (label: string, model: ResolvedModel): string =>
  `  ${label.padEnd(13)} ${model.alias.padEnd(12)} ${model.provider}/${model.model}${isPaidProvider(model.provider) ? '' : '  free'}`;

export interface EvalBannerInput {
  profile: RunProfile;
  evalModels: ResolvedEvalModels;
  passCapUsd: number;
  runCapUsd: number;
  problems: number;
  month: { spentUsd: number; limitUsd: number; warnAtFraction: number };
  fake: boolean;
}

export const renderEvalBanner = (input: EvalBannerInput): string[] => {
  const lines = [`== Eval pass: swarm profile "${input.profile.name}" ==`];
  for (const role of AGENT_ROLES) lines.push(modelRow(role, input.profile.roles[role]));
  lines.push(
    input.profile.fallback === null
      ? `  ${'fallback'.padEnd(13)} none`
      : modelRow('fallback', input.profile.fallback),
  );
  lines.push(modelRow('baseline', input.evalModels.baseline));
  lines.push(modelRow('judge', input.evalModels.judge));
  lines.push(`  ${'problems'.padEnd(13)} ${String(input.problems)}`);
  lines.push(`  ${'pass cap'.padEnd(13)} $${input.passCapUsd.toFixed(4)}`);
  lines.push(`  ${'per-run cap'.padEnd(13)} $${input.runCapUsd.toFixed(4)}`);
  const percent =
    input.month.limitUsd > 0
      ? Math.round((input.month.spentUsd / input.month.limitUsd) * 100)
      : 100;
  const warning =
    input.month.spentUsd >= input.month.limitUsd * input.month.warnAtFraction
      ? `  ! past ${String(Math.round(input.month.warnAtFraction * 100))}% of the monthly limit`
      : '';
  lines.push(
    `  ${'this month'.padEnd(13)} $${input.month.spentUsd.toFixed(4)} of $${input.month.limitUsd.toFixed(2)} (${String(percent)}%)${warning}`,
  );
  if (input.fake) lines.push('  --fake: scripted models stand in for these; nothing is billed.');
  return lines;
};

export const main = async (
  argv: readonly string[],
  io: EvalIo,
  env: Env = {},
  clock: Clock = systemClock,
): Promise<number> => {
  let values: Values;
  try {
    values = parseArgs({ args: [...argv], options, strict: true }).values;
  } catch (cause) {
    io.write(cause instanceof Error ? cause.message : 'bad arguments');
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }
  if (values.help) {
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 0;
  }
  const passCap = money(values['max-cost'], '--max-cost', DEFAULT_PASS_CAP_USD);
  const runCap = money(values['run-cap'], '--run-cap', DEFAULT_RUN_CAP_USD);
  const limit = integer(values.limit, '--limit', Number.MAX_SAFE_INTEGER);
  const seed = integer(values.seed, '--seed', clock.nowMs() % 2_147_483_647);
  for (const parsed of [passCap, runCap, limit, seed]) {
    if (!parsed.ok) {
      io.write(parsed.error);
      return 2;
    }
  }
  if (!passCap.ok || !runCap.ok || !limit.ok || !seed.ok) return 2;
  if (values['judge-orders'] !== undefined && !['1', '2'].includes(values['judge-orders'])) {
    io.write(`--judge-orders must be 1 or 2, got "${values['judge-orders']}"`);
    return 2;
  }
  const judgeOrders: 1 | 2 = values['judge-orders'] === '1' ? 1 : 2;

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
  const evalModels = resolveEvalModels(roster.value, profile.value.name);
  if (!evalModels.ok) {
    io.write(describeRosterError(evalModels.error));
    return 2;
  }
  const prompts = await loadPromptFiles(roster.value, values.roster);
  if (!prompts.ok) {
    io.write(prompts.error);
    return 2;
  }
  const loaded = await loadProblems(values['problems-dir']);
  if (!loaded.ok) {
    io.write(loaded.error);
    return 2;
  }
  const wanted = values.problems?.split(',').map((id) => id.trim()) ?? null;
  if (wanted !== null) {
    const missing = wanted.filter((id) => !loaded.value.some((p) => p.id === id));
    if (missing.length > 0) {
      io.write(
        `unknown problem id(s): ${missing.join(', ')}; known: ${loaded.value.map((p) => p.id).join(', ')}`,
      );
      return 2;
    }
  }
  const problems = loaded.value
    .filter((p) => wanted === null || wanted.includes(p.id))
    .slice(0, limit.value);
  if (problems.length === 0) {
    io.write('no problems to run');
    return 2;
  }

  const paid =
    profile.value.paid ||
    isPaidProvider(evalModels.value.baseline.provider) ||
    isPaidProvider(evalModels.value.judge.provider);
  const date = new Date(clock.nowMs()).toISOString().slice(0, 10);
  const label = values.label ?? (values.fake ? 'fake' : 'pass');
  const outRoot =
    values.out ?? (values.fake ? join(DEFAULT_RESULTS_DIR, 'fake') : DEFAULT_RESULTS_DIR);
  const outDir = join(outRoot, `${date}-${label}`);
  const cache = fileBaselineCache(join(outRoot, 'baselines'));

  const opened = openDatabase(values.db ?? env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  try {
    const logger = createCliLogger(io.write.bind(io), false);
    const ids = createUuidV7Generator(clock);
    const store = new SqliteBoardStore(opened.db);
    const calls = new ModelCallStore(opened.db, { ids, logger });
    const ledger = new SqliteSpendLedger(opened.db);
    const now = (): number => clock.nowMs();
    const sink = calls.sink;

    // Models: scripted under --fake, real ones through the shared builders otherwise.
    const ref: { controller: Controller | undefined } = { controller: undefined };
    let swarmModels: { roles: Record<AgentRole, Model>; fallback: Model | undefined };
    let baselineModel: Model;
    let judgeModel: Model;
    if (values.fake) {
      const scripted = createScriptedModels(() => {
        if (ref.controller === undefined) throw new Error('controller not ready');
        return ref.controller.currentView();
      });
      swarmModels = {
        roles: Object.fromEntries(
          AGENT_ROLES.map((role) => [role, traceModel(scripted[role], sink, now)]),
        ) as Record<AgentRole, Model>,
        fallback: undefined,
      };
      baselineModel = traceModel(createFakeBaseline(SCENARIO_PRICING), sink, now);
      judgeModel = traceModel(createFakeJudge(SCENARIO_PRICING), sink, now);
    } else {
      const factoryOptions = {
        anthropicApiKey: env['ANTHROPIC_API_KEY'],
        ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
        priceTable: PRICE_TABLE,
        sink,
        now,
        charsPerToken: (resolved: ResolvedModel, providerDefault: number) =>
          calls.charsPerToken(resolved, providerDefault),
      };
      const built = await createProfileModels(profile.value, {
        ...factoryOptions,
        onProgress: (line) => {
          io.write(line);
        },
      });
      if (!built.ok) {
        io.write(describeProfileModelsError(built.error));
        return 2;
      }
      swarmModels = { roles: built.value.roles, fallback: built.value.fallback };
      const factory = createModelFactory(factoryOptions);
      const baseline = factory.modelFor(evalModels.value.baseline);
      const judge = factory.modelFor(evalModels.value.judge);
      if (!baseline.ok) {
        io.write(describeFactoryError(baseline.error));
        return 2;
      }
      if (!judge.ok) {
        io.write(describeFactoryError(judge.error));
        return 2;
      }
      baselineModel = baseline.value;
      judgeModel = judge.value;
    }

    // The month: banner, confirmation and the guard the pass re-reads before each problem.
    const settings = monthlyBudgetFromEnv(env);
    if (!settings.ok) {
      io.write(settings.error);
      return 2;
    }
    const period = calendarMonth(clock.nowMs(), settings.value.timeZone);
    if (!period.ok) {
      io.write(`BUDGET_TIMEZONE "${period.error.timeZone}" is not a known time zone`);
      return 2;
    }
    const spentUsd = await ledger.spentUsd(period.value);
    renderEvalBanner({
      profile: profile.value,
      evalModels: evalModels.value,
      passCapUsd: passCap.value,
      runCapUsd: runCap.value,
      problems: problems.length,
      month: {
        spentUsd,
        limitUsd: settings.value.limitUsd,
        warnAtFraction: settings.value.warnAtFraction,
      },
      fake: values.fake,
    }).forEach((line) => {
      io.write(line);
    });
    if (paid && !values.fake) {
      if (spentUsd + passCap.value > settings.value.limitUsd) {
        const fits = Math.max(0, settings.value.limitUsd - spentUsd);
        io.write(
          `Refusing: this month has $${fits.toFixed(4)} left of $${settings.value.limitUsd.toFixed(2)}, less than the pass cap $${passCap.value.toFixed(4)}; pass --max-cost ${fits.toFixed(2)} or lower.`,
        );
        return 2;
      }
      if (!values.yes) {
        if (io.confirm === undefined) {
          io.write('Refusing to start a paid pass without confirmation: pass --yes.');
          return 2;
        }
        if (!(await io.confirm('Proceed? [y/N] '))) {
          io.write('Aborted.');
          return 2;
        }
      }
    }
    const month =
      paid && !values.fake
        ? { spentUsd: () => ledger.spentUsd(period.value), limitUsd: settings.value.limitUsd }
        : null;

    const periodBudget = paid && !values.fake ? { ...settings.value, ledger } : undefined;
    const runSwarm = async (
      problem: Problem,
      maxCostUsd: number,
    ): Promise<Result<SwarmOutcome, string>> => {
      const agents = createDefaultAgents(swarmModels.roles, prompts.value, swarmModels.fallback);
      const controller = createController({
        store,
        clock,
        ids,
        logger,
        agents,
        periodBudget,
        profile: profile.value,
      });
      ref.controller = controller;
      const started = await controller.start(
        {
          content: problem.statement,
          constraints: problem.constraints,
          successCriteria: problem.successCriteria,
        },
        { maxCostUsd },
      );
      if (!started.ok) return err(`could not start: ${started.error.kind}`);
      const result = await controller.run();
      if (!result.ok) return err(`run failed: ${result.error.kind}`);
      const synthesis = latestSynthesis(result.value.view);
      return ok({
        runId: result.value.runId,
        answer: synthesis?.content ?? null,
        confidence: synthesis?.payload.confidence ?? null,
        rounds: result.value.rounds,
        status: result.value.status,
        reason: result.value.reason,
        entries: result.value.totals.entries,
        usage: result.value.totals.usage,
        costUsd: result.value.totals.usage.costUsd,
        elapsedMs: result.value.totals.elapsedMs,
      });
    };

    const passId = ids.next();
    io.write(`Pass ${passId}: ${String(problems.length)} problems, results in ${outDir}`);
    const pass = await runPass(
      {
        passId,
        problems,
        capUsd: passCap.value,
        runCapUsd: runCap.value,
        judgeOrders,
        refreshBaselines: values['refresh-baselines'],
        baselineMaxOutputTokens: 4_096,
        judgeMaxOutputTokens: 2_048,
      },
      {
        runSwarm,
        baselineModel,
        judgeModel,
        cache,
        month,
        now,
        log: (line) => {
          io.write(line);
        },
        rng: mulberry32(seed.value),
      },
    );

    await writeOutputs(outDir, pass, {
      label,
      profile: profile.value,
      evalModels: evalModels.value,
      commit: await gitCommit(),
      baselineModelId: baselineModel.id,
      judgeModelId: judgeModel.id,
    });
    const a = pass.aggregate;
    io.write('');
    io.write(
      `Swarm ${a.swarmMean === null ? '—' : `${a.swarmMean.toFixed(1)}%`} vs baseline ${a.baselineMean === null ? '—' : `${a.baselineMean.toFixed(1)}%`} over ${String(a.judged)} judged pairs; swarm wins ${String(a.wins)}, ties ${String(a.ties)}, losses ${String(a.losses)}; spent $${pass.spentUsd.toFixed(4)} of $${passCap.value.toFixed(4)}.`,
    );
    if (pass.stopped !== null) {
      io.write(`Stopped early before ${pass.stopped.beforeProblem}: ${pass.stopped.reason}.`);
    }
    io.write(`Wrote ${join(outDir, 'report.md')}`);
    return 0;
  } finally {
    opened.close();
  }
};

const writeOutputs = async (
  outDir: string,
  pass: PassResult,
  meta: Parameters<typeof renderReport>[1],
): Promise<void> => {
  await mkdir(join(outDir, 'pairs'), { recursive: true });
  await writeFile(join(outDir, 'report.md'), renderReport(pass, meta), 'utf8');
  await writeFile(
    join(outDir, 'report.json'),
    `${JSON.stringify({ meta, pass }, null, 2)}\n`,
    'utf8',
  );
  for (const { why, result } of selectPairs(pass)) {
    await writeFile(
      join(outDir, 'pairs', `${result.problem.id}.md`),
      renderPair(result, why),
      'utf8',
    );
  }
};
