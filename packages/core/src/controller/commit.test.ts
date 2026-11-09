import { describe, expect, it } from 'vitest';

import { zeroUsage } from '../schemas/common';
import type { Contribution } from '../schemas/contribution';
import { BoardFixture } from '../testing/board-fixture';
import { SequentialIdGenerator, sequentialId } from '../testing/sequential-id-generator';
import { linkProblems, prepareEntries } from './commit';

const unknown = sequentialId(0xffff);
const hyp = (overrides: Partial<Contribution> = {}): Contribution =>
  ({
    type: 'hypothesis',
    content: 'H',
    parents: [],
    payload: { confidence: 0.5, supportedBy: [], contradictedBy: [] },
    ...overrides,
  }) as Contribution;

describe('linkProblems', () => {
  it('accepts references to existing entries', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const e = fx.entry('evidence', { source: 's', supports: [], contradicts: [] });
    const view = fx.view();
    const cases: Contribution[] = [
      { type: 'subproblem', content: 'S', parents: [problem.id], payload: { status: 'open' } },
      hyp({
        parents: [problem.id],
        payload: { confidence: 0.5, supportedBy: [e.id], contradictedBy: [] },
      }),
      {
        type: 'evidence',
        content: 'E',
        parents: [],
        payload: { source: 's', supports: [h.id], contradicts: [] },
      },
      {
        type: 'critique',
        content: 'C',
        parents: [],
        payload: { target: h.id, severity: 'minor', resolvedBy: e.id },
      },
      { type: 'question', content: 'Q', parents: [], payload: { answeredBy: e.id } },
      {
        type: 'decision',
        content: 'D',
        parents: [],
        payload: { chosen: h.id, rejected: [h.id], rationale: 'r' },
      },
      {
        type: 'synthesis',
        content: 'S',
        parents: [],
        payload: { version: 1, confidence: 0.5, cites: [h.id, e.id] },
      },
      hyp({ supersedes: h.id }),
    ];
    for (const contribution of cases) expect(linkProblems(contribution, view)).toEqual([]);
  });

  it('names every dangling reference by field', () => {
    const fx = new BoardFixture();
    fx.problem();
    const view = fx.view();
    expect(linkProblems(hyp({ parents: [unknown] }), view)).toEqual([
      `parents references unknown entry ${unknown}`,
    ]);
    expect(
      linkProblems(
        {
          type: 'critique',
          content: 'C',
          parents: [],
          payload: { target: unknown, severity: 'major', resolvedBy: unknown },
        },
        view,
      ),
    ).toEqual([
      `target references unknown entry ${unknown}`,
      `resolvedBy references unknown entry ${unknown}`,
    ]);
    expect(
      linkProblems(
        { type: 'question', content: 'Q', parents: [], payload: { answeredBy: unknown } },
        view,
      ),
    ).toEqual([`answeredBy references unknown entry ${unknown}`]);
    expect(
      linkProblems(
        {
          type: 'decision',
          content: 'D',
          parents: [],
          payload: { chosen: unknown, rejected: [unknown], rationale: 'r' },
        },
        view,
      ).length,
    ).toBe(2);
    expect(
      linkProblems(
        {
          type: 'evidence',
          content: 'E',
          parents: [],
          payload: { source: 's', supports: [unknown], contradicts: [unknown] },
        },
        view,
      ).length,
    ).toBe(2);
    expect(
      linkProblems(
        {
          type: 'synthesis',
          content: 'S',
          parents: [],
          payload: { version: 1, confidence: 0.5, cites: [unknown] },
        },
        view,
      ).length,
    ).toBe(1);
  });

  it('checks that supersedes points at a live entry of the same type', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const old = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    fx.entry(
      'hypothesis',
      { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      { supersedes: old.id },
    );
    const view = fx.view();
    expect(linkProblems(hyp({ supersedes: unknown }), view)).toEqual([
      `supersedes unknown entry ${unknown}`,
    ]);
    expect(linkProblems(hyp({ supersedes: old.id }), view)).toEqual([
      `supersedes entry ${old.id}, which is not live`,
    ]);
    expect(linkProblems(hyp({ supersedes: problem.id }), view)).toEqual([
      'supersedes a problem entry with a hypothesis',
    ]);
  });
});

describe('prepareEntries', () => {
  it('stamps controller fields, attributes usage to the first accepted entry and drops bad links', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    const ids = new SequentialIdGenerator();
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.002,
    };
    const batch = prepareEntries({
      contributions: [
        hyp({ parents: [unknown] }),
        { type: 'subproblem', content: 'A', parents: [problem.id], payload: { status: 'open' } },
        { type: 'subproblem', content: 'B', parents: [problem.id], payload: { status: 'open' } },
      ],
      view: fx.view(),
      ids,
      runId: fx.runId,
      round: 3,
      author: 'planner',
      createdAt: '2026-01-01T00:00:00.000Z',
      usage,
    });
    expect(batch.problems).toEqual([
      `contribution 0 (hypothesis): parents references unknown entry ${unknown}`,
    ]);
    expect(batch.entries.map((e) => e.content)).toEqual(['A', 'B']);
    expect(batch.entries[0]).toMatchObject({
      id: sequentialId(1),
      runId: fx.runId,
      round: 3,
      author: 'planner',
      status: 'active',
      usage,
    });
    expect(batch.entries[1]?.usage).toEqual(zeroUsage());
  });
});

describe('prepareEntries: schema failures', () => {
  it('drops a contribution that passes the link checks but fails the entry schema', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    const batch = prepareEntries({
      contributions: [
        { type: 'subproblem', content: '', parents: [problem.id], payload: { status: 'open' } },
      ],
      view: fx.view(),
      ids: new SequentialIdGenerator(),
      runId: fx.runId,
      round: 1,
      author: 'planner',
      createdAt: '2026-01-01T00:00:00.000Z',
      usage: zeroUsage(),
    });
    expect(batch.entries).toEqual([]);
    expect(batch.problems).toEqual([
      expect.stringContaining('contribution 0 (subproblem): content:') as string,
    ]);
  });
});
