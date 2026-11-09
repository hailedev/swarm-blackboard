import {
  buildAgentRequest,
  linkProblems,
  resolveHandles,
  roleDefinitions,
  type AgentRequest,
  type AgentRole,
  type Model,
  type ModelError,
} from '@team/core';
import { agentContext, decomposedBoard, lateBoard, midRunBoard } from '@team/core/testing';
import {
  createOllamaModel,
  FORMAT_PROBE,
  preflightOllama,
  probeOllamaFormat,
  type OllamaFormatProbeResult,
  type OllamaPreflightError,
} from '@team/providers';

import type { RolePrompts } from '../adapters/prompt-files';
import { createUuidV7Generator } from '../adapters/uuid-v7';
import { systemClock } from '../adapters/system-clock';

// The Phase 2 local-model trial (docs/PLAN.md §4 notes, ADR-0008): which local model
// backs the worker roles. Ranked on structured-output reliability first, link validity
// second, speed third. Every call goes through the same adapter the swarm uses, on the
// real role prompts, realistic boards and the per-call handle schema an agent would send.

export type Outcome = 'ok' | 'schema' | 'truncated' | 'empty' | 'provider';

export const BOARDS = ['decomposed', 'mid-run', 'late'] as const;
export type BoardName = (typeof BOARDS)[number];

export interface TrialCell {
  model: string;
  role: AgentRole;
  think: boolean;
  board: BoardName;
  rep: number;
  outcome: Outcome;
  errorKind: string | null;
  issues: readonly string[];
  contributions: number;
  /** Unresolvable handles plus the controller's commit-time link problems, over all contributions. */
  linkProblems: number;
  /** Handles the prompt named, i.e. the size of the enum the schema carried. */
  handles: number;
  latencyMs: number;
  /** Prompt tokens the provider reported; null on an Ollama KV-cache hit. */
  inputTokens: number | null;
  outputTokens: number;
  warnings: readonly string[];
  /** The validated object, or the raw text (clipped) of a rejected answer. */
  sample: unknown;
}

export interface ProbeReport {
  valid: number;
  total: number;
  results: readonly OllamaFormatProbeResult[];
}

export interface ModelReport {
  model: string;
  preflight:
    { ok: true; version: string; loadMs: number } | { ok: false; error: OllamaPreflightError };
  /** Strict enum/integer schema sent raw as `format`: is the format honoured at all? */
  strictProbe: ProbeReport | null;
  /** The real Researcher schema (handle enums) sent raw as `format`, one prompt each. */
  researcherProbe: ProbeReport | null;
  cells: TrialCell[];
}

export interface CellSummary {
  model: string;
  role: AgentRole;
  think: boolean;
  n: number;
  validPct: number;
  truncatedPct: number;
  schemaPct: number;
  providerPct: number;
  /** Share of valid answers whose links all resolved. */
  linkValidPct: number | null;
  medianLatencyMs: number;
  p90LatencyMs: number;
  medianOutputTokens: number;
  cacheHits: number;
}

export interface ModelRank {
  model: string;
  validPct: number;
  linkValidPct: number | null;
  medianLatencyMs: number;
  n: number;
}

export interface TrialReport {
  ranAt: string;
  baseUrl: string;
  reps: number;
  roles: readonly AgentRole[];
  models: ModelReport[];
  summary: CellSummary[];
  ranking: ModelRank[];
}

export interface TrialOptions {
  baseUrl: string;
  models: readonly string[];
  roles: readonly AgentRole[];
  reps: number;
  prompts: RolePrompts;
  maxOutputTokens?: number;
  now?: () => number;
  log: (line: string) => void;
}

const SAMPLE_CHARS = 2_000;

const classify = (error: ModelError): { outcome: Outcome; issues: readonly string[] } => {
  if (error.kind !== 'invalid_output') return { outcome: 'provider', issues: [] };
  const first = error.issues[0] ?? '';
  if (first.startsWith('output truncated')) return { outcome: 'truncated', issues: error.issues };
  if (first.startsWith('no output')) return { outcome: 'empty', issues: error.issues };
  return { outcome: 'schema', issues: error.issues };
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (high === undefined) return 0;
  return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
};

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
};

const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

// Different prompts per repetition, so Ollama's KV cache does not answer the same prompt
// three times: rotate the trigger's targets (all, first half, second half, reversed).
export const targetVariant = (ids: readonly string[], rep: number): readonly string[] => {
  if (ids.length <= 1) return ids;
  const half = Math.ceil(ids.length / 2);
  const variants = [ids, ids.slice(0, half), ids.slice(half), [...ids].reverse()];
  const chosen = variants[rep % variants.length] ?? ids;
  return chosen.length === 0 ? ids : chosen;
};

/** Per (model, role, think): the numbers ADR-0008 quotes. */
export const summarise = (cells: readonly TrialCell[]): CellSummary[] => {
  const groups = new Map<string, TrialCell[]>();
  for (const cell of cells) {
    const key = `${cell.model}\u0000${cell.role}\u0000${String(cell.think)}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    if (first === undefined) throw new Error('empty group');
    const ok = group.filter((c) => c.outcome === 'ok');
    const count = (outcome: Outcome): number => group.filter((c) => c.outcome === outcome).length;
    return {
      model: first.model,
      role: first.role,
      think: first.think,
      n: group.length,
      validPct: pct(ok.length, group.length),
      truncatedPct: pct(count('truncated'), group.length),
      schemaPct: pct(count('schema') + count('empty'), group.length),
      providerPct: pct(count('provider'), group.length),
      linkValidPct:
        ok.length === 0 ? null : pct(ok.filter((c) => c.linkProblems === 0).length, ok.length),
      medianLatencyMs: Math.round(median(group.map((c) => c.latencyMs))),
      p90LatencyMs: Math.round(
        percentile(
          group.map((c) => c.latencyMs),
          90,
        ),
      ),
      medianOutputTokens: Math.round(median(group.map((c) => c.outputTokens))),
      cacheHits: group.filter((c) => c.inputTokens === null).length,
    };
  });
};

/** Reliability first, link validity second, speed third (docs/PLAN.md §4). */
export const rankModels = (cells: readonly TrialCell[]): ModelRank[] => {
  const models = [...new Set(cells.map((c) => c.model))];
  return models
    .map((model) => {
      const own = cells.filter((c) => c.model === model);
      const ok = own.filter((c) => c.outcome === 'ok');
      return {
        model,
        n: own.length,
        validPct: pct(ok.length, own.length),
        linkValidPct:
          ok.length === 0 ? null : pct(ok.filter((c) => c.linkProblems === 0).length, ok.length),
        medianLatencyMs: Math.round(median(own.map((c) => c.latencyMs))),
      };
    })
    .sort(
      (a, b) =>
        b.validPct - a.validPct ||
        (b.linkValidPct ?? -1) - (a.linkValidPct ?? -1) ||
        a.medianLatencyMs - b.medianLatencyMs,
    );
};

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

export const renderSummaryTable = (summary: readonly CellSummary[]): string[] => [
  '| Model | Role | Think | n | Valid % | Truncated % | Schema % | Provider % | Links OK % | Median s | p90 s | Median out tok | Cache hits |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...summary.map(
    (s) =>
      `| ${s.model} | ${s.role} | ${s.think ? 'on' : 'off'} | ${String(s.n)} | ${String(s.validPct)} | ${String(s.truncatedPct)} | ${String(s.schemaPct)} | ${String(s.providerPct)} | ${s.linkValidPct === null ? '-' : String(s.linkValidPct)} | ${seconds(s.medianLatencyMs)} | ${seconds(s.p90LatencyMs)} | ${String(s.medianOutputTokens)} | ${String(s.cacheHits)} |`,
  ),
];

export const renderRankingTable = (ranking: readonly ModelRank[]): string[] => [
  '| Rank | Model | Valid % (all cells) | Links OK % | Median s | n |',
  '|---|---|---|---|---|---|',
  ...ranking.map(
    (r, i) =>
      `| ${String(i + 1)} | ${r.model} | ${String(r.validPct)} | ${r.linkValidPct === null ? '-' : String(r.linkValidPct)} | ${seconds(r.medianLatencyMs)} | ${String(r.n)} |`,
  ),
];

const boardOf = (name: BoardName) => {
  const ids = createUuidV7Generator(systemClock);
  switch (name) {
    case 'decomposed':
      return { sample: decomposedBoard(ids), round: 2 };
    case 'mid-run':
      return { sample: midRunBoard(ids), round: 4 };
    case 'late':
      return { sample: lateBoard(ids), round: 5 };
  }
};

const probeReport = (results: readonly OllamaFormatProbeResult[]): ProbeReport => ({
  valid: results.filter((r) => r.valid).length,
  total: results.length,
  results,
});

const runCell = async (
  model: Model,
  input: {
    modelId: string;
    role: AgentRole;
    think: boolean;
    board: BoardName;
    rep: number;
    request: AgentRequest;
    runId: string;
    round: number;
    view: ReturnType<ReturnType<typeof boardOf>['sample']['fx']['view']>;
    maxOutputTokens: number;
  },
): Promise<TrialCell> => {
  const result = await model.generateObject({
    schema: input.request.schema,
    system: input.request.system,
    prompt: input.request.prompt,
    maxOutputTokens: input.maxOutputTokens,
    tags: { role: input.role, runId: input.runId, round: input.round },
  });
  const base = {
    model: input.modelId,
    role: input.role,
    think: input.think,
    board: input.board,
    rep: input.rep,
    handles: input.request.handles.length,
  };
  if (result.ok) {
    const { contributions } = result.value.object;
    // What the controller would do: resolve handles, then validate the links.
    const resolved = resolveHandles(contributions, input.view);
    const problems = resolved.ok
      ? resolved.value.flatMap((c) => linkProblems(c, input.view))
      : resolved.error;
    return {
      ...base,
      outcome: 'ok',
      errorKind: null,
      issues: [],
      contributions: contributions.length,
      linkProblems: problems.length,
      latencyMs: result.value.latencyMs,
      inputTokens: result.value.usage.inputTokens > 0 ? result.value.usage.inputTokens : null,
      outputTokens: result.value.usage.outputTokens,
      warnings: result.value.warnings,
      sample: { object: result.value.object, linkProblems: problems },
    };
  }
  const { outcome, issues } = classify(result.error);
  const usage = 'usage' in result.error ? result.error.usage : null;
  return {
    ...base,
    outcome,
    errorKind: result.error.kind,
    issues,
    contributions: 0,
    linkProblems: 0,
    latencyMs: 0,
    inputTokens: usage !== null && usage.inputTokens > 0 ? usage.inputTokens : null,
    outputTokens: usage?.outputTokens ?? 0,
    warnings: [],
    sample:
      result.error.kind === 'invalid_output'
        ? { raw: result.error.raw.slice(0, SAMPLE_CHARS) }
        : { error: result.error },
  };
};

export const runTrial = async (options: TrialOptions): Promise<TrialReport> => {
  const now = options.now ?? Date.now;
  const maxOutputTokens = options.maxOutputTokens ?? 4_096;
  const models: ModelReport[] = [];

  for (const modelId of options.models) {
    options.log(`== ${modelId}: pre-flight and warm-up ==`);
    const loadStart = now();
    const ready = await preflightOllama({ baseUrl: options.baseUrl, models: [modelId] });
    if (!ready.ok) {
      options.log(`   skipped: ${JSON.stringify(ready.error)}`);
      models.push({
        model: modelId,
        preflight: { ok: false, error: ready.error },
        strictProbe: null,
        researcherProbe: null,
        cells: [],
      });
      continue;
    }
    const report: ModelReport = {
      model: modelId,
      preflight: { ok: true, version: ready.value.version, loadMs: now() - loadStart },
      strictProbe: null,
      researcherProbe: null,
      cells: [],
    };
    models.push(report);

    options.log(`   format probe: strict schema`);
    report.strictProbe = probeReport(
      await probeOllamaFormat({
        baseUrl: options.baseUrl,
        model: modelId,
        schema: FORMAT_PROBE.schema,
        system: FORMAT_PROBE.system,
        prompts: FORMAT_PROBE.prompts,
        numPredict: 512,
        now,
      }),
    );
    options.log(
      `   strict schema honoured ${String(report.strictProbe.valid)}/${String(report.strictProbe.total)}`,
    );

    // The real Researcher schema, raw: each prompt with the handle enum built for it.
    const mid = boardOf('mid-run');
    const midView = mid.sample.fx.view();
    const researcherRequests = [0, 1, 2].flatMap((rep) => {
      const trigger = roleDefinitions.researcher.trigger(
        midView,
        agentContext({ runId: mid.sample.fx.runId, round: mid.round }),
      );
      const ctx = agentContext({
        runId: mid.sample.fx.runId,
        round: mid.round,
        targetIds: targetVariant(trigger.targetIds, rep),
      });
      const built = buildAgentRequest(
        roleDefinitions.researcher,
        midView,
        ctx,
        options.prompts.researcher,
      );
      return built.ok ? [built.value] : [];
    });
    options.log(`   format probe: researcher schema`);
    const researcherResults: OllamaFormatProbeResult[] = [];
    for (const request of researcherRequests) {
      researcherResults.push(
        ...(await probeOllamaFormat({
          baseUrl: options.baseUrl,
          model: modelId,
          schema: request.schema,
          system: request.system,
          prompts: [request.prompt],
          numPredict: maxOutputTokens,
          now,
        })),
      );
    }
    report.researcherProbe = probeReport(researcherResults);
    options.log(
      `   researcher schema honoured ${String(report.researcherProbe.valid)}/${String(report.researcherProbe.total)}`,
    );

    for (const role of options.roles) {
      const thinkModes = role === 'solver' ? [false, true] : [false];
      for (const think of thinkModes) {
        const model = createOllamaModel({ modelId, baseUrl: options.baseUrl, think, now });
        for (const boardName of BOARDS) {
          const { sample, round } = boardOf(boardName);
          const view = sample.fx.view();
          const trigger = roleDefinitions[role].trigger(
            view,
            agentContext({ runId: sample.fx.runId, round }),
          );
          if (!trigger.eligible) continue;
          for (let rep = 0; rep < options.reps; rep += 1) {
            const ctx = agentContext({
              runId: sample.fx.runId,
              round,
              targetIds: targetVariant(trigger.targetIds, rep),
            });
            const built = buildAgentRequest(
              roleDefinitions[role],
              view,
              ctx,
              options.prompts[role],
            );
            if (!built.ok) {
              options.log(
                `   ${role.padEnd(10)} ${boardName.padEnd(10)}: nothing visible, skipped`,
              );
              continue;
            }
            const cell = await runCell(model, {
              modelId,
              role,
              think,
              board: boardName,
              rep,
              request: built.value,
              runId: sample.fx.runId,
              round,
              view,
              maxOutputTokens,
            });
            report.cells.push(cell);
            options.log(
              `   ${role.padEnd(10)} think=${think ? 'on ' : 'off'} ${boardName.padEnd(10)} rep ${String(rep + 1)}: ${cell.outcome.padEnd(9)} ${seconds(cell.latencyMs).padStart(6)} s  out ${String(cell.outputTokens).padStart(5)}  links ${String(cell.linkProblems)}  handles ${String(cell.handles)}${cell.warnings.length > 0 ? `  warnings ${cell.warnings.join(' | ')}` : ''}`,
            );
          }
        }
      }
    }
  }

  const cells = models.flatMap((m) => m.cells);
  return {
    ranAt: new Date(now()).toISOString(),
    baseUrl: options.baseUrl,
    reps: options.reps,
    roles: options.roles,
    models,
    summary: summarise(cells),
    ranking: rankModels(cells),
  };
};
