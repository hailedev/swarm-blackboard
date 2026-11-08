import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main, USAGE } from './run-solve';

const capture = () => {
  const lines: string[] = [];
  return { lines, io: { write: (line: string) => lines.push(line) } };
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pnpm solve', () => {
  it('runs the scripted swarm to completion and prints the board round by round', async () => {
    const { lines, io } = capture();
    const code = await main(['Should we adopt a monorepo?', '--fake'], io);
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Problem: Should we adopt a monorepo?');
    expect(text).toContain('== Round 1: planner ==');
    expect(text).toContain('== Round 2: solver + researcher ==');
    expect(text).toContain('== Round 3: critic + solver ==');
    expect(text).toContain('== Round 4: critic + synthesizer ==');
    expect(text).toContain('-- synthesis (1 live) --');
    expect(text).toContain('== Done: synthesis_confident after 4 rounds ==');
    expect(text).toContain('Answer:');
    expect(text).not.toContain('[info]');
    expect(text).not.toContain(' ! ');
  });

  it('honours --max-rounds, --parallelism and --verbose', async () => {
    const { lines, io } = capture();
    const code = await main(
      ['P', '--fake', '--max-rounds', '2', '--parallelism', '1', '--verbose'],
      io,
    );
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('== Round 2: solver ==');
    expect(text).toContain('== Done: budget:rounds after 2 rounds ==');
    expect(text).toContain('[info] run started');
  });

  it('writes the event log as JSON when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-solve-'));
    tempDirs.push(dir);
    const file = join(dir, 'events.json');
    const { lines, io } = capture();
    const code = await main(['P', '--fake', '--json', file], io);
    expect(code).toBe(0);
    const events = JSON.parse(await readFile(file, 'utf8')) as { type: string; seq: number }[];
    expect(events[0]?.type).toBe('run_started');
    expect(events.at(-1)?.type).toBe('run_terminated');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(lines.at(-1)).toBe(`Wrote ${String(events.length)} events to ${file}`);
  });

  it('refuses to run without --fake until Phase 2', async () => {
    const { lines, io } = capture();
    expect(await main(['P'], io)).toBe(2);
    expect(lines[0]).toContain('Real models arrive in Phase 2');
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
  });
});
