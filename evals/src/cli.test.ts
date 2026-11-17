import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProblems, main, renderEvalBanner, USAGE, type EvalIo } from './cli';
import { JUDGE_USAGE, judgeMain } from './rejudge-cli';

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

  it('takes --baseline as a model alias of the roster, and refuses one it does not have', async () => {
    const out = await tempDir();
    const unknown = capture();
    expect(await main(base(out, '--baseline', 'gpt'), unknown.io)).toBe(2);
    expect(unknown.lines.join('\n')).toContain(
      '--baseline names the unknown model alias "gpt"; aliases are sonnet, haiku',
    );
    // A control pass: the stand-in is named in the banner and in the report's header.
    const { lines, io } = capture();
    const code = await main(
      base(out, '--limit', '1', '--label', 'control', '--baseline', 'local'),
      io,
    );
    const text = lines.join('\n');
    expect(code, text).toBe(0);
    expect(text).toMatch(/baseline\s+local\s+ollama\/qwen3\.6:35b-a3b-q8_0/);
    expect(text).toContain(
      "--baseline local: this model writes the baseline in place of the profile's `local-fast`",
    );
    const dirs = await readdir(out);
    const passDir = dirs.find((d) => d.endsWith('-control'));
    if (passDir === undefined) throw new Error('no results folder');
    const report = await readFile(join(out, passDir, 'report.md'), 'utf8');
    expect(report).toContain('- Baseline: `local` (ollama/qwen3.6:35b-a3b-q8_0)');
    expect(report).toContain(
      '  - **Control pass.** --baseline local: this model writes the baseline',
    );
    expect(USAGE.join('\n')).toContain('--baseline <alias>');
  });

  it('judges again without running a swarm: pairwise and solo, from an earlier pass’s answers', async () => {
    const out = await tempDir();
    const first = capture();
    expect(await main(base(out, '--limit', '2', '--label', 'earlier'), first.io)).toBe(0);
    const { lines, io } = capture();
    const code = await judgeMain(
      [
        ...base(out, '--label', 'again', '--problems', 'mobile-release-cadence,local-first-sync'),
        '--pair',
        'earlier=local-fast',
        '--solo',
        'swarm:earlier,baseline:local-fast',
      ],
      io,
    );
    const text = lines.join('\n');
    expect(code, text).toBe(0);
    expect(text).toContain('== Judge-only session: no swarm runs ==');
    expect(text).toContain(
      'the swarm answers of earlier beside the local-fast baselines, both orders',
    );
    expect(text).toContain('judge calls   8');
    expect(text).toContain('Judged 2 of 2 pairs and 4 of 4 answers alone');
    // No swarm ran, and the baselines came from the cache the first pass filled.
    expect(text).not.toContain(': swarm run (cap');
    const dirs = await readdir(out);
    const dir = dirs.find((d) => d.endsWith('-again'));
    if (dir === undefined) throw new Error('no results folder');
    const report = await readFile(join(out, dir, 'report.md'), 'utf8');
    expect(report).toContain('# Judge-only session: again');
    expect(report).not.toContain('## Baselines made');
    expect(report).toContain('### mobile-release-cadence');
    // The earlier pass's swarm answer: its score there, its score here, and its solo score.
    expect(report).toMatch(
      /\| swarm answer of earlier \| \d+ \/ 1350 \| \d+\.\d% \| \d+\.\d% beside the fake-baseline baseline \(earlier\); \d+\.\d% beside the fake-baseline baseline \(again\) \|/,
    );
    const json = JSON.parse(await readFile(join(out, dir, 'report.json'), 'utf8')) as {
      session: { pairs: unknown[]; solo: unknown[]; spentUsd: number };
    };
    expect(json.session.pairs).toHaveLength(2);
    expect(json.session.solo).toHaveLength(4);
    expect(json.session.spentUsd).toBeGreaterThan(0);
  });

  it('refuses a judge-only session that names nothing, a pass that does not exist or a bad reference', async () => {
    const out = await tempDir();
    const nothing = capture();
    expect(await judgeMain(base(out), nothing.io)).toBe(2);
    expect(nothing.lines.join('\n')).toContain('nothing to judge: give --pair, --solo or both');
    const missing = capture();
    expect(await judgeMain([...base(out), '--solo', 'swarm:never-ran'], missing.io)).toBe(2);
    expect(missing.lines.join('\n')).toContain('no pass labelled "never-ran"');
    const bad = capture();
    expect(await judgeMain([...base(out), '--solo', 'sonnet'], bad.io)).toBe(2);
    expect(bad.lines.join('\n')).toContain('"sonnet" is not swarm:<pass> or baseline:<alias>');
    const alias = capture();
    expect(await judgeMain([...base(out), '--solo', 'baseline:gpt'], alias.io)).toBe(2);
    expect(alias.lines.join('\n')).toContain('the session names the unknown model alias "gpt"');
    const pair = capture();
    expect(await judgeMain([...base(out), '--pair', 'earlier'], pair.io)).toBe(2);
    expect(pair.lines.join('\n')).toContain('--pair takes <pass>=<alias>, got "earlier"');
    expect(JUDGE_USAGE.join('\n')).toContain('pnpm eval:judge');
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
