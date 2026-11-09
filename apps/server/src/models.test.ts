import { fileURLToPath } from 'node:url';

import { nullLogger, resolveProfile } from '@team/core';
import { ManualClock, SequentialIdGenerator, testRolePrompts } from '@team/core/testing';
import { DEFAULT_MONTHLY_BUDGET, loadRosterFile, openDatabase } from '@team/host';
import { pricingFor } from '@team/providers';
import { describe, expect, it } from 'vitest';

import { scriptedModels } from './models';
import { RunManager } from './run-manager';

const ROSTER = fileURLToPath(new URL('../../../agents.yaml', import.meta.url));

const profileNamed = async (name: string) => {
  const roster = await loadRosterFile(ROSTER);
  if (!roster.ok) throw new Error(roster.error);
  const profile = resolveProfile(roster.value, name);
  if (!profile.ok) throw new Error(`no ${name} profile`);
  return { roster: roster.value, profile: profile.value };
};

const request = (profile: Awaited<ReturnType<typeof profileNamed>>['profile']) => ({
  profile,
  sink: () => undefined,
  charsPerToken: () => undefined,
  currentView: () => {
    throw new Error('not needed to build the models');
  },
});

describe('scriptedModels (--fake)', () => {
  it('prices each stand-in like the model it stands in for', async () => {
    const source = scriptedModels({ delayMs: 0 });
    const dev = await source(request((await profileNamed('dev')).profile));
    expect(dev.ok && Object.values(dev.value.roles).map((m) => [m.billing, m.pricing])).toEqual(
      Array.from({ length: 5 }, () => ['fake', null]),
    );
    expect(dev.ok && dev.value.fallback).toBeUndefined();

    const cheap = await source(request((await profileNamed('cheap')).profile));
    if (!cheap.ok) throw new Error(cheap.error.message);
    const haiku = pricingFor('claude-haiku-5-5');
    expect(haiku).toBeDefined();
    expect(cheap.value.roles.planner.pricing).toEqual(haiku);
    expect(cheap.value.roles.critic.pricing).toEqual(haiku);
    expect(cheap.value.roles.researcher.pricing).toBeNull();
    expect(cheap.value.roles.solver.pricing).toBeNull();
  });

  it('refuses a paid model the price table does not know', async () => {
    const { profile } = await profileNamed('cheap');
    const unknown = {
      ...profile,
      roles: { ...profile.roles, critic: { ...profile.roles.critic, model: 'claude-unpriced' } },
    };
    const built = await scriptedModels({ delayMs: 0 })(request(unknown));
    expect(!built.ok && built.error.message).toContain(
      'no price for anthropic/claude-unpriced in the price table',
    );
  });

  it('runs the scripted swarm to completion through the run manager, pacing and tracing every call', async () => {
    const { roster } = await profileNamed('dev');
    const waits: number[] = [];
    const opened = openDatabase(':memory:');
    try {
      const manager = new RunManager({
        db: opened.db,
        roster,
        prompts: testRolePrompts(),
        clock: new ManualClock(),
        ids: new SequentialIdGenerator(),
        logger: nullLogger,
        monthlyBudget: { ...DEFAULT_MONTHLY_BUDGET, timeZone: 'UTC' },
        models: scriptedModels({
          delayMs: 250,
          sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        }),
      });
      const started = await manager.start({ problem: { content: 'Should we adopt a monorepo?' } });
      if (!started.ok) throw new Error(started.error.kind);
      await manager.settled(started.value.id);
      expect(manager.get(started.value.id)).toMatchObject({
        status: 'completed',
        reason: 'completed',
        profileName: 'dev',
        totals: { rounds: 4, usage: { costUsd: 0 } },
      });
      const calls = manager.calls.forRun(started.value.id);
      expect(calls.length).toBe(7);
      expect(calls.every((c) => c.billing === 'fake' && c.outcome === 'ok')).toBe(true);
      expect(waits).toEqual(Array.from({ length: 7 }, () => 250));
      // Fake calls never reach the monthly ledger, whatever they are priced at.
      const period = { start: '2000-01-01T00:00:00.000Z', end: '2100-01-01T00:00:00.000Z' };
      expect(await manager.ledger.spentUsd(period)).toBe(0);
    } finally {
      opened.close();
    }
  });
});
