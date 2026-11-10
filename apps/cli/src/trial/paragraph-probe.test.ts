import type { Roster } from '@team/core';
import type { OllamaFormatProbeResult } from '@team/providers';
import { describe, expect, it } from 'vitest';

import {
  paragraphsCell,
  renderParagraphTable,
  resolveProbeModel,
  summariseParagraphProbe,
  textCell,
  type ParagraphProbeModel,
} from './paragraph-probe';

const result = (text: string, valid = true): OllamaFormatProbeResult => ({
  prompt: 'p',
  ok: true,
  json: true,
  valid,
  doneReason: 'stop',
  text,
  promptEvalCount: 10,
  evalCount: 20,
  latencyMs: 1_500,
  error: null,
});

describe('paragraph probe cells', () => {
  it('reads line breaks and the $$ placeholder out of the text field, not the raw JSON', () => {
    expect(textCell(result(JSON.stringify({ text: 'One.\n\nTwo.' })))).toMatchObject({
      valid: true,
      newline: true,
      blankLine: true,
      dollar: false,
      sample: 'One.\n\nTwo.',
    });
    expect(textCell(result(JSON.stringify({ text: 'One. $$ Two.' })))).toMatchObject({
      valid: true,
      newline: false,
      blankLine: false,
      dollar: true,
    });
    expect(textCell(result('{"text": 1}', false))).toMatchObject({
      valid: false,
      newline: false,
      sample: '{"text": 1}',
    });
  });

  it('counts the paragraphs of an array answer and keeps them joined as the sample', () => {
    expect(paragraphsCell(result(JSON.stringify({ paragraphs: ['A.', 'B.'] })))).toMatchObject({
      valid: true,
      paragraphs: 2,
      sample: 'A.\n\nB.',
    });
    expect(paragraphsCell(result('nope', false))).toMatchObject({ valid: false, paragraphs: 0 });
  });
});

describe('summary and table', () => {
  const model = (overrides: Partial<ParagraphProbeModel>): ParagraphProbeModel => ({
    alias: 'local',
    model: 'm',
    think: false,
    preflight: { ok: true, version: '0.40', loadMs: 1 },
    text: [],
    paragraphs: [],
    ...overrides,
  });

  it('counts valid answers, newlines, blank lines and placeholders per model', () => {
    const summary = summariseParagraphProbe([
      model({
        text: [
          textCell(result(JSON.stringify({ text: 'a\n\nb' }))),
          textCell(result(JSON.stringify({ text: 'a $$ b' }))),
          textCell(result('x', false)),
        ],
        paragraphs: [
          paragraphsCell(result(JSON.stringify({ paragraphs: ['a', 'b'] }))),
          paragraphsCell(result('x', false)),
        ],
      }),
    ]);
    expect(summary).toEqual([
      { model: 'm', n: 3, textValid: 2, newline: 1, blankLine: 1, dollar: 1, paragraphsValid: 1 },
    ]);
    expect(renderParagraphTable(summary)[2]).toBe('| m | 3 | 2 | 1 | 1 | 1 | 1 |');
  });

  it('resolves a roster alias to its model and think flag, and passes a raw id through', () => {
    const roster: Roster = {
      defaultProfile: 'dev',
      models: { local: { provider: 'ollama', model: 'qwen:q8', think: false } },
      profiles: {},
      agents: {
        planner: { prompt: 'p' },
        researcher: { prompt: 'p' },
        solver: { prompt: 'p' },
        critic: { prompt: 'p' },
        synthesizer: { prompt: 'p' },
      },
    };
    expect(resolveProbeModel(roster, 'local')).toEqual({
      alias: 'local',
      model: 'qwen:q8',
      think: false,
    });
    expect(resolveProbeModel(roster, 'other:latest')).toEqual({
      alias: null,
      model: 'other:latest',
      think: false,
    });
  });
});
