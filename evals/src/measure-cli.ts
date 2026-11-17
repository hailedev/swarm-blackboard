import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  AGENT_ROLES,
  calendarMonth,
  defaultRunConfig,
  describeRosterError,
  err,
  isPaidProvider,
  ok,
  resolveEvalModels,
  resolveProfile,
  wordBudgetFor,
  type Clock,
  type Model,
  type ResolvedModel,
  type Result,
  type Roster,
} from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import {
  createCliLogger,
  createUuidV7Generator,
  loadPromptFiles,
  loadRosterFile,
  loadWriteUpPrompt,
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

import {
  baselineStandIn,
  DEFAULT_DATABASE_URL,
  DEFAULT_FAKE_RUN_CAP_USD,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PASS_CAP_USD,
  DEFAULT_PROBLEMS_DIR,
  DEFAULT_RESULTS_DIR,
  DEFAULT_RUN_CAP_USD,
  gitCommit,
  integer,
  loadProblems,
  money,
  type EvalIo,
} from './cli';
import { createFakeBaseline, createFakeJudge } from './fake';
import {
  answerKeys,
  describeArms,
  describeTally,
  runGenerate,
  runScore,
  scoreKeys,
  sizeAnswers,
  sizeProblems,
  type SwarmArm,
} from './measure';
import { renderMeasureReport, spotChecks, summarise } from './measure-report';
import {
  armRef,
  fileMeasureStore,
  parseArm,
  sameArm,
  type Arm,
  type Manifest,
  type MeasureStore,
} from './measure-store';
import type { MonthGuard } from './pass';
import type { Problem } from './problems';
import { createScriptedSwarm, createSwarmRunner } from './swarm-runner';

// pnpm eval:measure <generate|score|report> — several arms on every problem, each answer
// scored alone (measure.ts). Three subcommands on one results folder, found by its label:
// `generate` makes the answers, `score` scores them, `report` renders what is on disk.
// The first two are resumable and each has a dollar cap over the whole stage. The wiring
// mirrors `pnpm eval`: the same roster, store, ledger and traced models.

export const DEFAULT_RUNS = 3;
export const DEFAULT_SCORES = 2;
const JUDGE_MAX_OUTPUT_TOKENS = 4_096;

export const MEASURE_USAGE = [
  'Usage: pnpm eval:measure generate --label <name> --arms <arm>[,…] [--profile <name>] [--runs N]',
  '                                  [--max-cost <usd>] [--run-cap <usd>] [--problems a,b] [--yes]',
  '       pnpm eval:measure score    --label <name> [--scores N] [--max-cost <usd>] [--problems a,b] [--yes]',
  '       pnpm eval:measure report   --label <name>',
  '',
  '  generate   make the answers: every arm on every problem; a swarm arm --runs times',
  '  score      score every answer alone against the rubric, --scores times',
  '  report     render report.md, report.json and spot-check/ from what is on disk',
  '',
  '  --label <name>     names the results folder: <out>/<date>-<label>; a later stage finds it',
  '                     by the label, whatever the date',
  '  --arms <arm>,…     call:<alias> is one call of that model with the baseline prompt;',
  '                     swarm:<profile> is that swarm profile. Worked through in this order.',
  '                     Fixed when the measurement is first generated',
  "  --profile <name>   the profile whose judge scores and whose baseline model sizes every arm's",
  '                     answer (default: defaultProfile). Fixed with the arms',
  `  --runs N           runs of each swarm arm per problem (default ${String(DEFAULT_RUNS)})`,
  `  --scores N         scores per answer (default ${String(DEFAULT_SCORES)})`,
  `  --max-cost <usd>   cap on the whole stage, across every invocation of it (default ${String(DEFAULT_PASS_CAP_USD)})`,
  `  --run-cap <usd>    cap on each swarm run, and the cap the answer length is sized under`,
  `                     (default ${String(DEFAULT_RUN_CAP_USD)}; ${String(DEFAULT_FAKE_RUN_CAP_USD)} with --fake)`,
  '  --problems a,b     only these problems in this invocation; the measurement is of them all',
  '  --dry-run          say what the stage would do and stop, spending nothing',
  '  --yes              skip the confirmation a paid stage asks for',
  '  --fake             scripted models; nothing is billed (results under <out>/fake)',
  '  --roster <file>, --db <url>, --problems-dir <dir>, --out <dir>   as for pnpm eval',
  '',
  '  A stage skips what is already on disk and tries again only what failed.',
];

const options = {
  label: { type: 'string' },
  arms: { type: 'string' },
  profile: { type: 'string' },
  runs: { type: 'string' },
  scores: { type: 'string' },
  'max-cost': { type: 'string' },
  'run-cap': { type: 'string' },
  problems: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  fake: { type: 'boolean', default: false },
  roster: { type: 'string', default: 'agents.yaml' },
  db: { type: 'string' },
  'problems-dir': { type: 'string', default: DEFAULT_PROBLEMS_DIR },
  out: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; strict: true }>>['values'];

const STAGES = ['generate', 'score', 'report'] as const;

const list = (raw: string | undefined): string[] =>
  raw === undefined
    ? []
    : raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/** The folder of the measurement with this label under `root`, whatever its date. */
export const findMeasurementDir = async (
  root: string,
  label: string,
): Promise<string | undefined> => {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return undefined;
  }
  const name = names.find((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n.slice(11) === label);
  return name === undefined ? undefined : join(root, name);
};

/**
 * Each swarm arm beside the call arm on its Synthesizer's own model alias, when the
 * measurement has one: the model that writes the swarm's answer, asked once on its own.
 */
export const comparisonsOf = (
  roster: Roster,
  arms: readonly Arm[],
): Result<{ swarm: Arm; call: Arm }[], string> => {
  const pairs: { swarm: Arm; call: Arm }[] = [];
  for (const arm of arms) {
    if (arm.kind !== 'swarm') continue;
    const profile = resolveProfile(roster, arm.profile);
    if (!profile.ok) return err(describeRosterError(profile.error));
    const alias = profile.value.roles.synthesizer.alias;
    const call = arms.find((a) => a.kind === 'call' && a.alias === alias);
    if (call !== undefined) pairs.push({ swarm: arm, call });
  }
  return ok(pairs);
};

const describeModel = (model: ResolvedModel): string =>
  `\`${model.alias}\` (${model.provider}/${model.model})`;

/** What stands behind every arm, the judge and the sizing model, for the report's header. */
const describeModels = (
  roster: Roster,
  arms: readonly Arm[],
  profileName: string,
): Result<Record<string, string>, string> => {
  const models: Record<string, string> = {};
  for (const arm of arms) {
    if (arm.kind === 'call') {
      const resolved = baselineStandIn(roster, arm.alias);
      if (!resolved.ok) return err(resolved.error.replace('--baseline names', '--arms names'));
      if (resolved.value !== null) {
        models[armRef(arm)] = `one call of ${describeModel(resolved.value)}`;
      }
      continue;
    }
    const profile = resolveProfile(roster, arm.profile);
    if (!profile.ok) return err(describeRosterError(profile.error));
    const roles = AGENT_ROLES.map((role) => `${role} \`${profile.value.roles[role].alias}\``);
    models[armRef(arm)] =
      `the \`${arm.profile}\` swarm: ${roles.join(', ')}, fallback ${profile.value.fallback === null ? 'none' : `\`${profile.value.fallback.alias}\``}`;
  }
  const evalModels = resolveEvalModels(roster, profileName);
  if (!evalModels.ok) return err(describeRosterError(evalModels.error));
  models['judge'] = describeModel(evalModels.value.judge);
  models['answer length sized on'] = describeModel(evalModels.value.baseline);
  return ok(models);
};

/** report.md, report.json and spot-check/ from what the store holds. */
const writeReport = async (
  dir: string,
  store: MeasureStore,
  manifest: Manifest,
  problems: readonly Problem[],
): Promise<string> => {
  const answers = await store.listAnswers();
  const scores = await store.listScores();
  const summary = summarise(manifest, answers, scores);
  const markdown = renderMeasureReport(manifest, summary);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), markdown, 'utf8');
  await writeFile(
    join(dir, 'report.json'),
    `${JSON.stringify({ manifest, summary }, null, 2)}\n`,
    'utf8',
  );
  const checks = spotChecks(manifest, summary, problems, answers, scores);
  if (checks.length > 0) await mkdir(join(dir, 'spot-check'), { recursive: true });
  for (const check of checks) {
    await writeFile(join(dir, 'spot-check', `${check.problemId}.md`), check.markdown, 'utf8');
  }
  return markdown;
};

/** The part of the report that accounts for stage 1: what a `generate` prints when it ends. */
const stageOne = (markdown: string): string[] => {
  const lines = markdown.split('\n');
  const from = lines.indexOf('## Stage 1: the answers');
  const to = lines.indexOf('## Stage 2: the scores');
  return from === -1 ? [] : lines.slice(from, to === -1 ? undefined : to);
};

export const measureMain = async (
  argv: readonly string[],
  io: EvalIo,
  env: Env = {},
  clock: Clock = systemClock,
): Promise<number> => {
  const usage = (message?: string): number => {
    if (message !== undefined) io.write(message);
    MEASURE_USAGE.forEach((line) => {
      io.write(line);
    });
    return message === undefined ? 0 : 2;
  };
  const [stageArg, ...rest] = argv;
  let values: Values;
  try {
    values = parseArgs({
      args: stageArg !== undefined && stageArg.startsWith('-') ? [...argv] : rest,
      options,
      strict: true,
    }).values;
  } catch (cause) {
    return usage(cause instanceof Error ? cause.message : 'bad arguments');
  }
  if (values.help) return usage();
  const stage = STAGES.find((s) => s === stageArg);
  if (stage === undefined) return usage('say what to do: generate, score or report');
  if (values.label === undefined || values.label === '') return usage('--label is required');
  const label = values.label;

  const cap = money(values['max-cost'], '--max-cost', DEFAULT_PASS_CAP_USD);
  const runCap = money(
    values['run-cap'],
    '--run-cap',
    values.fake ? DEFAULT_FAKE_RUN_CAP_USD : DEFAULT_RUN_CAP_USD,
  );
  const runs = integer(values.runs, '--runs', DEFAULT_RUNS);
  const scores = integer(values.scores, '--scores', DEFAULT_SCORES);
  for (const parsed of [cap, runCap, runs, scores]) {
    if (!parsed.ok) {
      io.write(parsed.error);
      return 2;
    }
  }
  if (!cap.ok || !runCap.ok || !runs.ok || !scores.ok) return 2;
  if (runs.value < 1 || scores.value < 1) {
    io.write('--runs and --scores must be at least 1');
    return 2;
  }

  const roster = await loadRosterFile(values.roster);
  if (!roster.ok) {
    io.write(roster.error);
    return 2;
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

  // The folder: an earlier stage's, found by the label, or a new one dated today.
  const outRoot =
    values.out ?? (values.fake ? join(DEFAULT_RESULTS_DIR, 'fake') : DEFAULT_RESULTS_DIR);
  const existing = await findMeasurementDir(outRoot, label);
  const date = new Date(clock.nowMs()).toISOString().slice(0, 10);
  const dir = existing ?? join(outRoot, `${date}-${label}`);
  const store = fileMeasureStore(dir);
  const stored = await store.readManifest();
  if (stage !== 'generate' && stored === undefined) {
    io.write(`no measurement labelled "${label}" under ${outRoot}: run generate first`);
    return 2;
  }

  // The manifest: what the measurement is, fixed by the first `generate`.
  const answerTokens = defaultRunConfig().writeUp.maxOutputTokens;
  let manifest: Manifest;
  if (stored !== undefined) {
    if (stored.fake !== values.fake) {
      io.write(
        `the measurement "${label}" was ${stored.fake ? 'made with --fake' : 'made with real models'}; this invocation ${values.fake ? 'has --fake' : 'has not'}`,
      );
      return 2;
    }
    const given = list(values.arms);
    if (given.length > 0 && given.join(',') !== stored.arms.map(armRef).join(',')) {
      io.write(
        `the measurement "${label}" has the arms ${describeArms(stored.arms)}; they cannot be changed (leave --arms out, or use another label)`,
      );
      return 2;
    }
    if (values.runs !== undefined && runs.value !== stored.runs) {
      io.write(
        `the measurement "${label}" has ${String(stored.runs)} runs per swarm arm; that cannot be changed`,
      );
      return 2;
    }
    if (values.profile !== undefined && values.profile !== stored.profile) {
      io.write(
        `the measurement "${label}" is judged and sized by the profile "${stored.profile}"; that cannot be changed`,
      );
      return 2;
    }
    manifest = {
      ...stored,
      scoresPerAnswer:
        stage === 'score' && values.scores !== undefined ? scores.value : stored.scoresPerAnswer,
      caps: {
        generateUsd: stage === 'generate' ? cap.value : stored.caps.generateUsd,
        scoreUsd: stage === 'score' ? cap.value : stored.caps.scoreUsd,
      },
    };
  } else {
    const arms: Arm[] = [];
    for (const item of list(values.arms)) {
      const arm = parseArm(item);
      if (!arm.ok) {
        io.write(`--arms: ${arm.error}`);
        return 2;
      }
      if (arms.some((a) => sameArm(a, arm.value))) {
        io.write(`--arms names ${item} twice`);
        return 2;
      }
      arms.push(arm.value);
    }
    if (arms.length === 0) return usage('a new measurement needs --arms');
    const profile = resolveProfile(roster.value, values.profile);
    if (!profile.ok) {
      io.write(describeRosterError(profile.error));
      return 2;
    }
    const models = describeModels(roster.value, arms, profile.value.name);
    if (!models.ok) {
      io.write(models.error);
      return 2;
    }
    const comparisons = comparisonsOf(roster.value, arms);
    if (!comparisons.ok) {
      io.write(comparisons.error);
      return 2;
    }
    manifest = {
      label,
      createdAt: new Date(clock.nowMs()).toISOString(),
      commit: await gitCommit(),
      profile: profile.value.name,
      arms,
      runs: runs.value,
      scoresPerAnswer: scores.value,
      problemIds: loaded.value.map((p) => p.id),
      wordBudget: wordBudgetFor(answerTokens),
      runCapUsd: runCap.value,
      comparisons: comparisons.value,
      models: models.value,
      caps: { generateUsd: cap.value, scoreUsd: null },
      fake: values.fake,
    };
  }
  if (values['run-cap'] !== undefined && runCap.value !== manifest.runCapUsd) {
    io.write(
      `the measurement "${label}" has a run cap of $${manifest.runCapUsd.toFixed(4)}; that cannot be changed`,
    );
    return 2;
  }
  // The measurement is of the problems it was made with; an invocation may work on some.
  const all = loaded.value.filter((p) => manifest.problemIds.includes(p.id));
  const gone = manifest.problemIds.filter((id) => !all.some((p) => p.id === id));
  if (gone.length > 0) {
    io.write(
      `the measurement "${label}" covers problems that are no longer there: ${gone.join(', ')}`,
    );
    return 2;
  }
  const problems = all.filter((p) => wanted === null || wanted.includes(p.id));
  if (problems.length === 0) {
    io.write('no problems to work on');
    return 2;
  }

  if (stage === 'report') {
    await writeReport(dir, store, manifest, all);
    io.write(`Wrote ${join(dir, 'report.md')}`);
    return 0;
  }

  const evalModels = resolveEvalModels(roster.value, manifest.profile);
  if (!evalModels.ok) {
    io.write(describeRosterError(evalModels.error));
    return 2;
  }
  // Which arms can spend API money, from the roster alone: nothing is built or called yet.
  const callAliases = new Map<string, ResolvedModel>();
  const swarmProfiles = new Map<string, ReturnType<typeof resolveProfile> & { ok: true }>();
  for (const arm of manifest.arms) {
    if (arm.kind === 'call') {
      const resolved = baselineStandIn(roster.value, arm.alias);
      if (!resolved.ok || resolved.value === null) {
        io.write(resolved.ok ? `unknown model alias "${arm.alias}"` : resolved.error);
        return 2;
      }
      callAliases.set(arm.alias, resolved.value);
    } else {
      const profile = resolveProfile(roster.value, arm.profile);
      if (!profile.ok) {
        io.write(describeRosterError(profile.error));
        return 2;
      }
      swarmProfiles.set(arm.profile, profile);
    }
  }
  const paid =
    !values.fake &&
    (stage === 'score'
      ? isPaidProvider(evalModels.value.judge.provider)
      : [...callAliases.values()].some((m) => isPaidProvider(m.provider)) ||
        [...swarmProfiles.values()].some((p) => p.value.paid));

  const opened = openDatabase(values.db ?? env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  try {
    const logger = createCliLogger(io.write.bind(io), false);
    const ids = createUuidV7Generator(clock);
    const boardStore = new SqliteBoardStore(opened.db);
    const calls = new ModelCallStore(opened.db, { ids, logger });
    const ledger = new SqliteSpendLedger(opened.db);
    const now = (): number => clock.nowMs();
    const sink = calls.sink;
    const factory = createModelFactory({
      anthropicApiKey: env['ANTHROPIC_API_KEY'],
      ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
      priceTable: PRICE_TABLE,
      sink,
      now,
      charsPerToken: (resolved: ResolvedModel, providerDefault: number) =>
        calls.charsPerToken(resolved, providerDefault),
    });
    const modelFor = (resolved: ResolvedModel): Result<Model, string> => {
      const model = factory.modelFor(resolved);
      return model.ok ? model : err(describeFactoryError(model.error));
    };

    // The month: the banner, the refusal, the confirmation, and the guard the stage re-reads.
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
    const monthSpentUsd = await ledger.spentUsd(period.value);
    const month: MonthGuard | null = paid
      ? { spentUsd: () => ledger.spentUsd(period.value), limitUsd: settings.value.limitUsd }
      : null;
    const stageSpentUsd =
      stage === 'generate'
        ? (await store.listAnswers()).reduce((sum, a) => sum + a.spentUsd, 0)
        : (await store.listScores()).reduce((sum, s) => sum + s.spentUsd, 0);
    const stageLeftUsd = Math.max(0, cap.value - stageSpentUsd);

    io.write(`== Measurement "${label}": ${stage} ==`);
    io.write(`  folder        ${dir}${existing === undefined ? ' (new)' : ''}`);
    io.write(`  arms          ${describeArms(manifest.arms)}`);
    for (const [name, what] of Object.entries(manifest.models)) {
      io.write(`    ${name}: ${what.replace(/`/g, '')}`);
    }
    io.write(
      `  problems      ${String(problems.length)} of ${String(manifest.problemIds.length)}; ${String(manifest.runs)} runs per swarm arm, ${String(manifest.scoresPerAnswer)} scores per answer`,
    );
    io.write(
      `  stage cap     $${cap.value.toFixed(4)}, of which $${stageSpentUsd.toFixed(4)} spent by earlier invocations`,
    );
    io.write(
      `  this month    $${monthSpentUsd.toFixed(4)} of $${settings.value.limitUsd.toFixed(2)}`,
    );
    if (values.fake) io.write('  --fake: scripted models stand in for these; nothing is billed.');

    const sessionId = ids.next();
    const problemIds = problems.map((p) => p.id);

    if (stage === 'generate') {
      let sizingModel: Model;
      if (values.fake) {
        sizingModel = traceModel(createFakeBaseline(SCENARIO_PRICING), sink, now);
      } else {
        const sizing = modelFor(evalModels.value.baseline);
        if (!sizing.ok) {
          io.write(sizing.error);
          return 2;
        }
        sizingModel = sizing.value;
      }
      // Every problem of the measurement is sized, not only this invocation's: a problem
      // that would be asked for another length is found before anything is spent.
      const sizes = sizeAnswers(all, sizingModel, manifest.runCapUsd, answerTokens);
      const wrong = sizeProblems(sizes, manifest.wordBudget);
      io.write(
        `  answer length about ${String(manifest.wordBudget)} words: an allowance of ${String(Math.min(...sizes.map((s) => s.maxOutputTokens ?? 0)))} to ${String(Math.max(...sizes.map((s) => s.maxOutputTokens ?? 0)))} output tokens under the $${manifest.runCapUsd.toFixed(4)} run cap`,
      );
      if (wrong.length > 0) {
        io.write('Refusing: not every problem would be asked for the same length.');
        wrong.forEach((line) => {
          io.write(`  ${line}`);
        });
        return 2;
      }
      const todo: string[] = [];
      for (const arm of manifest.arms) {
        const keys = answerKeys(problemIds, [arm], manifest.runs);
        let onDisk = 0;
        for (const key of keys) {
          const record = await store.readAnswer(key);
          if (record !== undefined && record.outcome !== 'failed') onDisk += 1;
        }
        todo.push(`${armRef(arm)} ${String(keys.length - onDisk)} of ${String(keys.length)}`);
      }
      io.write(`  to make       ${todo.join('; ')}`);
      if (values['dry-run']) {
        io.write('Dry run: nothing made, nothing spent.');
        return 0;
      }
      if (paid) {
        if (monthSpentUsd + stageLeftUsd > settings.value.limitUsd) {
          const fits = Math.max(0, settings.value.limitUsd - monthSpentUsd + stageSpentUsd);
          io.write(
            `Refusing: this month has $${Math.max(0, settings.value.limitUsd - monthSpentUsd).toFixed(4)} left of $${settings.value.limitUsd.toFixed(2)}, less than the $${stageLeftUsd.toFixed(4)} the stage cap still allows; pass --max-cost ${fits.toFixed(2)} or lower.`,
          );
          return 2;
        }
        if (!values.yes) {
          if (io.confirm === undefined) {
            io.write('Refusing to start a paid stage without confirmation: pass --yes.');
            return 2;
          }
          if (!(await io.confirm('Proceed? [y/N] '))) {
            io.write('Aborted.');
            return 2;
          }
        }
      }
      await store.writeManifest(manifest);

      const prompts = await loadPromptFiles(roster.value, values.roster);
      if (!prompts.ok) {
        io.write(prompts.error);
        return 2;
      }
      const writeUpPrompt = await loadWriteUpPrompt(roster.value, values.roster);
      if (!writeUpPrompt.ok) {
        io.write(writeUpPrompt.error);
        return 2;
      }
      const callModels = new Map<string, Result<Model, string>>();
      const callModel = (alias: string): Result<Model, string> => {
        const known = callModels.get(alias);
        if (known !== undefined) return known;
        const resolved = callAliases.get(alias);
        const built: Result<Model, string> =
          resolved === undefined
            ? err(`unknown model alias "${alias}"`)
            : values.fake
              ? ok(traceModel(createFakeBaseline(SCENARIO_PRICING), sink, now))
              : modelFor(resolved);
        callModels.set(alias, built);
        return built;
      };
      // A profile's models are built when its first run is due, and once: the pre-flight
      // loads its local model, and a failure to reach it is not asked for again per run.
      const swarms = new Map<string, Promise<Result<SwarmArm, string>>>();
      const swarm = (name: string): Promise<Result<SwarmArm, string>> => {
        const known = swarms.get(name);
        if (known !== undefined) return known;
        const build = async (): Promise<Result<SwarmArm, string>> => {
          const profile = swarmProfiles.get(name);
          if (profile === undefined) return err(`unknown profile "${name}"`);
          const shared = {
            store: boardStore,
            clock,
            ids,
            logger,
            profile: profile.value,
            prompts: prompts.value,
            writeUpPrompt: writeUpPrompt.value,
            calls,
          };
          if (values.fake) {
            const scripted = createScriptedSwarm(sink, now);
            return ok({
              paid: true,
              run: createSwarmRunner({
                ...shared,
                periodBudget: undefined,
                models: scripted.models,
                onController: scripted.onController,
              }),
            });
          }
          const built = await createProfileModels(profile.value, {
            anthropicApiKey: env['ANTHROPIC_API_KEY'],
            ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
            priceTable: PRICE_TABLE,
            sink,
            now,
            charsPerToken: (resolved: ResolvedModel, providerDefault: number) =>
              calls.charsPerToken(resolved, providerDefault),
            onProgress: (line) => {
              io.write(line);
            },
          });
          if (!built.ok) return err(describeProfileModelsError(built.error));
          return ok({
            paid: profile.value.paid,
            run: createSwarmRunner({
              ...shared,
              periodBudget: profile.value.paid ? { ...settings.value, ledger } : undefined,
              models: { roles: built.value.roles, fallback: built.value.fallback },
            }),
          });
        };
        const pending = build();
        swarms.set(name, pending);
        return pending;
      };

      io.write(`Session ${sessionId}`);
      const tally = await runGenerate(
        {
          sessionId,
          problems,
          arms: manifest.arms,
          runs: manifest.runs,
          capUsd: cap.value,
          runCapUsd: manifest.runCapUsd,
          wordBudget: manifest.wordBudget,
          maxOutputTokens: answerTokens,
        },
        {
          store,
          sizingModel,
          callModel,
          swarm,
          month,
          commit: await gitCommit(),
          now,
          log: (line) => {
            io.write(line);
          },
        },
      );
      if (!tally.ok) {
        io.write('Refusing: not every problem would be asked for the same length.');
        tally.error.forEach((line) => {
          io.write(`  ${line}`);
        });
        return 2;
      }
      const markdown = await writeReport(dir, store, manifest, all);
      io.write('');
      io.write(describeTally('Stage 1', tally.value, 'answers'));
      io.write('');
      stageOne(markdown).forEach((line) => {
        io.write(line);
      });
      io.write(`Wrote ${join(dir, 'report.md')}`);
      return 0;
    }

    // Stage 2.
    let judgeModel: Model;
    if (values.fake) {
      judgeModel = traceModel(createFakeJudge(SCENARIO_PRICING), sink, now);
    } else {
      const judge = modelFor(evalModels.value.judge);
      if (!judge.ok) {
        io.write(judge.error);
        return 2;
      }
      judgeModel = judge.value;
    }
    let toGive = 0;
    let onDisk = 0;
    for (const key of scoreKeys(
      problemIds,
      manifest.arms,
      manifest.runs,
      manifest.scoresPerAnswer,
    )) {
      if ((await store.readAnswer(key))?.outcome !== 'answered') continue;
      if ((await store.readScore(key))?.outcome === 'scored') onDisk += 1;
      else toGive += 1;
    }
    io.write(`  to give       ${String(toGive)} scores; ${String(onDisk)} already on disk`);
    if (values['dry-run']) {
      io.write('Dry run: nothing scored, nothing spent.');
      return 0;
    }
    if (paid) {
      if (monthSpentUsd + stageLeftUsd > settings.value.limitUsd) {
        const fits = Math.max(0, settings.value.limitUsd - monthSpentUsd + stageSpentUsd);
        io.write(
          `Refusing: this month has $${Math.max(0, settings.value.limitUsd - monthSpentUsd).toFixed(4)} left of $${settings.value.limitUsd.toFixed(2)}, less than the $${stageLeftUsd.toFixed(4)} the stage cap still allows; pass --max-cost ${fits.toFixed(2)} or lower.`,
        );
        return 2;
      }
      if (!values.yes) {
        if (io.confirm === undefined) {
          io.write('Refusing to start a paid stage without confirmation: pass --yes.');
          return 2;
        }
        if (!(await io.confirm('Proceed? [y/N] '))) {
          io.write('Aborted.');
          return 2;
        }
      }
    }
    await store.writeManifest(manifest);
    io.write(`Session ${sessionId}`);
    const tally = await runScore(
      {
        sessionId,
        problems,
        arms: manifest.arms,
        runs: manifest.runs,
        scores: manifest.scoresPerAnswer,
        capUsd: cap.value,
        judgeMaxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      },
      {
        store,
        judgeModel,
        month,
        now,
        log: (line) => {
          io.write(line);
        },
      },
    );
    await writeReport(dir, store, manifest, all);
    io.write('');
    io.write(describeTally('Stage 2', tally, 'scores'));
    io.write(`Wrote ${join(dir, 'report.md')}`);
    return 0;
  } finally {
    opened.close();
  }
};
