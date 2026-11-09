import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildAgentRequest,
  linkProblems,
  plannerOutputSchema,
  resolveHandles,
  roleDefinitions,
  UUID_REFERENCES,
  type AgentRequest,
  type AgentRole,
  type BoardView,
  type Contribution,
} from '@team/core';
import { agentContext, freshBoard, lateBoard } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { createAnthropicModel, type AnthropicStructuredOutputMode } from './anthropic';
import { PRICE_TABLE } from './pricing';
import { traceModel, type ModelCallTrace } from './trace';

// Contract test against the real Anthropic API (pnpm test:llm). Skipped without a key.
// It uses the real per-call role schemas on purpose: their minItems/maxItems, numeric
// bounds and handle enums are exactly what a native structured-output grammar might
// reject, and a rejection would surface as invalid_request on every round of a paid run.

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env: rely on the environment
}
const apiKey = process.env['ANTHROPIC_API_KEY'];
const MODEL_ID = 'claude-haiku-5-5';
const pricing = PRICE_TABLE.models[MODEL_ID];
const prompt = (role: AgentRole): string =>
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

const request = (
  role: AgentRole,
  view: BoardView,
  ctx: Parameters<typeof buildAgentRequest>[2],
): AgentRequest => {
  const built = buildAgentRequest(roleDefinitions[role], view, ctx, prompt(role));
  if (!built.ok) throw new Error('the board names nothing');
  return built.value;
};

/** The controller's commit-time check: handles resolve, and the links they make are valid. */
const linkIssues = (contributions: readonly Contribution[], view: BoardView): string[] => {
  const resolved = resolveHandles(contributions, view);
  return resolved.ok ? resolved.value.flatMap((c) => linkProblems(c, view)) : resolved.error;
};

describe.skipIf(apiKey === undefined || apiKey === '')('Anthropic contract (real API)', () => {
  it('decomposes a fresh board with the planner schema, with usage, cost and a trace', async () => {
    const board = freshBoard();
    const view = board.fx.view();
    const ctx = agentContext({ runId: board.fx.runId, targetIds: [board.problem.id] });
    const req = request('planner', view, ctx);
    const { model, traces } = haiku();
    const result = await model.generateObject({
      schema: req.schema,
      system: req.system,
      prompt: req.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'planner', runId: board.fx.runId, round: 1 },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.object.contributions.length).toBeGreaterThan(0);
    expect(result.value.usage.inputTokens).toBeGreaterThan(0);
    expect(result.value.usage.outputTokens).toBeGreaterThan(0);
    expect(result.value.usage.costUsd).toBeGreaterThan(0);
    expect(linkIssues(result.value.object.contributions, view)).toEqual([]);
    expect(traces[0]).toMatchObject({ outcome: 'ok', billing: 'api', modelId: MODEL_ID });
    expect(traces[0]?.actualInputTokens).toBeGreaterThan(0);
    expect(traces[0]?.estimate.tokens).toBeGreaterThan(0);
  }, 60_000);

  it('synthesises a late board with the synthesizer schema (exactly one entry, version 2)', async () => {
    const board = lateBoard();
    const view = board.fx.view();
    const ctx = agentContext({
      runId: board.fx.runId,
      round: 5,
      targetIds: board.hypotheses.map((h) => h.id),
    });
    const req = request('synthesizer', view, ctx);
    const { model } = haiku();
    const result = await model.generateObject({
      schema: req.schema,
      system: req.system,
      prompt: req.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'synthesizer', runId: board.fx.runId, round: 5 },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const [synthesis] = result.value.object.contributions;
    expect(synthesis?.type).toBe('synthesis');
    if (synthesis?.type !== 'synthesis') return;
    expect(synthesis.payload.version).toBe(2);
    // The model names the earlier synthesis by handle; resolved, it is the entry id.
    const previous = board.synthesis;
    if (previous === undefined) throw new Error('fixture changed');
    expect(synthesis.supersedes).toBe(view.handleOf(previous.id));
    const resolved = resolveHandles(result.value.object.contributions, view);
    expect(resolved.ok && resolved.value[0]?.supersedes).toBe(previous.id);
    expect(linkIssues(result.value.object.contributions, view)).toEqual([]);
  }, 60_000);

  // The JSON-tool path is the fallback for a schema the native grammar rejects. The API
  // accepts it, but a tool-input schema is not enforced server-side: in one run Haiku
  // dropped a required `parents` array that the native mode never drops. So `auto` stays
  // the default and this test only checks the mode is accepted, not that it is as reliable.
  it('accepts the schema sent as a JSON tool (less reliable than native)', async () => {
    const board = freshBoard();
    const view = board.fx.view();
    const ctx = agentContext({ runId: board.fx.runId, targetIds: [board.problem.id] });
    const req = request('planner', view, ctx);
    const { model } = haiku('jsonTool');
    const result = await model.generateObject({
      schema: req.schema,
      system: req.system,
      prompt: req.prompt,
      maxOutputTokens: 4_096,
      tags: { role: 'planner', runId: board.fx.runId, round: 1 },
    });
    expect(result.ok || result.error.kind === 'invalid_output', JSON.stringify(result)).toBe(true);
  }, 60_000);

  it('classifies a bad key as auth, with no retry', async () => {
    if (pricing === undefined) throw new Error('precondition');
    const model = createAnthropicModel({ modelId: MODEL_ID, apiKey: 'sk-ant-bogus', pricing });
    const result = await model.generateObject({
      schema: plannerOutputSchema(UUID_REFERENCES),
      system: 's',
      prompt: 'p',
      maxOutputTokens: 256,
      tags: { role: 'planner', runId: 'r', round: 1 },
    });
    expect(!result.ok && result.error.kind).toBe('auth');
  }, 30_000);
});
