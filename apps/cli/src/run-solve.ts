import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  createController,
  createDefaultAgents,
  InMemoryBoardStore,
  type BoardEvent,
  type Controller,
  type ControllerError,
  type RunConfigInput,
} from '@team/core';
import { createScriptedModels, SequentialIdGenerator } from '@team/core/testing';

import { createConsoleLogger } from './adapters/console-logger';
import { systemClock } from './adapters/system-clock';
import { renderBoard, renderFailure, renderRoundHeader, renderSummary } from './render';

export interface SolveIo {
  write(line: string): void;
}

export const USAGE = [
  'Usage: pnpm solve "<problem>" --fake [--max-rounds N] [--parallelism N] [--json <file>] [--verbose]',
  '',
  '  --fake         run the scripted swarm (FakeModel); real models arrive in Phase 2',
  '  --max-rounds   hard limit on rounds (default 12)',
  '  --parallelism  agents per round (default 2)',
  '  --json <file>  write every board event to <file> as JSON',
  '  --verbose      print controller info logs',
];

const options = {
  fake: { type: 'boolean', default: false },
  'max-rounds': { type: 'string' },
  parallelism: { type: 'string' },
  json: { type: 'string' },
  verbose: { type: 'boolean', default: false },
} as const;

const parseArguments = (argv: readonly string[]) => {
  try {
    const result = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return { ok: true as const, result };
  } catch (cause) {
    return {
      ok: false as const,
      message: cause instanceof Error ? cause.message : 'invalid arguments',
    };
  }
};

const describeError = (error: ControllerError): string => {
  switch (error.kind) {
    case 'invalid_config':
      return `invalid config: ${error.issues.join('; ')}`;
    case 'invalid_problem':
      return `invalid problem: ${error.issues.join('; ')}`;
    case 'store':
      return `store error: ${error.error.kind}`;
    case 'not_started':
    case 'already_started':
      return error.kind.replace('_', ' ');
    case 'terminated':
      return `run already terminated: ${error.reason}`;
  }
};

const integerOption = (name: string, raw: string | undefined): number | undefined | Error => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : new Error(`--${name} must be a positive integer, got "${raw}"`);
};

export const main = async (argv: readonly string[], io: SolveIo): Promise<number> => {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    io.write(parsed.message);
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }
  const { values, positionals } = parsed.result;

  const problem = positionals.join(' ').trim();
  if (problem.length === 0) {
    USAGE.forEach((line) => {
      io.write(line);
    });
    return 2;
  }
  if (!values.fake) {
    io.write('Real models arrive in Phase 2. Run with --fake to watch the scripted swarm.');
    return 2;
  }

  const maxRounds = integerOption('max-rounds', values['max-rounds']);
  const parallelism = integerOption('parallelism', values.parallelism);
  for (const option of [maxRounds, parallelism]) {
    if (option instanceof Error) {
      io.write(option.message);
      return 2;
    }
  }
  const config: RunConfigInput = {};
  if (typeof maxRounds === 'number') config.maxRounds = maxRounds;
  if (typeof parallelism === 'number') config.parallelism = parallelism;

  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  });
  const agents = createDefaultAgents(models);
  const events: BoardEvent[] = [];
  const controller = createController({
    store: new InMemoryBoardStore(),
    clock: systemClock,
    // Deterministic ids in --fake mode make the demo reproducible.
    ids: new SequentialIdGenerator(),
    logger: createConsoleLogger(io.write.bind(io), values.verbose ? 'info' : 'warn'),
    agents,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'agents_selected')
        io.write(renderRoundHeader(event.round, event.selected));
      if (event.type === 'agent_failed') {
        io.write(renderFailure(event.agentId, event.reason, event.detail));
      }
      if (event.type === 'round_completed' && ref.controller !== undefined) {
        renderBoard(ref.controller.currentView()).forEach((line) => {
          io.write(line);
        });
        io.write('');
      }
    },
  });
  ref.controller = controller;

  const started = await controller.start({ content: problem }, config);
  if (!started.ok) {
    io.write(`Could not start: ${describeError(started.error)}`);
    return 2;
  }
  io.write(`Problem: ${problem}`);
  io.write(`Run ${controller.runId} — scripted swarm, ${String(agents.length)} agents`);
  io.write('');

  const result = await controller.run();
  if (!result.ok) {
    io.write(`Run failed: ${describeError(result.error)}`);
    return 1;
  }
  renderSummary(result.value).forEach((line) => {
    io.write(line);
  });

  if (values.json !== undefined) {
    await writeFile(values.json, JSON.stringify(events, null, 2), 'utf8');
    io.write(`Wrote ${String(events.length)} events to ${values.json}`);
  }
  return 0;
};
