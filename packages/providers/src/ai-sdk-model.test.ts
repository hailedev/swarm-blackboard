import type { ModelPricing, ModelRequest } from '@team/core';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAiSdkModel, describeWarning, usageFromSdk } from './ai-sdk-model';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

// $1 in, $5 out, cache reads $0.10, cache writes $1.25 per MTok.
const pricing: ModelPricing = {
  tiers: [
    {
      upToPromptTokens: null,
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  ],
};

const AnswerSchema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });

const request = (overrides: Partial<ModelRequest<unknown>> = {}): ModelRequest<unknown> => ({
  schema: AnswerSchema,
  system: 'be brief',
  prompt: 'yes or no?',
  maxOutputTokens: 512,
  tags: { role: 'critic', runId: 'run-1', round: 2 },
  ...overrides,
});

const reply = (text: string, overrides: Partial<GenerateResult> = {}): GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage: {
    inputTokens: { total: 120, noCache: 100, cacheRead: 15, cacheWrite: 5 },
    outputTokens: { total: 30, text: 30, reasoning: undefined },
  },
  warnings: [],
  ...overrides,
});

const harness = (doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0]) => {
  const mock = new MockLanguageModelV4({ modelId: 'mock-model', ...doGenerate });
  let t = 1_000;
  const model = createAiSdkModel({
    id: 'haiku',
    billing: 'api',
    pricing,
    languageModel: mock,
    systemMessage: (req) => ({
      role: 'system',
      content: req.system,
      providerOptions: { test: { marker: true } },
    }),
    providerOptions: (_req, maxOutputTokens) => ({ test: { limit: maxOutputTokens ?? -1 } }),
    timeoutMs: 1_234,
    charsPerToken: 3,
    now: () => {
      t += 25;
      return t;
    },
  });
  return { mock, model };
};

describe('createAiSdkModel', () => {
  it('sends the schema, the system message and the provider options, and maps a valid answer', async () => {
    const { mock, model } = harness({
      doGenerate: reply('{"answer":"yes","confidence":0.9}'),
    });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.object).toEqual({ answer: 'yes', confidence: 0.9 });
    expect(result.value.modelId).toBe('haiku');
    expect(result.value.warnings).toEqual([]);
    expect(result.value.latencyMs).toBe(25);
    expect(result.value.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 15,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      costUsd: expect.closeTo((100 * 1 + 30 * 5 + 15 * 0.1 + 5 * 1.25) / 1e6, 12) as number,
    });

    const call = mock.doGenerateCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.maxOutputTokens).toBe(512);
    expect(call.providerOptions).toEqual({ test: { limit: 512 } });
    expect(call.responseFormat?.type).toBe('json');
    if (call.responseFormat?.type === 'json') {
      expect(call.responseFormat.schema).toMatchObject({
        type: 'object',
        properties: { answer: { type: 'string' } },
      });
    }
    expect(call.prompt[0]).toMatchObject({
      role: 'system',
      content: 'be brief',
      providerOptions: { test: { marker: true } },
    });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
  });

  it('coalesces missing usage fields to zero and derives uncached tokens from the total', () => {
    expect(
      usageFromSdk(
        {
          inputTokens: 120,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: 20,
            cacheWriteTokens: undefined,
          },
          outputTokens: undefined,
          totalTokens: undefined,
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        null,
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
    expect(
      usageFromSdk(
        {
          inputTokens: undefined,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: undefined,
          totalTokens: undefined,
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        pricing,
      ),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  it('reports an answer that is not JSON as invalid_output with the raw text and billed tokens', async () => {
    const { model } = harness({ doGenerate: reply('Sure! {"answer": "yes"') });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toMatchObject({
      kind: 'invalid_output',
      issues: ['the answer is not valid JSON'],
      raw: 'Sure! {"answer": "yes"',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
  });

  it('reports a schema mismatch with the Zod issues', async () => {
    const { model } = harness({ doGenerate: reply('{"answer":"yes","confidence":2}') });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error.kind).toBe('invalid_output');
    if (result.ok || result.error.kind !== 'invalid_output') return;
    expect(result.error.issues).toEqual([expect.stringMatching(/^confidence: /) as string]);
    expect(result.error.raw).toBe('{"answer":"yes","confidence":2}');
  });

  it('tells a truncated answer apart from a wrong one', async () => {
    const { model } = harness({
      doGenerate: reply('{"answer":"yes","conf', {
        finishReason: { unified: 'length', raw: 'max_tokens' },
      }),
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toMatchObject({
      kind: 'invalid_output',
      issues: ['output truncated after 30 tokens (finishReason=length); answer more briefly'],
      raw: '{"answer":"yes","conf',
    });
  });

  it('treats an empty reply as invalid_output and keeps its usage', async () => {
    const { model } = harness({
      doGenerate: reply('', { finishReason: { unified: 'error', raw: undefined } }),
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toMatchObject({
      kind: 'invalid_output',
      issues: ['no output (finishReason=error)'],
      raw: '',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
  });

  it('surfaces provider warnings as text', async () => {
    const { model } = harness({
      doGenerate: reply('{"answer":"yes","confidence":0.5}', {
        warnings: [
          { type: 'unsupported', feature: 'setting', details: 'topK' },
          { type: 'compatibility', feature: 'responseFormat' },
          { type: 'other', message: 'slow model' },
        ],
      }),
    });
    const result = await model.generateObject(request());
    expect(result.ok && result.value.warnings).toEqual([
      'unsupported setting: topK',
      'compatibility responseFormat',
      'slow model',
    ]);
    expect(describeWarning({ type: 'other', message: 'm' })).toBe('m');
  });

  it.each([
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [401, 'auth'],
    [402, 'billing'],
    [400, 'invalid_request'],
  ] as const)('classifies an HTTP %i failure as %s', async (statusCode, kind) => {
    const { model } = harness({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: `HTTP ${String(statusCode)}`,
            url: 'https://api.example',
            requestBodyValues: {},
            statusCode,
            isRetryable: statusCode === 429 || statusCode >= 500,
          }),
        ),
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error.kind).toBe(kind);
  });

  it('classifies a timeout as a network failure', async () => {
    const { model } = harness({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        ),
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toEqual({
      kind: 'network',
      message: 'The operation was aborted',
      attempts: 1,
    });
  });

  it('refuses a request before sending it when the refuse hook says so', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: reply('{}') });
    const model = createAiSdkModel({
      id: 'local',
      billing: 'local',
      pricing: null,
      languageModel: mock,
      refuse: (req) =>
        req.prompt.length > 5 ? { kind: 'invalid_request', message: 'too long' } : undefined,
      timeoutMs: 10,
      charsPerToken: 3,
    });
    const refused = await model.generateObject(request({ prompt: 'far too long' }));
    expect(!refused.ok && refused.error).toEqual({ kind: 'invalid_request', message: 'too long' });
    expect(mock.doGenerateCalls.length).toBe(0);
    expect(model.billing).toBe('local');
    expect(model.pricing).toBeNull();
  });
});
