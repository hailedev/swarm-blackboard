import type { Roster } from '@team/core';
import {
  PARAGRAPH_PROBE,
  preflightOllama,
  probeOllamaFormat,
  type OllamaFormatProbeResult,
  type OllamaPreflightError,
} from '@team/providers';

// Can a local model put a line break inside a JSON string under Ollama's schema `format`?
// The recorded runs held no newline in any local entry, and the MLX build once wrote `$$`
// where paragraph breaks belonged (ADR-0008, third amendment). Two probes per model: the
// same two-paragraph request as one string (`text`) and as an array of paragraphs, both
// defined next to the format probe in `@team/providers`.

const TEXT_PROBE = PARAGRAPH_PROBE.text;
const PARAGRAPHS_PROBE = PARAGRAPH_PROBE.paragraphs;
const PARAGRAPH_PROMPTS = PARAGRAPH_PROBE.prompts;

export interface TextProbeCell {
  prompt: string;
  valid: boolean;
  /** The `text` field contains at least one newline character. */
  newline: boolean;
  /** The `text` field contains a blank line (two consecutive newlines). */
  blankLine: boolean;
  /** The `text` field contains `$$`, the placeholder the MLX build once wrote. */
  dollar: boolean;
  latencyMs: number;
  /** The `text` field itself, clipped, or the raw reply when it was not valid. */
  sample: string;
}

export interface ParagraphsProbeCell {
  prompt: string;
  valid: boolean;
  paragraphs: number;
  latencyMs: number;
  sample: string;
}

export interface ParagraphProbeModel {
  alias: string | null;
  model: string;
  think: boolean;
  preflight:
    { ok: true; version: string; loadMs: number } | { ok: false; error: OllamaPreflightError };
  text: TextProbeCell[];
  paragraphs: ParagraphsProbeCell[];
}

export interface ParagraphProbeSummary {
  model: string;
  n: number;
  textValid: number;
  newline: number;
  blankLine: number;
  dollar: number;
  paragraphsValid: number;
}

export interface ParagraphProbeReport {
  ranAt: string;
  baseUrl: string;
  models: ParagraphProbeModel[];
  summary: ParagraphProbeSummary[];
}

const SAMPLE_CHARS = 600;

interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

const parseReply = <T>(result: OllamaFormatProbeResult, schema: Parser<T>): T | null => {
  if (!result.valid) return null;
  const parsed = schema.safeParse(JSON.parse(result.text));
  return parsed.success ? parsed.data : null;
};

export const textCell = (result: OllamaFormatProbeResult): TextProbeCell => {
  const text = parseReply(result, TEXT_PROBE.schema)?.text ?? null;
  return {
    prompt: result.prompt,
    valid: text !== null,
    newline: text?.includes('\n') ?? false,
    blankLine: text?.includes('\n\n') ?? false,
    dollar: text?.includes('$$') ?? false,
    latencyMs: result.latencyMs,
    sample: (text ?? result.text).slice(0, SAMPLE_CHARS),
  };
};

export const paragraphsCell = (result: OllamaFormatProbeResult): ParagraphsProbeCell => {
  const paragraphs = parseReply(result, PARAGRAPHS_PROBE.schema)?.paragraphs ?? null;
  return {
    prompt: result.prompt,
    valid: paragraphs !== null,
    paragraphs: paragraphs?.length ?? 0,
    latencyMs: result.latencyMs,
    sample: (paragraphs?.join('\n\n') ?? result.text).slice(0, SAMPLE_CHARS),
  };
};

export const summariseParagraphProbe = (
  models: readonly ParagraphProbeModel[],
): ParagraphProbeSummary[] =>
  models.map((m) => ({
    model: m.model,
    n: m.text.length,
    textValid: m.text.filter((c) => c.valid).length,
    newline: m.text.filter((c) => c.newline).length,
    blankLine: m.text.filter((c) => c.blankLine).length,
    dollar: m.text.filter((c) => c.dollar).length,
    paragraphsValid: m.paragraphs.filter((c) => c.valid).length,
  }));

export const renderParagraphTable = (summary: readonly ParagraphProbeSummary[]): string[] => [
  '| Model | n | `text` valid | with `\\n` | with blank line | with `$$` | `paragraphs` valid |',
  '|---|---|---|---|---|---|---|',
  ...summary.map(
    (s) =>
      `| ${s.model} | ${String(s.n)} | ${String(s.textValid)} | ${String(s.newline)} | ${String(s.blankLine)} | ${String(s.dollar)} | ${String(s.paragraphsValid)} |`,
  ),
];

/** A roster alias resolves to its model and think flag; anything else is a raw model id. */
export const resolveProbeModel = (
  roster: Roster,
  name: string,
): { alias: string | null; model: string; think: boolean } => {
  const alias = roster.models[name];
  return alias === undefined
    ? { alias: null, model: name, think: false }
    : { alias: name, model: alias.model, think: alias.think ?? false };
};

export interface ParagraphProbeOptions {
  baseUrl: string;
  roster: Roster;
  /** Roster aliases or raw model ids. */
  models: readonly string[];
  log: (line: string) => void;
  now?: () => number;
  numPredict?: number;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1).padStart(5);
const yesNo = (flag: boolean): string => (flag ? 'yes' : 'no ');

export const runParagraphProbe = async (
  options: ParagraphProbeOptions,
): Promise<ParagraphProbeReport> => {
  const now = options.now ?? Date.now;
  const numPredict = options.numPredict ?? 1_024;
  const models: ParagraphProbeModel[] = [];
  for (const name of options.models) {
    const resolved = resolveProbeModel(options.roster, name);
    options.log(`== ${resolved.model}${resolved.alias === null ? '' : ` (${resolved.alias})`} ==`);
    const loadStart = now();
    const ready = await preflightOllama({ baseUrl: options.baseUrl, models: [resolved.model] });
    if (!ready.ok) {
      options.log(`   skipped: ${JSON.stringify(ready.error)}`);
      models.push({
        ...resolved,
        preflight: { ok: false, error: ready.error },
        text: [],
        paragraphs: [],
      });
      continue;
    }
    const shared = {
      baseUrl: options.baseUrl,
      model: resolved.model,
      think: resolved.think,
      numPredict,
      now,
    };
    options.log('   probe: two paragraphs in one string');
    const text = (
      await probeOllamaFormat({
        ...shared,
        schema: TEXT_PROBE.schema,
        system: TEXT_PROBE.system,
        prompts: PARAGRAPH_PROMPTS,
      })
    ).map(textCell);
    for (const cell of text) {
      options.log(
        `   ${cell.valid ? 'valid  ' : 'invalid'} newline=${yesNo(cell.newline)} blank=${yesNo(cell.blankLine)} $$=${yesNo(cell.dollar)} ${seconds(cell.latencyMs)} s`,
      );
    }
    options.log('   probe: two paragraphs as an array');
    const paragraphs = (
      await probeOllamaFormat({
        ...shared,
        schema: PARAGRAPHS_PROBE.schema,
        system: PARAGRAPHS_PROBE.system,
        prompts: PARAGRAPH_PROMPTS,
      })
    ).map(paragraphsCell);
    for (const cell of paragraphs) {
      options.log(
        `   ${cell.valid ? 'valid  ' : 'invalid'} paragraphs=${String(cell.paragraphs)} ${seconds(cell.latencyMs)} s`,
      );
    }
    models.push({
      ...resolved,
      preflight: { ok: true, version: ready.value.version, loadMs: now() - loadStart },
      text,
      paragraphs,
    });
  }
  return {
    ranAt: new Date(now()).toISOString(),
    baseUrl: options.baseUrl,
    models,
    summary: summariseParagraphProbe(models),
  };
};
