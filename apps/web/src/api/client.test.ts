import { describe, expect, it } from 'vitest';

import { ApiFailure, createApiClient, failureMessage, type Fetch } from './client';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

const record = {
  id: 'run-1',
  problem: 'P',
  status: 'paused',
  reason: 'interrupted',
  profileName: 'dev',
  config: {},
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  totals: { rounds: 2, entries: 5, usage, elapsedMs: 10 },
};

const recording = (respond: (path: string, init?: RequestInit) => Response) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchImpl: Fetch = (path, init) => {
    calls.push({ path, init });
    return Promise.resolve(respond(path, init));
  };
  return { client: createApiClient(fetchImpl), calls };
};

const caught = async (promise: Promise<unknown>): Promise<ApiFailure> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiFailure) return error;
    throw error;
  }
  throw new Error('the request did not fail');
};

describe('the API client', () => {
  it('asks under /api and returns responses parsed by the server’s schemas', async () => {
    const { client, calls } = recording((path) =>
      path === '/api/runs' ? json({ runs: [record] }) : json(record),
    );
    const runs = await client.runs();
    // Parsed, not passed through: the run config has its defaults.
    expect(runs[0]).toMatchObject({
      id: 'run-1',
      reason: 'interrupted',
      config: { maxRounds: 12 },
    });
    expect((await client.run('a/b')).status).toBe('paused');
    expect(calls.map((c) => c.path)).toEqual(['/api/runs', '/api/runs/a%2Fb']);
  });

  it('posts actions and bodies as JSON', async () => {
    const { client, calls } = recording(() => json(record, 201));
    await client.start({ problem: { content: 'P' }, profile: 'dev', config: { maxRounds: 3 } });
    await client.pause('run-1');
    await client.synthesize('run-1');
    expect(calls.map((c) => [c.path, c.init?.method])).toEqual([
      ['/api/runs', 'POST'],
      ['/api/runs/run-1/pause', 'POST'],
      ['/api/runs/run-1/synthesize', 'POST'],
    ]);
    const sent = calls[0]?.init?.body;
    expect(typeof sent === 'string' ? (JSON.parse(sent) as unknown) : sent).toEqual({
      problem: { content: 'P' },
      profile: 'dev',
      config: { maxRounds: 3 },
    });
    expect(calls[1]?.init?.body).toBeUndefined();
  });

  it('turns the server’s error envelope into a failure that carries its words', async () => {
    const { client } = recording(() =>
      json(
        {
          error: {
            code: 'monthly_budget',
            message: '$4.9000 of $5.0000 already spent this month',
            details: { fitsCapUsd: 0.1 },
          },
        },
        409,
      ),
    );
    const failure = await caught(client.start({ problem: { content: 'P' } }));
    expect(failure).toMatchObject({
      status: 409,
      code: 'monthly_budget',
      message: '$4.9000 of $5.0000 already spent this month',
      details: { fitsCapUsd: 0.1 },
    });
    expect(failureMessage(failure)).toBe('$4.9000 of $5.0000 already spent this month');
    expect(failureMessage('boom')).toBe('Something went wrong.');
  });

  it('fails loudly on a response that breaks the contract, an unreadable error and no server', async () => {
    const drifted = recording(() => json({ ...record, status: 'exploded' }));
    expect(await caught(drifted.client.run('run-1'))).toMatchObject({
      code: 'contract',
      message:
        'Unexpected response from /runs/run-1 at status: the web app and the server disagree on the contract.',
    });

    const html = recording(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await caught(html.client.budget())).toMatchObject({ status: 502, code: 'http_error' });

    const down = createApiClient(() => Promise.reject(new TypeError('fetch failed')));
    expect(await caught(down.profiles())).toMatchObject({
      status: 0,
      code: 'unreachable',
      message: 'The API server did not answer (fetch failed).',
    });
  });
});
