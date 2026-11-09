import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { AGENT_ROLES, type AgentRole } from '@team/core';

import { loadPromptFiles, loadRosterFile } from '@team/host';
import { renderRankingTable, renderSummaryTable, runTrial } from './trial/local-model-trial';
import { DEFAULT_OLLAMA_BASE_URL } from './run-solve';

// pnpm trial:local — the Phase 2 local-model trial (ADR-0008). Local calls only; nothing
// is billed. Expect roughly 100 calls and the better part of an hour.

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: rely on the environment
}

const USAGE = [
  'Usage: pnpm trial:local [--models a,b,c] [--roles researcher,solver] [--reps N] [--out <file>]',
  '                        [--roster <file>] [--base-url <url>]',
];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    models: { type: 'string', default: 'qwen3.6:35b-a3b-q8_0,qwen3.8:27b,qwen3.6:35b-mlx' },
    roles: { type: 'string', default: 'researcher,solver' },
    reps: { type: 'string', default: '3' },
    out: { type: 'string' },
    roster: { type: 'string', default: 'agents.yaml' },
    'base-url': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

const fail = (message: string): never => {
  console.error(message);
  USAGE.forEach((line) => {
    console.error(line);
  });
  process.exit(2);
};

if (values.help) fail('');
const reps = Number(values.reps);
if (!Number.isInteger(reps) || reps < 1)
  fail(`--reps must be a positive integer, got "${values.reps}"`);
const roles = values.roles.split(',').map((r) => r.trim());
const isRole = (r: string): r is AgentRole => (AGENT_ROLES as readonly string[]).includes(r);
if (!roles.every(isRole)) fail(`--roles must be a subset of ${AGENT_ROLES.join(', ')}`);
const models = values.models
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0);
const baseUrl = values['base-url'] ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL;
const out =
  values.out ?? `evals/results/local-model-trial-${new Date().toISOString().slice(0, 10)}.json`;

const roster = await loadRosterFile(values.roster);
if (!roster.ok) fail(roster.error);
const prompts = roster.ok ? await loadPromptFiles(roster.value, values.roster) : undefined;
if (prompts === undefined || !prompts.ok)
  fail(prompts?.ok === false ? prompts.error : 'no prompts');

if (prompts?.ok === true) {
  console.log(
    `Local-model trial against ${baseUrl}: ${models.join(', ')}; roles ${roles.join(', ')}; ${String(reps)} reps per board`,
  );
  const report = await runTrial({
    baseUrl,
    models,
    roles: roles.filter(isRole),
    reps,
    prompts: prompts.value,
    log: (line) => {
      console.log(line);
    },
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('## Format probes');
  for (const m of report.models) {
    console.log(
      `- ${m.model}: ${m.preflight.ok ? `Ollama ${m.preflight.version}, loaded in ${(m.preflight.loadMs / 1000).toFixed(0)} s` : `skipped (${m.preflight.error.kind})`}; strict schema ${m.strictProbe === null ? '-' : `${String(m.strictProbe.valid)}/${String(m.strictProbe.total)}`}, researcher schema ${m.researcherProbe === null ? '-' : `${String(m.researcherProbe.valid)}/${String(m.researcherProbe.total)}`}`,
    );
  }
  console.log('');
  console.log('## Per role');
  renderSummaryTable(report.summary).forEach((line) => {
    console.log(line);
  });
  console.log('');
  console.log('## Ranking');
  renderRankingTable(report.ranking).forEach((line) => {
    console.log(line);
  });
  console.log('');
  console.log(`Wrote ${out}`);
}
