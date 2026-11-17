import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import {
  calendarMonth,
  describeRosterError,
  isPaidProvider,
  resolveEvalModels,
  resolveProfile,
  type Clock,
  type Model,
  type ResolvedModel,
} from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import {
  createCliLogger,
  createUuidV7Generator,
  loadRosterFile,
  ModelCallStore,
  monthlyBudgetFromEnv,
  openDatabase,
  SqliteSpendLedger,
  systemClock,
  type Env,
} from '@team/host';
import { createModelFactory, describeFactoryError, PRICE_TABLE, traceModel } from '@team/providers';

import {
  baselineStandIn,
  DEFAULT_DATABASE_URL,
  DEFAULT_FAKE_RUN_CAP_USD,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PROBLEMS_DIR,
  DEFAULT_RESULTS_DIR,
  DEFAULT_RUN_CAP_USD,
  fileBaselineCache,
  integer,
  loadProblems,
  money,
  type EvalIo,
} from './cli';
import { createFakeBaseline, createFakeJudge } from './fake';
import { passLabelOf, PriorReportSchema, swarmAnswerOf, type PriorPass } from './history';
import { mulberry32 } from './judge';
import { parseAnswerRef, refKey, runRejudge, type AnswerRef } from './rejudge';
import { renderRejudgeReport, type RejudgeMeta } from './rejudge-report';

// pnpm eval:judge — a judge-only session (rejudge.ts): answers that already exist are
// judged again, pairwise or alone, and no swarm runs. The wiring mirrors `pnpm eval`: the
// same roster, store, ledger and traced models; the judge is the profile's own.

export const DEFAULT_JUDGE_SESSION_CAP_USD = 0.35;

export const JUDGE_USAGE = [
  'Usage: pnpm eval:judge [--pair <pass>=<alias>[,…]] [--solo <ref>[,…]] [--profile <name>] [--yes]',
  '                       [--max-cost <usd>] [--label <name>] [--problems a,b] [--judge-orders 1|2]',
  '                       [--seed N] [--run-cap <usd>] [--fake] [--roster <file>] [--db <url>]',
  '                       [--problems-dir <dir>] [--out <dir>]',
  '',
  '  --pair <pass>=<alias>  pairwise: the swarm answers of that earlier pass beside the cached',
  '                         baseline answers of that model alias, blind, in both orders',
  '  --solo <ref>,<ref>     solo: each answer alone against the rubric, once. A ref is',
  '                         swarm:<pass> or baseline:<alias>',
  '  --profile <name>       the profile whose judge does the judging (default: defaultProfile)',
  '  --yes                  skip the confirmation a paid session asks for',
  `  --max-cost <usd>       cap on the whole session (default ${String(DEFAULT_JUDGE_SESSION_CAP_USD)})`,
  '  --label <name>         names the results folder: <out>/<date>-<label> (default judge-only)',
  '  --problems a,b         only these problem ids',
  '  --judge-orders 1|2     judge a pair once, or in both orders (default 2)',
  '  --run-cap <usd>        the cap a baseline that has to be made is sized under',
  '  --fake                 scripted judge and baselines; nothing is billed',
  '',
  '  A pass is named by its label (the results folder without the date). No swarm runs. A',
  '  baseline the cache does not hold, or holds under half its word budget, is made first.',
];

const options = {
  pair: { type: 'string' },
  solo: { type: 'string' },
  profile: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'max-cost': { type: 'string' },
  'run-cap': { type: 'string' },
  label: { type: 'string' },
  problems: { type: 'string' },
  'judge-orders': { type: 'string' },
  seed: { type: 'string' },
  fake: { type: 'boolean', default: false },
  roster: { type: 'string', default: 'agents.yaml' },
  db: { type: 'string' },
  'problems-dir': { type: 'string', default: DEFAULT_PROBLEMS_DIR },
  out: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; strict: true }>>['values'];

const list = (raw: string | undefined): string[] =>
  raw === undefined
    ? []
    : raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/** Every pass with a readable `report.json` under `dir`, oldest folder first. */
export const readPriorPasses = async (dir: string): Promise<PriorPass[]> => {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const passes: PriorPass[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name, 'report.json'), 'utf8');
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    // A judge-only session's own report has no `pass`: it is not a pass, and is skipped.
    const parsed = PriorReportSchema.safeParse(json);
    if (parsed.success) passes.push({ label: passLabelOf(name), report: parsed.data });
  }
  return passes;
};

const gitCommit = async (): Promise<string | null> => {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export const judgeMain = async (
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
    JUDGE_USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }
  if (values.help) {
    JUDGE_USAGE.forEach((line) => {
      io.write(line);
    });
    return 0;
  }
  const cap = money(values['max-cost'], '--max-cost', DEFAULT_JUDGE_SESSION_CAP_USD);
  const runCap = money(
    values['run-cap'],
    '--run-cap',
    values.fake ? DEFAULT_FAKE_RUN_CAP_USD : DEFAULT_RUN_CAP_USD,
  );
  const seed = integer(values.seed, '--seed', clock.nowMs() % 2_147_483_647);
  for (const parsed of [cap, runCap, seed]) {
    if (!parsed.ok) {
      io.write(parsed.error);
      return 2;
    }
  }
  if (!cap.ok || !runCap.ok || !seed.ok) return 2;
  if (values['judge-orders'] !== undefined && !['1', '2'].includes(values['judge-orders'])) {
    io.write(`--judge-orders must be 1 or 2, got "${values['judge-orders']}"`);
    return 2;
  }
  const judgeOrders: 1 | 2 = values['judge-orders'] === '1' ? 1 : 2;

  // What to judge.
  const pairs: { pass: string; alias: string }[] = [];
  for (const item of list(values.pair)) {
    const [pass, alias, ...rest] = item.split('=');
    if (
      pass === undefined ||
      pass === '' ||
      alias === undefined ||
      alias === '' ||
      rest.length > 0
    ) {
      io.write(`--pair takes <pass>=<alias>, got "${item}"`);
      return 2;
    }
    pairs.push({ pass, alias });
  }
  const solo: AnswerRef[] = [];
  for (const item of list(values.solo)) {
    const ref = parseAnswerRef(item);
    if (!ref.ok) {
      io.write(`--solo: ${ref.error}`);
      return 2;
    }
    solo.push(ref.value);
  }
  if (pairs.length === 0 && solo.length === 0) {
    io.write('nothing to judge: give --pair, --solo or both');
    JUDGE_USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }

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
  const configured = resolveEvalModels(roster.value, profile.value.name);
  if (!configured.ok) {
    io.write(describeRosterError(configured.error));
    return 2;
  }
  const aliases = [
    ...new Set([
      ...pairs.map((p) => p.alias),
      ...solo.flatMap((ref) => (ref.kind === 'baseline' ? [ref.alias] : [])),
    ]),
  ];
  const baselines = new Map<string, ResolvedModel>();
  for (const alias of aliases) {
    const resolved = baselineStandIn(roster.value, alias);
    if (!resolved.ok) {
      io.write(resolved.error.replace('--baseline names', 'the session names'));
      return 2;
    }
    if (resolved.value !== null) baselines.set(alias, resolved.value);
  }

  const loaded = await loadProblems(values['problems-dir']);
  if (!loaded.ok) {
    io.write(loaded.error);
    return 2;
  }
  const wanted = values.problems === undefined ? null : list(values.problems);
  if (wanted !== null) {
    const missing = wanted.filter((id) => !loaded.value.some((p) => p.id === id));
    if (missing.length > 0) {
      io.write(
        `unknown problem id(s): ${missing.join(', ')}; known: ${loaded.value.map((p) => p.id).join(', ')}`,
      );
      return 2;
    }
  }
  const problems = loaded.value.filter((p) => wanted === null || wanted.includes(p.id));
  if (problems.length === 0) {
    io.write('no problems to judge');
    return 2;
  }

  // The earlier passes: where the swarm's answers and the pairwise history come from. Every
  // pass the session names has to be there before anything is spent.
  const outRoot =
    values.out ?? (values.fake ? join(DEFAULT_RESULTS_DIR, 'fake') : DEFAULT_RESULTS_DIR);
  const passes = await readPriorPasses(outRoot);
  const namedPasses = [
    ...new Set([
      ...pairs.map((p) => p.pass),
      ...solo.flatMap((ref) => (ref.kind === 'swarm' ? [ref.pass] : [])),
    ]),
  ];
  for (const label of namedPasses) {
    for (const problem of problems) {
      const answer = swarmAnswerOf(passes, label, problem.id);
      if (!answer.ok) {
        io.write(answer.error);
        return 2;
      }
    }
  }

  const paid =
    isPaidProvider(configured.value.judge.provider) ||
    [...baselines.values()].some((model) => isPaidProvider(model.provider));
  const date = new Date(clock.nowMs()).toISOString().slice(0, 10);
  const label = values.label ?? 'judge-only';
  const outDir = join(outRoot, `${date}-${label}`);
  const cache = fileBaselineCache(join(outRoot, 'baselines'));

  const opened = openDatabase(values.db ?? env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  try {
    const logger = createCliLogger(io.write.bind(io), false);
    const ids = createUuidV7Generator(clock);
    const calls = new ModelCallStore(opened.db, { ids, logger });
    const ledger = new SqliteSpendLedger(opened.db);
    const now = (): number => clock.nowMs();
    const sink = calls.sink;

    let judgeModel: Model;
    let allowanceModel: Model;
    const baselineModels = new Map<string, Model>();
    if (values.fake) {
      judgeModel = traceModel(createFakeJudge(SCENARIO_PRICING), sink, now);
      allowanceModel = traceModel(createFakeBaseline(SCENARIO_PRICING), sink, now);
      for (const alias of baselines.keys()) baselineModels.set(alias, allowanceModel);
    } else {
      const factory = createModelFactory({
        anthropicApiKey: env['ANTHROPIC_API_KEY'],
        ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
        priceTable: PRICE_TABLE,
        sink,
        now,
        charsPerToken: (resolved: ResolvedModel, providerDefault: number) =>
          calls.charsPerToken(resolved, providerDefault),
      });
      const judge = factory.modelFor(configured.value.judge);
      const own = factory.modelFor(configured.value.baseline);
      if (!judge.ok) {
        io.write(describeFactoryError(judge.error));
        return 2;
      }
      if (!own.ok) {
        io.write(describeFactoryError(own.error));
        return 2;
      }
      judgeModel = judge.value;
      allowanceModel = own.value;
      for (const [alias, resolved] of baselines) {
        const model = factory.modelFor(resolved);
        if (!model.ok) {
          io.write(describeFactoryError(model.error));
          return 2;
        }
        baselineModels.set(alias, model.value);
      }
    }

    // The banner, the month and the confirmation, as for a pass.
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
    const judgeCalls = pairs.length * problems.length * judgeOrders + solo.length * problems.length;
    io.write(`== Judge-only session: no swarm runs ==`);
    io.write(
      `  judge         ${configured.value.judge.alias.padEnd(12)} ${configured.value.judge.provider}/${configured.value.judge.model}`,
    );
    for (const pair of pairs) {
      io.write(
        `  pairwise      the swarm answers of ${pair.pass} beside the ${pair.alias} baselines, ${judgeOrders === 2 ? 'both orders' : 'one order'}`,
      );
    }
    if (solo.length > 0) io.write(`  solo          ${solo.map(refKey).join(', ')}`);
    io.write(`  problems      ${String(problems.length)}`);
    io.write(`  judge calls   ${String(judgeCalls)}`);
    io.write(`  session cap   $${cap.value.toFixed(4)}`);
    io.write(`  this month    $${spentUsd.toFixed(4)} of $${settings.value.limitUsd.toFixed(2)}`);
    if (values.fake) io.write('  --fake: scripted models stand in for these; nothing is billed.');
    if (paid && !values.fake) {
      if (spentUsd + cap.value > settings.value.limitUsd) {
        const fits = Math.max(0, settings.value.limitUsd - spentUsd);
        io.write(
          `Refusing: this month has $${fits.toFixed(4)} left of $${settings.value.limitUsd.toFixed(2)}, less than the session cap $${cap.value.toFixed(4)}; pass --max-cost ${fits.toFixed(2)} or lower.`,
        );
        return 2;
      }
      if (!values.yes) {
        if (io.confirm === undefined) {
          io.write('Refusing to start a paid session without confirmation: pass --yes.');
          return 2;
        }
        if (!(await io.confirm('Proceed? [y/N] '))) {
          io.write('Aborted.');
          return 2;
        }
      }
    }

    const sessionId = ids.next();
    io.write(`Session ${sessionId}: results in ${outDir}`);
    const result = await runRejudge(
      {
        sessionId,
        problems,
        capUsd: cap.value,
        runCapUsd: runCap.value,
        pairs,
        solo,
        judgeOrders,
        judgeMaxOutputTokens: 4_096,
        baselineMaxOutputTokens: 4_096,
      },
      {
        judgeModel,
        cache,
        baselineModels,
        allowanceModel,
        swarmAnswer: (pass, problemId) => swarmAnswerOf(passes, pass, problemId),
        now,
        log: (line) => {
          io.write(line);
        },
        rng: mulberry32(seed.value),
      },
    );

    const meta: RejudgeMeta = {
      label,
      commit: await gitCommit(),
      judge: { alias: configured.value.judge.alias, modelId: judgeModel.id },
      baselines: Object.fromEntries([...baselineModels].map(([alias, model]) => [alias, model.id])),
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'report.md'),
      renderRejudgeReport(result, meta, problems, passes),
      'utf8',
    );
    await writeFile(
      join(outDir, 'report.json'),
      `${JSON.stringify({ meta, session: result }, null, 2)}\n`,
      'utf8',
    );
    io.write('');
    io.write(
      `Judged ${String(result.pairs.filter((p) => p.judgements.length > 0).length)} of ${String(result.pairs.length)} pairs and ${String(result.solo.filter((s) => s.percent !== null).length)} of ${String(result.solo.length)} answers alone; spent $${result.spentUsd.toFixed(4)} of $${cap.value.toFixed(4)}.`,
    );
    io.write(`Wrote ${join(outDir, 'report.md')}`);
    return 0;
  } finally {
    opened.close();
  }
};
