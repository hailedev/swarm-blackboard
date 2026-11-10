import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProblems, main, renderEvalBanner, USAGE, type EvalIo } from './cli';

const ROSTER = fileURLToPath(new URL('../../agents.yaml', import.meta.url));
const PROBLEMS = fileURLToPath(new URL('../problems', import.meta.url));

const capture = (confirm?: EvalIo['confirm']) => {
  const lines: string[] = [];
  const io: EvalIo = { write: (line) => lines.push(line) };
  if (confirm !== undefined) io.confirm = confirm;
  return { lines, io };
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-eval-'));
  tempDirs.push(dir);
  return dir;
};

// Every test runs the scripted models against the repository roster and problems, on an
// in-memory database and a temporary results folder: nothing real is read or written.
const base = (out: string, ...args: string[]): string[] => [
  '--fake',
  '--roster',
  ROSTER,
  '--problems-dir',
  PROBLEMS,
  '--db',
  ':memory:',
  '--out',
  out,
  '--seed',
  '11',
  ...args,
];

describe('pnpm eval --fake', () => {
  it('runs two problems through swarm, baseline and judge and writes the report and pairs', async () => {
    const out = await tempDir();
    const { lines, io } = capture();
    const code = await main(base(out, '--limit', '2', '--label', 'smoke'), io);
    const text = lines.join('\n');
    expect(code, text).toBe(0);
    expect(text).toContain('== Eval pass: swarm profile "dev" ==');
    expect(text).toContain('--fake: scripted models stand in for these; nothing is billed.');
    expect(text).toContain('== mobile-release-cadence: swarm run');
    expect(text).toContain('== local-first-sync: swarm run');
    expect(text).toMatch(/over 2 judged pairs/);
    const dirs = await readdir(out);
    const passDir = dirs.find((d) => d.endsWith('-smoke'));
    expect(passDir).toBeDefined();
    if (passDir === undefined) return;
    const report = await readFile(join(out, passDir, 'report.md'), 'utf8');
    expect(report).toContain('# Eval pass: smoke');
    expect(report).toContain('| mobile-release-cadence |');
    expect(report).toContain('completed/completed');
    expect(report).toMatch(/Judged pairs \| 2 of 2/);
    const pairs = await readdir(join(out, passDir, 'pairs'));
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const json = JSON.parse(await readFile(join(out, passDir, 'report.json'), 'utf8')) as {
      pass: { spentUsd: number; results: { swarm: { answer: string } }[] };
    };
    expect(json.pass.spentUsd).toBeGreaterThan(0);
    // The scripted synthesis arrives as paragraphs and is stored as one string.
    expect(json.pass.results[0]?.swarm.answer).toContain('\n\n');
    // Baselines are cached under the results root.
    expect((await readdir(join(out, 'baselines'))).sort()).toEqual([
      'local-first-sync--fake-baseline.json',
      'mobile-release-cadence--fake-baseline.json',
    ]);
  });

  it('hits the baseline cache on a second pass and says so in the report', async () => {
    const out = await tempDir();
    expect(
      await main(base(out, '--problems', 'oidc-migration', '--label', 'first'), capture().io),
    ).toBe(0);
    const { lines, io } = capture();
    expect(await main(base(out, '--problems', 'oidc-migration', '--label', 'second'), io)).toBe(0);
    expect(lines.join('\n')).toContain('baseline: cached');
    const second = (await readdir(out)).find((d) => d.endsWith('-second'));
    if (second === undefined) throw new Error('no second pass');
    expect(await readFile(join(out, second, 'report.md'), 'utf8')).toContain('baseline cached');
  });

  it('refuses unknown problem ids, bad numbers and bad flags with usage', async () => {
    const out = await tempDir();
    const unknown = capture();
    expect(await main(base(out, '--problems', 'nope'), unknown.io)).toBe(2);
    expect(unknown.lines.join('\n')).toContain('unknown problem id(s): nope');
    const cap = capture();
    expect(await main(base(out, '--max-cost', 'lots'), cap.io)).toBe(2);
    expect(cap.lines[0]).toContain('--max-cost');
    const orders = capture();
    expect(await main(base(out, '--judge-orders', '3'), orders.io)).toBe(2);
    const flag = capture();
    expect(await main(['--bogus'], flag.io)).toBe(2);
    expect(flag.lines).toEqual(expect.arrayContaining(USAGE));
    const help = capture();
    expect(await main(['--help'], help.io)).toBe(0);
  });

  it('refuses a profile without an evals entry and an unknown profile', async () => {
    const out = await tempDir();
    const { lines, io } = capture();
    expect(await main(base(out, '--profile', 'nope'), io)).toBe(2);
    expect(lines.join('\n')).toContain('unknown profile "nope"');
  });
});

describe('loadProblems', () => {
  it('loads the committed problems in file order', async () => {
    const loaded = await loadProblems(PROBLEMS);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.length).toBeGreaterThanOrEqual(10);
    expect(loaded.value[0]?.id).toBe('mobile-release-cadence');
    expect((await loadProblems(join(PROBLEMS, 'missing'))).ok).toBe(false);
  });
});

describe('renderEvalBanner', () => {
  it('lists the swarm roles, the eval models, the caps and the month', () => {
    const local = { alias: 'local-fast', provider: 'ollama' as const, model: 'qwen', think: false };
    const lines = renderEvalBanner({
      profile: {
        name: 'dev',
        roles: {
          planner: local,
          researcher: local,
          solver: local,
          critic: local,
          synthesizer: local,
        },
        bidder: null,
        fallback: null,
        paid: false,
      },
      evalModels: {
        baseline: { alias: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5-5' },
        judge: { alias: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      },
      passCapUsd: 1,
      runCapUsd: 0.08,
      problems: 10,
      month: { spentUsd: 4.2, limitUsd: 5, warnAtFraction: 0.8 },
      fake: false,
    });
    expect(lines[0]).toBe('== Eval pass: swarm profile "dev" ==');
    expect(lines.join('\n')).toContain('baseline      sonnet       anthropic/claude-sonnet-5-5');
    expect(lines.join('\n')).toContain('synthesizer   local-fast   ollama/qwen  free');
    expect(lines.join('\n')).toContain('pass cap      $1.0000');
    expect(lines.join('\n')).toContain(
      'this month    $4.2000 of $5.00 (84%)  ! past 80% of the monthly limit',
    );
  });
});
