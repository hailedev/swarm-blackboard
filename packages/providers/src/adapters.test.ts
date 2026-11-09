import { createFakeModel, estimateInputTokens, type ModelRequest } from '@team/core';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ANTHROPIC_CHARS_PER_TOKEN, createAnthropicModel } from './anthropic';
import { composeModel, createModelFactory, describeFactoryError } from './factory';
import {
  createOllamaModel,
  OLLAMA_CHARS_PER_TOKEN,
  OLLAMA_NUM_CTX,
  OLLAMA_THINK_TOKENS,
  ollamaApiUrl,
} from './ollama';
import { PRICE_TABLE } from './pricing';
import type { ModelCallTrace } from './trace';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const ok: GenerateResult = {
  content: [{ type: 'text', text: '{"answer":"yes"}' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  },
  warnings: [],
};

const request = (overrides: Partial<ModelRequest<unknown>> = {}): ModelRequest<unknown> => ({
  schema: z.object({ answer: z.string() }),
  system: 'sys',
  prompt: 'ask',
  maxOutputTokens: 512,
  tags: { role: 'solver', runId: 'run-1', round: 1 },
  ...overrides,
});

describe('createOllamaModel', () => {
  it('asks for the context window and the output allowance in Ollama terms, with room to think', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createOllamaModel({
      modelId: 'qwen-test',
      baseUrl: 'http://mini:11434/',
      think: true,
      languageModel: mock,
    });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(true);
    expect(model.billing).toBe('local');
    expect(model.pricing).toBeNull();
    expect(model.id).toBe('qwen-test');
    expect(result.ok && result.value.usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    const call = mock.doGenerateCalls[0];
    expect(call?.providerOptions).toEqual({
      ollama: {
        think: true,
        options: { num_ctx: OLLAMA_NUM_CTX, num_predict: 512 + OLLAMA_THINK_TOKENS },
      },
    });
    expect(call?.responseFormat?.type).toBe('json');
    expect(call?.prompt[0]).toMatchObject({ role: 'system', content: 'sys' });
  });

  it('gives a thinking model only the room it was told to', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createOllamaModel({
      modelId: 'm',
      baseUrl: 'http://mini:11434',
      think: true,
      thinkTokens: 1_000,
      languageModel: mock,
    });
    await model.generateObject(request());
    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({
      ollama: { think: true, options: { num_ctx: OLLAMA_NUM_CTX, num_predict: 1_512 } },
    });
  });

  it('defaults think off, honours a custom context window and omits num_predict without an allowance', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createOllamaModel({
      modelId: 'm',
      baseUrl: 'http://mini:11434',
      numCtx: 8192,
      languageModel: mock,
    });
    await model.generateObject(request({ maxOutputTokens: undefined }));
    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({
      ollama: { think: false, options: { num_ctx: 8192 } },
    });
  });

  it('refuses a prompt that cannot fit the context window instead of letting Ollama truncate it', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createOllamaModel({
      modelId: 'm',
      baseUrl: 'http://mini:11434',
      numCtx: 4096,
      languageModel: mock,
    });
    // 12 000 prompt characters at three per token plus a 512 allowance is over 4096.
    const long = request({ prompt: 'x'.repeat(12_000) });
    const estimated = estimateInputTokens(long, OLLAMA_CHARS_PER_TOKEN);
    expect(estimated).toBeGreaterThan(4_000);
    const result = await model.generateObject(long);
    expect(!result.ok && result.error).toEqual({
      kind: 'invalid_request',
      message: `prompt (~${String(estimated)} tokens) plus output allowance (512) exceeds the 4096-token context of m`,
    });
    expect(mock.doGenerateCalls.length).toBe(0);
    // A model told its tokenizer is denser estimates more and refuses sooner.
    const dense = createOllamaModel({
      modelId: 'm',
      baseUrl: 'http://mini:11434',
      numCtx: 8192,
      charsPerToken: 1.5,
      languageModel: mock,
    });
    expect(dense.charsPerToken).toBe(1.5);
    expect((await dense.generateObject(long)).ok).toBe(false);
    expect(model.charsPerToken).toBe(OLLAMA_CHARS_PER_TOKEN);
  });

  it('counts the thinking room against the context window and says so when it is what does not fit', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const options = { modelId: 'm', baseUrl: 'http://mini:11434', numCtx: 8_192 };
    // 9 000 prompt characters at three per token plus a 512 allowance is well inside
    // 8 192 tokens; the default 8 192 of thinking room on top is not.
    const medium = request({ prompt: 'x'.repeat(9_000) });
    const estimated = estimateInputTokens(medium, OLLAMA_CHARS_PER_TOKEN);
    expect(estimated + 512).toBeLessThan(8_192);
    expect(estimated + 512 + OLLAMA_THINK_TOKENS).toBeGreaterThan(8_192);
    expect(estimated + 512 + 1_000).toBeLessThan(8_192);

    const quiet = createOllamaModel({ ...options, languageModel: mock });
    expect((await quiet.generateObject(medium)).ok).toBe(true);
    expect(mock.doGenerateCalls.length).toBe(1);

    const thinking = createOllamaModel({ ...options, think: true, languageModel: mock });
    const refused = await thinking.generateObject(medium);
    expect(!refused.ok && refused.error).toEqual({
      kind: 'invalid_request',
      message: `prompt (~${String(estimated)} tokens) plus output allowance (512) and thinking allowance (${String(OLLAMA_THINK_TOKENS)}) exceeds the 8192-token context of m`,
    });
    // Refused before dispatch: the only call the provider saw is the non-thinking one.
    expect(mock.doGenerateCalls.length).toBe(1);

    // With thinking room that does fit, the same request goes out.
    const frugal = createOllamaModel({
      ...options,
      think: true,
      thinkTokens: 1_000,
      languageModel: mock,
    });
    expect((await frugal.generateObject(medium)).ok).toBe(true);
    expect(mock.doGenerateCalls.length).toBe(2);
  });

  it('builds the API URL from the server root', () => {
    expect(ollamaApiUrl('http://mini:11434')).toBe('http://mini:11434/api');
    expect(ollamaApiUrl('http://mini:11434///')).toBe('http://mini:11434/api');
  });
});

describe('createAnthropicModel', () => {
  const haiku = PRICE_TABLE.models['claude-haiku-5-5'];
  if (haiku === undefined) throw new Error('price table lost Haiku');

  it('marks the role prompt for caching and asks for automatic structured output', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createAnthropicModel({
      modelId: 'claude-haiku-5-5',
      apiKey: 'sk-test',
      pricing: haiku,
      languageModel: mock,
    });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(true);
    expect(model.billing).toBe('api');
    expect(model.pricing).toBe(haiku);
    expect(result.ok && result.value.usage.costUsd).toBeCloseTo((50 * 0.1 + 5 * 0.5) / 1e6, 12);
    expect(model.charsPerToken).toBe(ANTHROPIC_CHARS_PER_TOKEN);
    const call = mock.doGenerateCalls[0];
    expect(call?.prompt[0]).toMatchObject({
      role: 'system',
      content: 'sys',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(call?.providerOptions).toEqual({ anthropic: { structuredOutputMode: 'auto' } });
  });

  it('passes an explicit structured-output mode through', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: ok });
    const model = createAnthropicModel({
      modelId: 'claude-haiku-5-5',
      apiKey: 'sk-test',
      pricing: haiku,
      structuredOutputMode: 'jsonTool',
      languageModel: mock,
    });
    await model.generateObject(request());
    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({
      anthropic: { structuredOutputMode: 'jsonTool' },
    });
  });
});

describe('createModelFactory', () => {
  const base = { ollamaBaseUrl: 'http://mini:11434', priceTable: PRICE_TABLE };
  const haikuAlias = { alias: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' } as const;
  const localAlias = {
    alias: 'local',
    provider: 'ollama',
    model: 'qwen3.6:35b-mlx',
    think: true,
  } as const;

  it('refuses a paid alias without an API key, and names the fix', () => {
    const factory = createModelFactory(base);
    const result = factory.modelFor(haikuAlias);
    expect(!result.ok && result.error).toEqual({
      kind: 'missing_api_key',
      provider: 'anthropic',
      alias: 'haiku',
    });
    if (!result.ok) expect(describeFactoryError(result.error)).toContain('ANTHROPIC_API_KEY');
    expect(createModelFactory({ ...base, anthropicApiKey: '' }).modelFor(haikuAlias).ok).toBe(
      false,
    );
  });

  it('refuses a paid model the price table does not know', () => {
    const factory = createModelFactory({ ...base, anthropicApiKey: 'sk-test' });
    const result = factory.modelFor({ ...haikuAlias, alias: 'opus-next', model: 'claude-opus-9' });
    expect(!result.ok && result.error).toEqual({
      kind: 'no_price',
      alias: 'opus-next',
      modelId: 'claude-opus-9',
    });
    if (!result.ok) expect(describeFactoryError(result.error)).toContain('pricing.ts');
  });

  it('builds priced API models and free local ones, one instance per alias', () => {
    const factory = createModelFactory({ ...base, anthropicApiKey: 'sk-test' });
    const haiku = factory.modelFor(haikuAlias);
    const local = factory.modelFor(localAlias);
    expect(haiku.ok && haiku.value.billing).toBe('api');
    expect(haiku.ok && haiku.value.pricing).toBe(PRICE_TABLE.models['claude-haiku-5-5']);
    expect(haiku.ok && haiku.value.id).toBe('claude-haiku-5-5');
    expect(local.ok && local.value.billing).toBe('local');
    expect(local.ok && local.value.pricing).toBeNull();
    expect(local.ok && local.value.id).toBe('qwen3.6:35b-mlx');
    const again = factory.modelFor(haikuAlias);
    expect(again.ok && haiku.ok && again.value === haiku.value).toBe(true);
    expect(haiku.ok && haiku.value.charsPerToken).toBe(ANTHROPIC_CHARS_PER_TOKEN);
    expect(local.ok && local.value.charsPerToken).toBe(OLLAMA_CHARS_PER_TOKEN);
  });

  it('takes chars per token from the alias, else the host’s calibration, else the provider default', () => {
    const asked: [string, number][] = [];
    const factory = createModelFactory({
      ...base,
      anthropicApiKey: 'sk-test',
      charsPerToken: (resolved, providerDefault) => {
        asked.push([resolved.model, providerDefault]);
        return resolved.provider === 'anthropic' ? 1.7 : undefined;
      },
    });
    const haiku = factory.modelFor(haikuAlias);
    const local = factory.modelFor(localAlias);
    const pinned = factory.modelFor({ ...localAlias, alias: 'local-pinned', charsPerToken: 2.5 });
    expect(haiku.ok && haiku.value.charsPerToken).toBe(1.7);
    expect(local.ok && local.value.charsPerToken).toBe(OLLAMA_CHARS_PER_TOKEN);
    expect(pinned.ok && pinned.value.charsPerToken).toBe(2.5);
    expect(asked).toEqual([
      ['claude-haiku-5-5', ANTHROPIC_CHARS_PER_TOKEN],
      ['qwen3.6:35b-mlx', OLLAMA_CHARS_PER_TOKEN],
    ]);
  });

  it('traces every attempt and retries transient failures around the trace', async () => {
    const traces: ModelCallTrace[] = [];
    const fake = createFakeModel({
      id: 'flaky',
      billing: 'api',
      script: [
        { error: { kind: 'rate_limit', message: '429', attempts: 1 } },
        { error: { kind: 'overloaded', message: '529', attempts: 1 } },
        { object: { answer: 'yes' }, usage: { inputTokens: 10, outputTokens: 2 } },
      ],
    });
    const model = composeModel(fake, {
      sink: (trace) => traces.push(trace),
      retry: { attempts: 3, sleep: () => Promise.resolve() },
      now: () => 0,
    });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(true);
    expect(traces.map((t) => t.outcome)).toEqual(['rate_limit', 'overloaded', 'ok']);
    expect(traces.map((t) => t.usage === null)).toEqual([true, true, false]);
  });
});
