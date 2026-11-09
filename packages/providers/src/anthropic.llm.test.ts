import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  linkProblems,
  PlannerOutputSchema,
  renderAgentPrompt,
  SynthesizerOutputSchema,
} from '@team/core';
import { agentContext, freshBoard, lateBoard } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { createAnthropicModel, type AnthropicStructuredOutputMode } from './anthropic';
import { PRICE_TABLE } from './pricing';
import { traceModel, type ModelCallTrace } from './trace';

// Contract test against the real Anthropic API (pnpm test:llm). Skipped without a key.
// It uses the real role schemas on purpose: their minItems/maxItems, numeric bounds and
// uuid patterns are exactly what a native structured-output grammar might reject, and a
// rejection would surface as invalid_request on every round of a paid run.

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env: rely on the environment
}
const apiKey = process.env['ANTHROPIC_API_KEY'];
const MODEL_ID = 'claude-haiku-5-5';
const pricing = PRICE_TABLE.models[MODEL_ID];
const prompt = (role: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../prompts/${role}.md`, import.meta.url)), 'utf8');

const haiku = (mode?: AnthropicStructuredOutputMode) => {
  if (apiKey === undefined || pricing === undefined) throw new Error('precondition');
  const traces: ModelCallTrace[] = [];
  const model = traceModel(
    createAnthropicModel({ modelId: MODEL_ID, apiKey, pricing, structuredOutputMode: mode }),
    (trace) => traces.push(trace),
  );
  return { model, traces };
};

describe.skipIf(apiKey === undefined || apiKey === '')('Anthropic contract (real API)', () => {
  it('decomposes a fresh board with the planner schema, with usage, cost and a trace', async () => {
    const board = freshBoard();
    const view = board.fx.view();
    const ctx = agentContext({ runId: board.fx.runId, targetIds: [board.problem.id] });
    const rendered = renderAgentPrompt('planner', view, ctx, prompt('planner'));
    const { model, traces } = haiku();
    const result = await model.generateObject({
      schema: PlannerOutputSchema,
      system: rendered.system,
      prompt: rendered.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'planner', runId: board.fx.runId, round: 1 },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.object.contributions.length).toBeGreaterThan(0);
    expect(result.value.usage.inputTokens).toBeGreaterThan(0);
    expect(result.value.usage.outputTokens).toBeGreaterThan(0);
    expect(result.value.usage.costUsd).toBeGreaterThan(0);
    const links = result.value.object.contributions.flatMap((c) => linkProblems(c, view));
    expect(links).toEqual([]);
    expect(traces[0]).toMatchObject({ outcome: 'ok', billing: 'api', modelId: MODEL_ID });
    expect(traces[0]?.actualInputTokens).toBeGreaterThan(0);
    expect(traces[0]?.estimatedInputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('synthesises a late board with the synthesizer schema (exactly one entry, version 2)', async () => {
    const board = lateBoard();
    const view = board.fx.view();
    const ctx = agentContext({
      runId: board.fx.runId,
      round: 5,
      targetIds: board.hypotheses.map((h) => h.id),
    });
    const rendered = renderAgentPrompt('synthesizer', view, ctx, prompt('synthesizer'));
    const { model } = haiku();
    const result = await model.generateObject({
      schema: SynthesizerOutputSchema,
      system: rendered.system,
      prompt: rendered.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'synthesizer', runId: board.fx.runId, round: 5 },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const [synthesis] = result.value.object.contributions;
    expect(synthesis?.payload.version).toBe(2);
    expect(synthesis?.supersedes).toBe(board.synthesis?.id);
    expect(result.value.object.contributions.flatMap((c) => linkProblems(c, view))).toEqual([]);
  }, 60_000);

  // The JSON-tool path is the fallback for a schema the native grammar rejects. The API
  // accepts it, but a tool-input schema is not enforced server-side: in one run Haiku
  // dropped a required `parents` array that the native mode never drops. So `auto` stays
  // the default and this test only checks the mode is accepted, not that it is as reliable.
  it('accepts the schema sent as a JSON tool (less reliable than native)', async () => {
    const board = freshBoard();
    const view = board.fx.view();
    const ctx = agentContext({ runId: board.fx.runId, targetIds: [board.problem.id] });
    const rendered = renderAgentPrompt('planner', view, ctx, prompt('planner'));
    const { model } = haiku('jsonTool');
    const result = await model.generateObject({
      schema: PlannerOutputSchema,
      system: rendered.system,
      prompt: rendered.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'planner', runId: board.fx.runId, round: 1 },
    });
    expect(result.ok || result.error.kind === 'invalid_output', JSON.stringify(result)).toBe(true);
  }, 60_000);

  it('classifies a bad key as auth, with no retry', async () => {
    if (pricing === undefined) throw new Error('precondition');
    const model = createAnthropicModel({ modelId: MODEL_ID, apiKey: 'sk-ant-bogus', pricing });
    const result = await model.generateObject({
      schema: PlannerOutputSchema,
      system: 's',
      prompt: 'p',
      maxOutputTokens: 256,
      tags: { role: 'planner', runId: 'r', round: 1 },
    });
    expect(!result.ok && result.error.kind).toBe('auth');
  }, 30_000);
});
