import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  describeOllamaPreflightError,
  preflightOllama,
  probeOllamaFormat,
  type Fetch,
} from './ollama-preflight';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

// A fetch stand-in keyed by the path after /api; records every call.
const fakeFetch = (
  routes: Record<string, (body: unknown) => Response | Promise<Response>>,
): { fetch: Fetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fetch: Fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(url.indexOf('/api') + 4);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    seen.push({ url, method: init?.method ?? 'GET', body });
    const route = routes[path];
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(route(body));
  };
  return { fetch, seen };
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('preflightOllama', () => {
  it('reports the version, checks each distinct tag and warms every model', async () => {
    const { fetch, seen } = fakeFetch({
      '/version': () => json({ version: '0.40.15' }),
      '/show': () => json({ details: {} }),
      '/generate': () => json({ done: true }),
    });
    const result = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: ['a', 'b', 'a'],
      fetch,
      keepAlive: '5m',
    });
    expect(result).toEqual({ ok: true, value: { version: '0.40.15', models: ['a', 'b'] } });
    expect(seen.map((s) => [s.method, s.url.slice(s.url.indexOf('/api'))])).toEqual([
      ['GET', '/api/version'],
      ['POST', '/api/show'],
      ['POST', '/api/show'],
      ['POST', '/api/generate'],
      ['POST', '/api/generate'],
    ]);
    expect(seen[3]?.body).toEqual({ model: 'a', keep_alive: '5m' });
  });

  it('skips the warm-up when asked', async () => {
    const { fetch, seen } = fakeFetch({
      '/version': () => json({ nope: true }),
      '/show': () => json({}),
    });
    const result = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: ['a'],
      fetch,
      warm: false,
    });
    expect(result.ok && result.value.version).toBe('unknown');
    expect(seen.length).toBe(2);
  });

  it('tells an unreachable server, a missing tag and a failed load apart', async () => {
    const down = fakeFetch({});
    down.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const unreachable = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: ['a'],
      fetch: down.fetch,
    });
    expect(!unreachable.ok && unreachable.error).toEqual({
      kind: 'unreachable',
      baseUrl: 'http://mini:11434',
      message: 'ECONNREFUSED',
    });

    const badStatus = fakeFetch({ '/version': () => new Response('', { status: 502 }) });
    const bad = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: [],
      fetch: badStatus.fetch,
    });
    expect(!bad.ok && bad.error).toMatchObject({ kind: 'unreachable', message: 'HTTP 502' });

    const notPulled = fakeFetch({
      '/version': () => json({ version: '1' }),
      '/show': (body) =>
        (body as { model: string }).model === 'b' ? json({ error: 'not found' }, 404) : json({}),
      '/generate': () => json({}),
    });
    const missing = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: ['a', 'b'],
      fetch: notPulled.fetch,
    });
    expect(!missing.ok && missing.error).toEqual({ kind: 'missing_model', model: 'b' });

    const cannotLoad = fakeFetch({
      '/version': () => json({ version: '1' }),
      '/show': () => json({}),
      '/generate': () => new Response('oom', { status: 500 }),
    });
    const load = await preflightOllama({
      baseUrl: 'http://mini:11434',
      models: ['a'],
      fetch: cannotLoad.fetch,
    });
    expect(!load.ok && load.error).toEqual({
      kind: 'load_failed',
      model: 'a',
      message: 'HTTP 500',
    });

    expect(
      describeOllamaPreflightError({ kind: 'unreachable', baseUrl: 'u', message: 'm' }),
    ).toContain('OLLAMA_BASE_URL');
    expect(describeOllamaPreflightError({ kind: 'missing_model', model: 'x' })).toContain(
      'agents.yaml',
    );
    expect(
      describeOllamaPreflightError({ kind: 'load_failed', model: 'x', message: 'm' }),
    ).toContain('x');
  });
});

describe('probeOllamaFormat', () => {
  const schema = z.object({ answer: z.enum(['yes', 'no']), score: z.int().min(1).max(5) });

  it('sends the JSON schema as format and reports whether each reply honoured it', async () => {
    const replies = ['{"answer":"yes","score":3}', '{"answer":"maybe","score":3}', 'not json'];
    let n = 0;
    const { fetch, seen } = fakeFetch({
      '/chat': () =>
        json({
          message: { content: replies[n++] ?? '' },
          done_reason: 'stop',
          prompt_eval_count: 40,
          eval_count: 12,
        }),
    });
    let t = 0;
    const results = await probeOllamaFormat({
      baseUrl: 'http://mini:11434',
      model: 'm',
      schema,
      system: 'answer',
      prompts: ['p1', 'p2', 'p3'],
      think: true,
      numPredict: 256,
      fetch,
      now: () => (t += 10),
    });
    expect(
      results.map((r) => [r.ok, r.json, r.valid, r.doneReason, r.evalCount, r.latencyMs]),
    ).toEqual([
      [true, true, true, 'stop', 12, 10],
      [true, true, false, 'stop', 12, 10],
      [true, false, false, 'stop', 12, 10],
    ]);
    expect(seen[0]?.body).toMatchObject({
      model: 'm',
      stream: false,
      think: true,
      options: { num_predict: 256, num_ctx: 32_768 },
      messages: [
        { role: 'system', content: 'answer' },
        { role: 'user', content: 'p1' },
      ],
    });
    const body = seen[0]?.body as { format: { properties: Record<string, unknown> } };
    expect(Object.keys(body.format.properties).sort()).toEqual(['answer', 'score']);
  });

  it('records HTTP failures, odd replies and thrown errors without throwing', async () => {
    let n = 0;
    const { fetch } = fakeFetch({
      '/chat': () => {
        n += 1;
        if (n === 1) return new Response('busy', { status: 503 });
        if (n === 2) return json({ unexpected: true });
        throw new Error('socket hang up');
      },
    });
    const results = await probeOllamaFormat({
      baseUrl: 'http://mini:11434',
      model: 'm',
      schema,
      system: 's',
      prompts: ['a', 'b', 'c'],
      fetch,
    });
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [false, 'HTTP 503'],
      [false, 'unexpected reply shape'],
      [false, 'socket hang up'],
    ]);
  });
});
