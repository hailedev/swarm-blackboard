import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ModelContribution } from '../schemas/contribution';
import { agentContext } from '../testing/agent-context';
import { BoardFixture } from '../testing/board-fixture';
import { testRolePrompts } from '../testing/role-prompts';
import { midRunBoard } from '../testing/sample-boards';
import { buildAgentRequest, referenceSchemasFor, resolveHandles } from './handles';
import { critic } from './roles/critic';
import { solver } from './roles/solver';

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('fixture changed');
  return value;
};

const enumValues = (schema: z.ZodType): string[] => {
  const json = z.toJSONSchema(schema) as { enum?: string[] };
  return json.enum ?? [];
};

describe('referenceSchemasFor', () => {
  it('admits every named handle for links and only live same-type handles for supersedes', () => {
    const board = midRunBoard();
    const view = board.fx.view();
    // S1 is superseded by S3; H1, E1, E2, C1 are live; Q1 is live.
    const refs = referenceSchemasFor(view, ['P1', 'S1', 'S2', 'S3', 'H1', 'E1', 'E2', 'C1', 'Q1']);
    expect(enumValues(refs.any)).toEqual(['P1', 'S1', 'S2', 'S3', 'H1', 'E1', 'E2', 'C1', 'Q1']);
    expect(enumValues(must(refs.liveOf.subproblem))).toEqual(['S2', 'S3']);
    expect(enumValues(must(refs.liveOf.hypothesis))).toEqual(['H1']);
    expect(enumValues(must(refs.liveOf.evidence))).toEqual(['E1', 'E2']);
    expect(enumValues(must(refs.liveOf.critique))).toEqual(['C1']);
    expect(enumValues(must(refs.liveOf.question))).toEqual(['Q1']);
    expect(refs.liveOf.decision).toBeUndefined();
    expect(refs.liveOf.synthesis).toBeUndefined();
  });
});

describe('buildAgentRequest', () => {
  it('renders the prompt and a schema whose enums are the handles the prompt names', () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const hyp1 = must(board.hypotheses[0]);
    const built = buildAgentRequest(
      critic,
      view,
      agentContext({ runId: board.fx.runId, round: 4, targetIds: [hyp1.id] }),
      testRolePrompts().critic,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.handles).toEqual([
      'P1',
      'S1',
      'S2',
      'S3',
      'H1',
      'E1',
      'E2',
      'C1',
      'Q1',
      'N1',
    ]);
    expect(built.value.prompt).toContain('## [hypothesis] H1 (target)');
    const accepted = built.value.schema.safeParse({
      contributions: [
        {
          type: 'critique',
          content: 'c',
          parents: ['H1', 'E2'],
          payload: { target: 'H1', severity: 'minor' },
        },
      ],
    });
    expect(accepted.success).toBe(true);
    const unknown = built.value.schema.safeParse({
      contributions: [
        {
          type: 'critique',
          content: 'c',
          parents: ['H1'],
          payload: { target: 'H7', severity: 'minor' },
        },
      ],
    });
    expect(unknown.success).toBe(false);
    const uuid = built.value.schema.safeParse({
      contributions: [
        {
          type: 'critique',
          content: 'c',
          parents: [hyp1.id],
          payload: { target: 'H1', severity: 'minor' },
        },
      ],
    });
    expect(uuid.success).toBe(false);
  });

  it('lets the solver supersede a live hypothesis but not a superseded subproblem', () => {
    const board = midRunBoard();
    const view = board.fx.view();
    const built = buildAgentRequest(
      solver,
      view,
      agentContext({
        runId: board.fx.runId,
        round: 4,
        targetIds: board.subproblems.map((s) => s.id),
      }),
      testRolePrompts().solver,
    );
    if (!built.ok) throw new Error('no handles');
    const hypothesis = {
      type: 'hypothesis',
      content: 'h',
      parents: ['S2'],
      payload: { confidence: 0.5, supportedBy: ['E1'], contradictedBy: [] },
    };
    expect(
      built.value.schema.safeParse({ contributions: [{ ...hypothesis, supersedes: 'H1' }] })
        .success,
    ).toBe(true);
    const claim = {
      type: 'subproblem',
      content: 's',
      parents: ['P1'],
      payload: { status: 'claimed' },
    };
    expect(
      built.value.schema.safeParse({ contributions: [{ ...claim, supersedes: 'S2' }] }).success,
    ).toBe(true);
    expect(
      built.value.schema.safeParse({ contributions: [{ ...claim, supersedes: 'S1' }] }).success,
    ).toBe(false);
  });

  it('fails when the board names nothing', () => {
    const built = buildAgentRequest(
      solver,
      new BoardFixture().view(),
      agentContext(),
      testRolePrompts().solver,
    );
    expect(!built.ok && built.error).toEqual({ kind: 'no_visible_entries' });
  });
});

describe('resolveHandles', () => {
  it('maps every reference field from handle to entry id', () => {
    const board = midRunBoard();
    const { fx } = board;
    const hyp1 = must(board.hypotheses[0]);
    const [ev1, ev2] = board.evidence;
    const q1 = must(board.questions[0]);
    const crit1 = must(board.critiques[0]);
    const view = fx.view();
    const contributions: ModelContribution[] = [
      {
        type: 'hypothesis',
        content: 'h',
        parents: ['S2'],
        supersedes: 'H1',
        payload: { confidence: 0.6, supportedBy: ['E1'], contradictedBy: ['E2'] },
      },
      {
        type: 'evidence',
        content: 'e',
        parents: ['P1'],
        payload: { source: 's', supports: ['H1'], contradicts: [] },
      },
      {
        type: 'critique',
        content: 'c',
        parents: ['H1'],
        payload: { target: 'H1', severity: 'major', resolvedBy: 'E2' },
      },
      { type: 'question', content: 'q', parents: [], payload: { answeredBy: 'E1' } },
      { type: 'question', content: 'q2', parents: [], supersedes: 'Q1', payload: {} },
      {
        type: 'decision',
        content: 'd',
        parents: ['H1'],
        payload: { chosen: 'H1', rejected: ['C1'], rationale: 'r' },
      },
      {
        type: 'synthesis',
        content: ['a', 'b'],
        parents: ['H1', 'E1'],
        payload: { version: 1, confidence: 0.7, cites: ['H1', 'E1', 'E2'] },
      },
      { type: 'subproblem', content: 's', parents: ['P1'], payload: { status: 'open' } },
    ];
    const resolved = resolveHandles(contributions, view);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const s2 = must(board.subproblems[1]);
    expect(resolved.value[0]).toEqual({
      type: 'hypothesis',
      content: 'h',
      parents: [s2.id],
      supersedes: hyp1.id,
      payload: { confidence: 0.6, supportedBy: [must(ev1).id], contradictedBy: [must(ev2).id] },
    });
    expect(resolved.value[1]).toMatchObject({
      parents: [board.problem.id],
      payload: { supports: [hyp1.id], contradicts: [] },
    });
    expect(resolved.value[2]).toMatchObject({
      payload: { target: hyp1.id, severity: 'major', resolvedBy: must(ev2).id },
    });
    expect(resolved.value[3]).toMatchObject({ payload: { answeredBy: must(ev1).id } });
    expect(resolved.value[4]).toEqual({
      type: 'question',
      content: 'q2',
      parents: [],
      supersedes: q1.id,
      payload: {},
    });
    expect(resolved.value[5]).toMatchObject({
      payload: { chosen: hyp1.id, rejected: [crit1.id], rationale: 'r' },
    });
    expect(resolved.value[6]).toMatchObject({
      // The synthesis arrives as paragraphs and is stored as one string with blank lines.
      content: 'a\n\nb',
      parents: [hyp1.id, must(ev1).id],
      payload: { cites: [hyp1.id, must(ev1).id, must(ev2).id] },
    });
    expect(resolved.value[7]).toEqual(
      contributions[7] && { ...contributions[7], parents: [board.problem.id] },
    );
    // No key is added that the model did not send.
    expect('supersedes' in must(resolved.value[1])).toBe(false);
    expect('resolvedBy' in must(resolved.value[5]).payload).toBe(false);
  });

  it('reports every unknown handle with its path', () => {
    const view = midRunBoard().fx.view();
    const resolved = resolveHandles(
      [
        {
          type: 'hypothesis',
          content: 'h',
          parents: ['S2', 'S9'],
          supersedes: 'H4',
          payload: { confidence: 0.5, supportedBy: [], contradictedBy: ['E8'] },
        },
      ],
      view,
    );
    expect(!resolved.ok && resolved.error).toEqual([
      'contributions.0.supersedes: unknown handle "H4"',
      'contributions.0.parents.1: unknown handle "S9"',
      'contributions.0.payload.contradictedBy.0: unknown handle "E8"',
    ]);
  });
});
