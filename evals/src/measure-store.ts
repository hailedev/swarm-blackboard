import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  err,
  ok,
  RunEndReasonSchema,
  RunStatusSchema,
  SynthesisStageSchema,
  UsageSchema,
  WriteUpRetryReasonSchema,
  type Result,
} from '@team/core';
import { z } from 'zod';

// What a measurement (`pnpm eval:measure`, measure.ts) keeps on disk: one record for every
// answer it asked for and one for every score an answer was given, each in a file of its
// own, so a stage that is interrupted, or stopped by its cap, picks up where it left off.
// Every attempt leaves a record. `answered`, `void` and `scored` are outcomes and are kept;
// `failed` means nothing came of the attempt for a reason outside the arm (the local model
// was unreachable, the provider was overloaded) and is tried again by the next invocation,
// with what it cost carried forward.
//
//   <dir>/manifest.json
//   <dir>/answers/<problem>/call-sonnet.json
//   <dir>/answers/<problem>/swarm-cheap--r2.json
//   <dir>/scores/<problem>/swarm-cheap--r2--s1.json

// ── Arms ─────────────────────────────────────────────────────────────────────────────────

/** One way of answering a problem: a single call of a model alias, or a swarm profile. */
export const ArmSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('call'), alias: z.string().min(1) }),
  z.object({ kind: z.literal('swarm'), profile: z.string().min(1) }),
]);
export type Arm = z.infer<typeof ArmSchema>;

/** `call:sonnet`, `swarm:cheap`: how the command line and the report name an arm. */
export const armRef = (arm: Arm): string =>
  arm.kind === 'call' ? `call:${arm.alias}` : `swarm:${arm.profile}`;

/** The same, fit for a file name. */
export const armSlug = (arm: Arm): string =>
  (arm.kind === 'call' ? `call-${arm.alias}` : `swarm-${arm.profile}`).replace(
    /[^a-z0-9.-]/gi,
    '_',
  );

export const sameArm = (a: Arm, b: Arm): boolean => armRef(a) === armRef(b);

export const parseArm = (text: string): Result<Arm, string> => {
  const [kind, name, ...rest] = text.split(':');
  if (rest.length > 0 || name === undefined || name === '') {
    return err(`"${text}" is not call:<alias> or swarm:<profile>`);
  }
  if (kind === 'call') return ok({ kind, alias: name });
  if (kind === 'swarm') return ok({ kind, profile: name });
  return err(`"${text}" is not call:<alias> or swarm:<profile>`);
};

// ── Answers ──────────────────────────────────────────────────────────────────────────────

/** Which answer: a call arm has one per problem (run 1), a swarm arm one per run. */
export interface AnswerKey {
  problemId: string;
  arm: Arm;
  run: number;
}

export const answerSlug = (key: AnswerKey): string =>
  key.arm.kind === 'call' ? armSlug(key.arm) : `${armSlug(key.arm)}--r${String(key.run)}`;

export const answerId = (key: AnswerKey): string => `${key.problemId}/${answerSlug(key)}`;

const CallDetailSchema = z.object({
  kind: z.literal('call'),
  modelId: z.string().min(1),
  maxOutputTokens: z.int().positive(),
  usage: UsageSchema,
  latencyMs: z.int().nonnegative(),
  /** 2 when the first answer came back under half its word budget and the call was made again. */
  attempts: z.int().min(1),
  /** The answer used its whole allowance, so its end is probably missing. */
  truncated: z.boolean(),
});

const SwarmDetailSchema = z.object({
  kind: z.literal('swarm'),
  runId: z.string().min(1),
  rounds: z.int().nonnegative(),
  status: RunStatusSchema,
  reason: RunEndReasonSchema,
  entries: z.int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  usage: UsageSchema,
  confidence: z.number().nullable(),
  /** `final` when the answer is the run's write-up, `draft` when the write-up failed. */
  stage: SynthesisStageSchema.nullable(),
  writeUp: z
    .object({
      maxOutputTokens: z.int().positive(),
      wordBudget: z.int().positive(),
      written: z.boolean(),
      costUsd: z.number().nonnegative(),
      attempts: z.int().min(1),
      short: z.boolean(),
      retriedFor: z.array(WriteUpRetryReasonSchema),
      /** Sentences of the answer that mention the board, the agents or its writer's confidence. */
      leaks: z.array(z.string()),
    })
    .nullable(),
  /** Why the answer is not the write-up, in the controller's words; null when it is. */
  writeUpFailure: z.string().nullable(),
  critiques: z.object({ raised: z.int().nonnegative(), resolved: z.int().nonnegative() }),
  calls: z.object({ made: z.int().nonnegative(), rejected: z.int().nonnegative() }),
});

const AnswerBase = {
  problemId: z.string().min(1),
  arm: ArmSchema,
  run: z.int().min(1),
  at: z.string().min(1),
  /** The commit the answer was made on. */
  commit: z.string().nullable(),
  /** Everything paid for this answer: earlier failed attempts and discarded retries included. */
  spentUsd: z.number().nonnegative(),
  /** How many invocations have tried for it. */
  tries: z.int().min(1),
};

export const MeasuredAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...AnswerBase,
    outcome: z.literal('answered'),
    text: z.string().min(1),
    words: z.int().positive(),
    /** The words it was asked for. */
    wordBudget: z.int().positive(),
    detail: z.discriminatedUnion('kind', [CallDetailSchema, SwarmDetailSchema]),
  }),
  // Not an answer to score: none came, or it is under half its word budget after its retry.
  z.object({
    ...AnswerBase,
    outcome: z.literal('void'),
    why: z.string().min(1),
    text: z.string().nullable(),
    words: z.int().nonnegative(),
    wordBudget: z.int().positive().nullable(),
    detail: z.discriminatedUnion('kind', [CallDetailSchema, SwarmDetailSchema]),
  }),
  // Nothing came of the attempt, for a reason outside the arm: tried again next time.
  z.object({ ...AnswerBase, outcome: z.literal('failed'), why: z.string().min(1) }),
]);
export type MeasuredAnswer = z.infer<typeof MeasuredAnswerSchema>;
export type AnsweredAnswer = Extract<MeasuredAnswer, { outcome: 'answered' }>;
export type AnswerDetail = AnsweredAnswer['detail'];

// ── Scores ───────────────────────────────────────────────────────────────────────────────

/** Which score: an answer is scored `score` = 1, 2, … times, each by a call of its own. */
export interface ScoreKey extends AnswerKey {
  score: number;
}

export const scoreSlug = (key: ScoreKey): string => `${answerSlug(key)}--s${String(key.score)}`;

const ScoreBase = {
  problemId: z.string().min(1),
  arm: ArmSchema,
  run: z.int().min(1),
  score: z.int().min(1),
  at: z.string().min(1),
  judgeModelId: z.string().min(1),
  spentUsd: z.number().nonnegative(),
  tries: z.int().min(1),
};

export const ScoreRecordSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...ScoreBase,
    outcome: z.literal('scored'),
    /** The weighted rubric percentage, as a pass computes it. */
    percent: z.number().min(0).max(100),
    /** Per rubric criterion, the judge's reason and its 0 to 3. */
    scores: z.record(z.string(), z.object({ reason: z.string(), score: z.int().min(0).max(3) })),
    note: z.string(),
    usage: UsageSchema,
  }),
  z.object({ ...ScoreBase, outcome: z.literal('failed'), why: z.string().min(1) }),
]);
export type ScoreRecord = z.infer<typeof ScoreRecordSchema>;
export type ScoredRecord = Extract<ScoreRecord, { outcome: 'scored' }>;

// ── Manifest ─────────────────────────────────────────────────────────────────────────────

/** What the measurement is: fixed when it is first generated, read by every later stage. */
export const ManifestSchema = z.object({
  label: z.string().min(1),
  createdAt: z.string().min(1),
  commit: z.string().nullable(),
  /** The profile whose judge scores the answers and whose baseline model sizes them. */
  profile: z.string().min(1),
  /** In the order they are worked through. */
  arms: z.array(ArmSchema).min(1),
  /** Runs of each swarm arm per problem; a call arm has one answer per problem. */
  runs: z.int().min(1),
  /** How many times each answer is scored. */
  scoresPerAnswer: z.int().min(1),
  /** Every problem of the measurement, in file order. */
  problemIds: z.array(z.string().min(1)).min(1),
  /** The words every answer is asked for. */
  wordBudget: z.int().positive(),
  /** The cap on each swarm run, and the cap the answer's length is sized under. */
  runCapUsd: z.number().nonnegative(),
  /** Each swarm arm beside the call arm it is compared with: its Synthesizer's own model. */
  comparisons: z.array(z.object({ swarm: ArmSchema, call: ArmSchema })),
  /** What stands behind each arm, the judge and the sizing model, for the report's header. */
  models: z.record(z.string(), z.string()),
  /** The stage caps as last given: dollars over the whole stage, across invocations. */
  caps: z.object({ generateUsd: z.number().nullable(), scoreUsd: z.number().nullable() }),
  fake: z.boolean(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ── The store ────────────────────────────────────────────────────────────────────────────

export interface MeasureStore {
  readManifest(): Promise<Manifest | undefined>;
  writeManifest(manifest: Manifest): Promise<void>;
  readAnswer(key: AnswerKey): Promise<MeasuredAnswer | undefined>;
  writeAnswer(record: MeasuredAnswer): Promise<void>;
  listAnswers(): Promise<MeasuredAnswer[]>;
  readScore(key: ScoreKey): Promise<ScoreRecord | undefined>;
  writeScore(record: ScoreRecord): Promise<void>;
  listScores(): Promise<ScoreRecord[]>;
}

const readJson = async (path: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A file cut off mid-write is as good as absent: the item is done again.
    return undefined;
  }
};

const writeJson = async (dir: string, name: string, value: unknown): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

/** Every `.json` under `<root>/<problem>/`, parsed; unreadable files are left out. */
const readAll = async <T>(root: string, schema: z.ZodType<T>): Promise<T[]> => {
  let problems: string[];
  try {
    problems = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const problem of problems) {
    let names: string[];
    try {
      names = (await readdir(join(root, problem))).filter((n) => n.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const parsed = schema.safeParse(await readJson(join(root, problem, name)));
      if (parsed.success) records.push(parsed.data);
    }
  }
  return records;
};

/** The measurement's folder on disk. */
export const fileMeasureStore = (dir: string): MeasureStore => {
  const answers = join(dir, 'answers');
  const scores = join(dir, 'scores');
  return {
    async readManifest() {
      const parsed = ManifestSchema.safeParse(await readJson(join(dir, 'manifest.json')));
      return parsed.success ? parsed.data : undefined;
    },
    writeManifest: (manifest) => writeJson(dir, 'manifest.json', manifest),
    async readAnswer(key) {
      const parsed = MeasuredAnswerSchema.safeParse(
        await readJson(join(answers, key.problemId, `${answerSlug(key)}.json`)),
      );
      return parsed.success ? parsed.data : undefined;
    },
    writeAnswer: (record) =>
      writeJson(join(answers, record.problemId), `${answerSlug(record)}.json`, record),
    listAnswers: () => readAll(answers, MeasuredAnswerSchema),
    async readScore(key) {
      const parsed = ScoreRecordSchema.safeParse(
        await readJson(join(scores, key.problemId, `${scoreSlug(key)}.json`)),
      );
      return parsed.success ? parsed.data : undefined;
    },
    writeScore: (record) =>
      writeJson(join(scores, record.problemId), `${scoreSlug(record)}.json`, record),
    listScores: () => readAll(scores, ScoreRecordSchema),
  };
};

/** The same store in memory, for tests. */
export const memoryMeasureStore = (): MeasureStore => {
  let manifest: Manifest | undefined;
  const answers = new Map<string, MeasuredAnswer>();
  const scores = new Map<string, ScoreRecord>();
  const scoreId = (key: ScoreKey): string => `${key.problemId}/${scoreSlug(key)}`;
  const sorted = <T>(map: Map<string, T>): T[] =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  return {
    readManifest: () => Promise.resolve(manifest),
    writeManifest: (next) => {
      manifest = next;
      return Promise.resolve();
    },
    readAnswer: (key) => Promise.resolve(answers.get(answerId(key))),
    writeAnswer: (record) => {
      answers.set(answerId(record), record);
      return Promise.resolve();
    },
    listAnswers: () => Promise.resolve(sorted(answers)),
    readScore: (key) => Promise.resolve(scores.get(scoreId(key))),
    writeScore: (record) => {
      scores.set(scoreId(record), record);
      return Promise.resolve();
    },
    listScores: () => Promise.resolve(sorted(scores)),
  };
};
