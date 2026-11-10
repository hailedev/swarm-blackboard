import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  blindOrder,
  blindText,
  judgePrompt,
  judgementSchema,
  mulberry32,
  swapped,
  unblind,
  type Judgement,
} from './judge';
import type { Problem } from './problems';

const problem: Problem = {
  id: 'demo',
  title: 'Demo',
  domain: 'test',
  constraints: ['c1'],
  successCriteria: ['s1'],
  rubric: [
    { id: 'alpha', weight: 3, criterion: 'Alpha', scale: '0 = no; 3 = yes' },
    { id: 'beta', weight: 1, criterion: 'Beta', scale: '0 = no; 3 = yes' },
    { id: 'gamma', weight: 2, criterion: 'Gamma', scale: '0 = no; 3 = yes' },
  ],
  statement: 'Do the thing.',
};

describe('judgementSchema', () => {
  it('requires a score and a reason for every criterion of both answers', () => {
    const schema = judgementSchema(problem);
    const score = { score: 2, reason: 'because' };
    const full = { alpha: score, beta: score, gamma: score };
    expect(schema.safeParse({ A: full, B: full, overall: 'tie', note: '' }).success).toBe(true);
    expect(
      schema.safeParse({ A: { alpha: score, beta: score }, B: full, overall: 'A', note: '' })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        A: { ...full, alpha: { score: 4, reason: 'r' } },
        B: full,
        overall: 'A',
        note: '',
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ A: full, B: full, overall: 'C', note: '' }).success).toBe(false);
  });
});

describe('blind order', () => {
  it('is reproducible from the seed and covers both orders', () => {
    const orders = (seed: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: 20 }, () => blindOrder(rng).A);
    };
    expect(orders(42)).toEqual(orders(42));
    expect(new Set(orders(42)).size).toBe(2);
    expect(orders(42)).not.toEqual(orders(43));
    expect(swapped({ A: 'swarm', B: 'baseline' })).toEqual({ A: 'baseline', B: 'swarm' });
  });

  it('unblinds scores and the preference back to arms', () => {
    const judgement: Judgement = {
      A: {
        alpha: { score: 3, reason: 'a' },
        beta: { score: 1, reason: 'b' },
        gamma: { score: 2, reason: 'c' },
      },
      B: {
        alpha: { score: 1, reason: 'd' },
        beta: { score: 1, reason: 'e' },
        gamma: { score: 0, reason: 'f' },
      },
      overall: 'A',
      note: 'A is better.',
    };
    const asBaseline = unblind(judgement, { A: 'baseline', B: 'swarm' });
    expect(asBaseline.baseline.alpha?.score).toBe(3);
    expect(asBaseline.swarm.alpha?.score).toBe(1);
    expect(asBaseline.preferred).toBe('baseline');
    const asSwarm = unblind(judgement, { A: 'swarm', B: 'baseline' });
    expect(asSwarm.preferred).toBe('swarm');
    expect(unblind({ ...judgement, overall: 'tie' }, asSwarm.order).preferred).toBe('tie');
  });
});

describe('judgePrompt', () => {
  it('shows the problem, every criterion with its scale, and the two answers in the given slots', () => {
    const prompt = judgePrompt(problem, { A: 'first answer', B: 'second answer' });
    expect(prompt).toContain('Do the thing.');
    expect(prompt).toContain('## Constraints\n- c1');
    expect(prompt).toContain('- alpha: Alpha\n  Scale: 0 = no; 3 = yes');
    expect(prompt.indexOf('# Answer A\n\nfirst answer')).toBeLessThan(
      prompt.indexOf('# Answer B\n\nsecond answer'),
    );
    expect(prompt).not.toContain('swarm');
    expect(prompt).not.toContain('weight');
  });
});

describe('blindText', () => {
  it('removes board handles and the parentheses that held only handles, and tidies the gaps', () => {
    expect(
      blindText(
        'Adopt a canary (H16). Evidence E24 and E28 confirm it, per E29; see also (S2, E4 and C3). The decision (D1) stands.',
      ),
    ).toBe('Adopt a canary. Evidence and confirm it, per; see also. The decision stands.');
    expect(
      blindText('Flags are not kill switches, as noted in E19 and H19, so plan for review.'),
    ).toBe('Flags are not kill switches, as noted in and, so plan for review.');
  });

  it('leaves ordinary text, other letter-digit tokens and paragraph breaks alone', () => {
    const text =
      'Use A4 paper for the E2E report in H1 of the year.\n\nSecond paragraph with 2026 and v3.';
    expect(blindText(text)).toBe(
      'Use paper for the E2E report in of the year.\n\nSecond paragraph with 2026 and v3.',
    );
    expect(blindText('No handles here.\n\nStill none.')).toBe('No handles here.\n\nStill none.');
  });
});

describe('reason before score', () => {
  it('puts each criterion’s reason before its score in the schema the judge answers against', () => {
    const json = z.toJSONSchema(judgementSchema(problem)) as unknown as {
      properties: { A: { properties: Record<string, { properties: Record<string, unknown> }> } };
    };
    for (const criterion of Object.values(json.properties.A.properties)) {
      expect(Object.keys(criterion.properties)).toEqual(['reason', 'score']);
    }
  });
});
