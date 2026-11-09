import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ManualClock } from '@team/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { main, USAGE, type SolveIo } from './run-solve';

const ROSTER = fileURLToPath(new URL('../../../agents.yaml', import.meta.url));

const capture = (confirm?: SolveIo['confirm']) => {
  const lines: string[] = [];
  const io: SolveIo = { write: (line: string) => lines.push(line) };
  if (confirm !== undefined) io.confirm = confirm;
  return { lines, io };
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-solve-'));
  tempDirs.push(dir);
  return dir;
};

// A port nothing listens on, so a "real" run's Ollama pre-flight is refused at once
// without touching the network beyond the loopback interface.
const closedOllamaUrl = async (): Promise<string> => {
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
  return `http://127.0.0.1:${String(port)}`;
};

// Every test points at the repository roster and an empty ledger in a temp dir, so the
// real data/spend.jsonl is never read or written.
const base = async (...args: string[]): Promise<string[]> => [
  '--fake',
  '--roster',
  ROSTER,
  '--ledger',
  join(await tempDir(), 'spend.jsonl'),
  ...args,
];

describe('pnpm solve', () => {
  it('runs the scripted swarm to completion and prints the board round by round', async () => {
    const { lines, io } = capture();
    const code = await main(['Should we adopt a monorepo?', ...(await base())], io);
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Problem: Should we adopt a monorepo?');
    expect(text).toContain('profile "dev", scripted models, 5 agents');
    expect(text).toContain('== Round 1: planner ==');
    expect(text).toContain('== Round 2: solver + researcher ==');
    expect(text).toContain('== Round 3: critic + solver ==');
    expect(text).toContain('== Round 4: critic + synthesizer ==');
    expect(text).toContain('-- synthesis (1 live) --');
    expect(text).toContain('== Done: completed after 4 rounds ==');
    expect(text).toContain('cost $0.0000');
    expect(text).toContain('Answer:');
    expect(text).not.toContain('Budget check');
    expect(text).not.toContain('[info]');
    expect(text).not.toContain(' ! ');
  });

  it('honours --max-rounds, --parallelism and --verbose', async () => {
    const { lines, io } = capture();
    const code = await main(
      ['P', ...(await base('--max-rounds', '2', '--parallelism', '1', '--verbose'))],
      io,
    );
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('== Round 2: solver ==');
    expect(text).toContain('== Done: budget_rounds after 2 rounds ==');
    expect(text).toContain('[info] run started');
  });

  it('writes the event log as JSON when asked, with the profile on run_started', async () => {
    const file = join(await tempDir(), 'events.json');
    const { lines, io } = capture();
    const code = await main(['P', ...(await base('--json', file, '--max-cost', '0.5'))], io);
    expect(code).toBe(0);
    const events = JSON.parse(await readFile(file, 'utf8')) as {
      type: string;
      seq: number;
      profile?: { name: string; paid: boolean };
      config?: { maxCostUsd: number };
    }[];
    expect(events[0]?.type).toBe('run_started');
    expect(events[0]?.profile).toMatchObject({ name: 'dev', paid: false });
    expect(events[0]?.config?.maxCostUsd).toBe(0.5);
    expect(events.at(-1)?.type).toBe('run_terminated');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(lines.at(-1)).toBe(`Wrote ${String(events.length)} events to ${file}`);
  });

  describe('paid profiles', () => {
    it('shows the budget banner and refuses without --yes when nobody can confirm', async () => {
      const { lines, io } = capture();
      const code = await main(['P', ...(await base('--profile', 'cheap'))], io);
      const text = lines.join('\n');
      expect(code).toBe(2);
      expect(text).toContain('== Budget check: profile "cheap" ==');
      expect(text).toContain('planner       haiku        anthropic/claude-haiku-5-5');
      expect(text).toContain('researcher    local        ollama/qwen3.6:35b-a3b-q8_0  free');
      expect(text).toContain('fallback      haiku        anthropic/claude-haiku-5-5');
      expect(text).toContain('per-run cap   $0.2500');
      expect(text).toContain('this month    $0.0000 of $5.00 (0%)');
      expect(text).toContain('--fake: scripted models stand in for these; nothing is billed.');
      expect(lines.at(-1)).toBe(
        'Refusing to start a paid profile without confirmation: pass --yes.',
      );
    });

    it('asks interactively when it can, and aborts on no', async () => {
      const asked: string[] = [];
      const { lines, io } = capture((question) => {
        asked.push(question);
        return Promise.resolve(false);
      });
      const code = await main(['P', ...(await base('--profile', 'quality'))], io);
      expect(code).toBe(2);
      expect(asked).toEqual(['Proceed? [y/N] ']);
      expect(lines.at(-1)).toBe('Aborted.');
    });

    it('runs after a yes, pricing the stand-ins like the profile and billing nothing', async () => {
      const ledgerPath = join(await tempDir(), 'spend.jsonl');
      const { lines, io } = capture(() => Promise.resolve(true));
      const code = await main(
        ['P', '--fake', '--roster', ROSTER, '--ledger', ledgerPath, '--profile', 'cheap'],
        io,
        { MONTHLY_BUDGET_USD: '2', BUDGET_TIMEZONE: 'UTC' },
      );
      const text = lines.join('\n');
      expect(code).toBe(0);
      expect(text).toContain('this month    $0.0000 of $2.00 (0%)');
      expect(text).toContain('profile "cheap", scripted models, 5 agents');
      expect(text).toContain('== Done: completed after 4 rounds ==');
      // Haiku-priced planner, critic and synthesizer calls; local roles are free.
      expect(text).toMatch(/cost \$0\.00(1|2)\d/);
      await expect(readFile(ledgerPath, 'utf8')).rejects.toThrow();
    });

    it('refuses to start when the month cannot absorb the per-run cap', async () => {
      const ledgerPath = join(await tempDir(), 'spend.jsonl');
      const spent = {
        at: new Date().toISOString(),
        runId: 'earlier',
        role: 'critic',
        modelId: 'claude-sonnet-5-5',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 4.9,
      };
      await writeFile(ledgerPath, `${JSON.stringify(spent)}\n`);
      const { lines, io } = capture();
      const code = await main(
        [
          'P',
          '--fake',
          '--roster',
          ROSTER,
          '--ledger',
          ledgerPath,
          '--profile',
          'quality',
          '--yes',
        ],
        io,
      );
      expect(code).toBe(2);
      expect(lines.join('\n')).toContain(
        'this month    $4.9000 of $5.00 (98%)  ! past 80% of the monthly limit',
      );
      expect(lines.at(-1)).toBe(
        'Could not start: monthly budget: $4.9000 of $5.0000 already spent this month; a per-run cap of $0.1000 or less would fit, $0.2500 was asked for',
      );
    });

    it('rejects an unknown profile with the valid names, and a bad monthly budget', async () => {
      const unknown = capture();
      expect(await main(['P', ...(await base('--profile', 'prod'))], unknown.io)).toBe(2);
      expect(unknown.lines).toEqual([
        'unknown profile "prod"; valid profiles are "dev", "cheap", "quality"',
      ]);

      const badEnv = capture();
      expect(
        await main(['P', ...(await base('--profile', 'cheap', '--yes'))], badEnv.io, {
          MONTHLY_BUDGET_USD: 'lots',
        }),
      ).toBe(2);
      expect(badEnv.lines).toEqual(['MONTHLY_BUDGET_USD must be a valid number, got "lots"']);
    });
  });

  it('warns when the price table is stale, without failing', async () => {
    const { lines, io } = capture();
    const farFuture = new ManualClock(Date.UTC(2030, 0, 1));
    const code = await main(['P', ...(await base('--max-rounds', '1'))], io, {}, farFuture);
    expect(code).toBe(0);
    expect(lines[0]).toMatch(
      /^\[warn\] the price table is \d+ days old \(as of \d{4}-\d{2}-\d{2}\)/,
    );
  });

  it('appends every model call to the trace file as JSON lines', async () => {
    const file = join(await tempDir(), 'nested', 'trace.jsonl');
    const { lines, io } = capture();
    const code = await main(['P', ...(await base('--trace', file))], io);
    expect(code).toBe(0);
    const traces = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces.length).toBe(7);
    for (const trace of traces) {
      expect(trace).toMatchObject({ outcome: 'ok', billing: 'fake' });
      expect(typeof trace['estimatedInputTokens']).toBe('number');
      expect(trace['actualInputTokens']).toBe(1200);
    }
    expect(lines.at(-1)).toBe(`Wrote 7 model-call traces to ${file}`);
  });

  describe('real models', () => {
    it('refuses a paid profile without an API key before showing the banner', async () => {
      const { lines, io } = capture();
      const code = await main(
        [
          'P',
          '--roster',
          ROSTER,
          '--ledger',
          join(await tempDir(), 'spend.jsonl'),
          '--profile',
          'cheap',
        ],
        io,
        { OLLAMA_BASE_URL: await closedOllamaUrl() },
      );
      expect(code).toBe(2);
      expect(lines).toEqual([
        'alias "haiku" uses anthropic, but no API key is set; put ANTHROPIC_API_KEY in .env or choose a local profile',
      ]);
    });

    it('refuses a local profile when Ollama is unreachable, before spending anything', async () => {
      const url = await closedOllamaUrl();
      const { lines, io } = capture();
      const code = await main(
        ['P', '--roster', ROSTER, '--ledger', join(await tempDir(), 'spend.jsonl')],
        io,
        { OLLAMA_BASE_URL: url },
      );
      expect(code).toBe(2);
      expect(lines[0]).toBe(`Checking Ollama at ${url} and warming qwen3.6:35b-a3b-q8_0…`);
      expect(lines[1]).toContain(`Ollama is unreachable at ${url} (`);
      expect(lines[1]).toContain('is the server awake and OLLAMA_BASE_URL right?');
      expect(lines.length).toBe(2);
    });
  });

  it('prints usage for a missing problem or bad arguments', async () => {
    const empty = capture();
    expect(await main(['--fake'], empty.io)).toBe(2);
    expect(empty.lines).toEqual(USAGE);

    const unknown = capture();
    expect(await main(['P', '--fake', '--bogus'], unknown.io)).toBe(2);
    expect(unknown.lines[0]).toContain('bogus');
    expect(unknown.lines.slice(1)).toEqual(USAGE);

    const bad = capture();
    expect(await main(['P', '--fake', '--max-rounds', 'two'], bad.io)).toBe(2);
    expect(bad.lines).toEqual(['--max-rounds must be a positive integer, got "two"']);

    const money = capture();
    expect(await main(['P', '--fake', '--max-cost', 'free'], money.io)).toBe(2);
    expect(money.lines).toEqual([
      '--max-cost must be a non-negative number of dollars, got "free"',
    ]);

    const roster = capture();
    expect(await main(['P', '--fake', '--roster', 'missing.yaml'], roster.io)).toBe(2);
    expect(roster.lines[0]).toMatch(/^cannot read missing\.yaml: /);
  });
});
