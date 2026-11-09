import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  linkProblems,
  renderAgentPrompt,
  ResearcherOutputSchema,
  SolverOutputSchema,
  type AgentRole,
} from '@team/core';
import { agentContext, midRunBoard } from '@team/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createOllamaModel, OLLAMA_THINK_TOKENS } from './ollama';
import { preflightOllama, probeOllamaFormat } from './ollama-preflight';
import { withRetry } from './retry';

// Contract test against a real Ollama server (pnpm test:llm). Skipped when the server
// is unreachable. OLLAMA_TEST_MODEL picks the tag; the default is the roster's worker.
// Reliability on the real role schemas is the local-model trial's job (ADR-0008); this
// file checks that the adapter and the server agree on the contract.

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env: rely on the environment
}
const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const modelId = process.env['OLLAMA_TEST_MODEL'] ?? 'qwen3.6:35b-mlx';

const reachable = await (async () => {
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
})();

const prompt = (role: AgentRole): string =>
  readFileSync(fileURLToPath(new URL(`../../../prompts/${role}.md`, import.meta.url)), 'utf8');

const tags = (role: AgentRole, runId: string) => ({ role, runId, round: 4 });

// Tight enough that an unconstrained model would stray: an enum, a bounded integer and a
// bounded array. No ids, so hallucinated UUIDs cannot muddy the result.
const StrictSchema = z.object({
  verdict: z.enum(['yes', 'no', 'unclear']),
  score: z.int().min(1).max(5),
  reasons: z.array(z.string().min(1)).min(1).max(3),
});
const STRICT_SYSTEM =
  'Judge the statement. Reply with JSON only: verdict (yes, no or unclear), score (1 to 5) and one to three short reasons.';
const STRICT_PROMPTS = [
  'Statement: a pnpm workspace shares one lockfile across its packages.',
  'Statement: TypeScript compiles directly to machine code.',
  'Statement: remote build caching always keeps CI under ten minutes.',
];

describe.skipIf(!reachable)(`Ollama contract (${baseUrl}, ${modelId})`, () => {
  beforeAll(async () => {
    const ready = await preflightOllama({ baseUrl, models: [modelId] });
    if (!ready.ok) throw new Error(JSON.stringify(ready.error));
  }, 300_000);

  it('honours a strict JSON-schema format on three different prompts, through the adapter and raw', async () => {
    const model = createOllamaModel({ modelId, baseUrl });
    const viaAdapter: string[] = [];
    for (const p of STRICT_PROMPTS) {
      const result = await model.generateObject({
        schema: StrictSchema,
        system: STRICT_SYSTEM,
        prompt: p,
        maxOutputTokens: 512,
        tags: tags('critic', 'run-strict'),
      });
      viaAdapter.push(result.ok ? 'ok' : JSON.stringify(result.error));
      if (result.ok) expect(result.value.warnings).toEqual([]);
    }
    expect(viaAdapter).toEqual(['ok', 'ok', 'ok']);

    const raw = await probeOllamaFormat({
      baseUrl,
      model: modelId,
      schema: StrictSchema,
      system: STRICT_SYSTEM,
      prompts: STRICT_PROMPTS,
      numPredict: 512,
    });
    expect(raw.map((r) => [r.ok, r.json, r.valid])).toEqual([
      [true, true, true],
      [true, true, true],
      [true, true, true],
    ]);
  }, 600_000);

  it('runs the researcher end to end: valid first attempts dominate and failures are schema-level', async () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const model = createOllamaModel({ modelId, baseUrl });
    const targetSets = [
      board.subproblems.map((s) => s.id),
      board.hypotheses.map((h) => h.id),
      [board.subproblems[1]?.id ?? ''],
    ];
    const outcomes: string[] = [];
    for (const targetIds of targetSets) {
      const ctx = agentContext({ runId: board.fx.runId, round: 4, targetIds });
      const rendered = renderAgentPrompt('researcher', view, ctx, prompt('researcher'));
      const result = await model.generateObject({
        schema: ResearcherOutputSchema,
        system: rendered.system,
        prompt: rendered.prompt,
        maxOutputTokens: 2_048,
        tags: tags('researcher', board.fx.runId),
      });
      outcomes.push(result.ok ? 'ok' : result.error.kind);
      if (result.ok) {
        expect(result.value.usage.inputTokens).toBeGreaterThan(0);
        expect(result.value.usage.costUsd).toBe(0);
        // Link validity (ids that exist on the board) is what the trial measures; here it
        // only has to be something the commit path can report.
        const problems = result.value.object.contributions.flatMap((c) => linkProblems(c, view));
        expect(Array.isArray(problems)).toBe(true);
      }
    }
    expect(outcomes.filter((o) => o === 'ok').length).toBeGreaterThanOrEqual(2);
    expect(outcomes.every((o) => o === 'ok' || o === 'invalid_output')).toBe(true);
  }, 600_000);

  it('returns schema-valid JSON with thinking on, given room to think', async () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const ctx = agentContext({
      runId: board.fx.runId,
      round: 4,
      targetIds: board.subproblems.map((s) => s.id),
    });
    const rendered = renderAgentPrompt('solver', view, ctx, prompt('solver'));
    const model = createOllamaModel({ modelId, baseUrl, think: true });
    const result = await model.generateObject({
      schema: SolverOutputSchema,
      system: rendered.system,
      prompt: rendered.prompt,
      maxOutputTokens: 4_096,
      tags: tags('solver', board.fx.runId),
    });
    // Thinking must not eat the allowance any more: the answer is either valid or a
    // schema-level rejection of real JSON (local models mangle ids; the trial measures
    // that), never an empty reply or a truncation.
    const acceptable =
      result.ok ||
      (result.error.kind === 'invalid_output' &&
        result.error.raw.trim().startsWith('{') &&
        !(result.error.issues[0] ?? '').startsWith('output truncated'));
    expect(acceptable, JSON.stringify(result)).toBe(true);
    const usage = result.ok
      ? result.value.usage
      : result.error.kind === 'invalid_output'
        ? result.error.usage
        : null;
    expect(usage?.outputTokens ?? 0).toBeLessThanOrEqual(4_096 + OLLAMA_THINK_TOKENS);
  }, 600_000);

  it('respects the output allowance through num_predict', async () => {
    const model = createOllamaModel({ modelId, baseUrl });
    const result = await model.generateObject({
      schema: ResearcherOutputSchema,
      system: 'Write as much evidence as you can.',
      prompt: 'List twenty facts about the history of version control systems.',
      maxOutputTokens: 48,
      tags: tags('researcher', 'run-allowance'),
    });
    // 48 tokens cannot hold a valid contribution list, so this is a truncation; the
    // point is that Ollama stopped where it was told to.
    const usage = result.ok
      ? result.value.usage
      : 'usage' in result.error
        ? result.error.usage
        : null;
    expect(usage).not.toBeNull();
    expect(usage?.outputTokens).toBeLessThanOrEqual(64);
  }, 300_000);

  it('classifies an unreachable server as network after three attempts', async () => {
    // A port nothing listens on (not one of the ports fetch refuses outright).
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const model = withRetry(
      createOllamaModel({
        modelId,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        timeoutMs: 3_000,
      }),
      { attempts: 3, sleep: () => Promise.resolve() },
    );
    const result = await model.generateObject({
      schema: ResearcherOutputSchema,
      system: 's',
      prompt: 'p',
      maxOutputTokens: 64,
      tags: tags('researcher', 'run-down'),
    });
    expect(!result.ok && result.error).toMatchObject({ kind: 'network', attempts: 3 });
  }, 30_000);

  it('reports a tag that is not pulled', async () => {
    const result = await preflightOllama({
      baseUrl,
      models: ['definitely-not-a-model:latest'],
      warm: false,
    });
    expect(!result.ok && result.error).toEqual({
      kind: 'missing_model',
      model: 'definitely-not-a-model:latest',
    });
  }, 30_000);
});
