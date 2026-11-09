import type { RunProfile } from '@team/core';
import type { BudgetResponse } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { checkStartRun, type StartRunDraft } from '../lib/start-run';
import { elements, hasFlag, render, text } from '../testing/markup';
import { StartRunForm } from './start-run-form';

const local = { alias: 'local-fast', provider: 'ollama', model: 'qwen3.6:35b-mlx' } as const;
const worker = { alias: 'local', provider: 'ollama', model: 'qwen3.6:35b-a3b-q8_0' } as const;
const haiku = { alias: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' } as const;

const dev: RunProfile = {
  name: 'dev',
  roles: { planner: local, researcher: local, solver: local, critic: local, synthesizer: local },
  bidder: local,
  fallback: null,
  paid: false,
};

const cheap: RunProfile = {
  name: 'cheap',
  roles: { planner: haiku, researcher: worker, solver: worker, critic: haiku, synthesizer: haiku },
  bidder: haiku,
  fallback: haiku,
  paid: true,
};

const budget = (spentUsd: number): BudgetResponse => ({
  period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
  spentUsd,
  limitUsd: 5,
  warnAtFraction: 0.8,
  timeZone: 'UTC',
});

const form = (
  overrides: Partial<StartRunDraft>,
  options: { month?: BudgetResponse; starting?: boolean; serverError?: string } = {},
): string => {
  const draft: StartRunDraft = {
    problem: 'Should we adopt a monorepo?',
    constraints: '',
    successCriteria: '',
    profile: 'dev',
    maxCostUsd: '0.25',
    maxRounds: '12',
    confirmed: false,
    ...overrides,
  };
  const profiles = [dev, cheap];
  const month = 'month' in options ? options.month : budget(1.5);
  return render(
    <StartRunForm
      draft={draft}
      profiles={profiles}
      budget={month}
      check={checkStartRun(
        draft,
        profiles.find((p) => p.name === draft.profile),
        month,
      )}
      starting={options.starting ?? false}
      serverError={options.serverError ?? null}
      onChange={() => undefined}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
  );
};

/** Whether the form's submit button is disabled. */
const startDisabled = (html: string): boolean => {
  const button = /<button type="submit"[^>]*>/.exec(html)?.[0];
  if (button === undefined) throw new Error('the form has no submit button');
  return hasFlag(button, 'disabled');
};

describe('StartRunForm', () => {
  it('shows a free profile with its models, the month, and nothing to confirm', () => {
    const html = form({});
    expect(elements(html, 'start-run-form')[0]?.['data-paid']).toBe('false');
    const seen = text(html);
    expect(seen).toContain('Models for “dev”');
    expect(seen).toContain('planner local-fast ollama/qwen3.6:35b-mlx free');
    expect(seen).toContain('Fallback none: an answer that fails its schema is repaired once');
    expect(seen).toContain('This month (API) $1.50 of $5.00');
    expect(seen).toContain('This profile spends nothing: every role runs on a local model.');
    expect(seen).not.toContain('I understand');
    expect(html).not.toContain('name="confirmed"');
    expect(startDisabled(html)).toBe(false);
    // Both profiles are on offer, each saying whether it can cost money.
    expect(seen).toContain('dev free: local models only');
    expect(seen).toContain('cheap $ paid: calls the Anthropic API');
  });

  it('shows a paid profile with what the CLI banner shows, and holds the run until confirmed', () => {
    const html = form({ profile: 'cheap' });
    expect(elements(html, 'start-run-form')[0]?.['data-paid']).toBe('true');
    const seen = text(html);
    expect(seen).toContain('Models for “cheap”');
    expect(seen).toContain('planner haiku anthropic/claude-haiku-5-5 $ paid');
    expect(seen).toContain('researcher local ollama/qwen3.6:35b-a3b-q8_0 free');
    expect(seen).toContain('fallback haiku anthropic/claude-haiku-5-5 $ paid');
    expect(seen).toContain('This month (API) $1.50 of $5.00');
    expect(seen).toContain('30% of the month is used');
    expect(seen).toContain(
      'I understand this run calls paid models and may spend up to $0.25 of the API budget.',
    );
    expect(startDisabled(html)).toBe(true);
    expect(startDisabled(form({ profile: 'cheap', confirmed: true }))).toBe(false);
  });

  it('refuses a paid run the month cannot absorb, with the cap that would fit', () => {
    const html = form({ profile: 'cheap', confirmed: true }, { month: budget(4.9) });
    expect(text(html)).toContain(
      'This cap does not fit the month: $4.90 of $5.00 is spent, so a per-run cap of $0.1000 or less would fit.',
    );
    expect(elements(html, 'meter-dialog-month')[0]?.['data-level']).toBe('warning');
    expect(startDisabled(html)).toBe(true);
    // The same month does not hold a free run back.
    expect(startDisabled(form({}, { month: budget(4.9) }))).toBe(false);
  });

  it('will not start a paid run before the month has been read', () => {
    const html = form({ profile: 'cheap', confirmed: true }, { month: undefined });
    expect(text(html)).toContain('Reading this month’s spend…');
    expect(text(html)).toContain('a paid run cannot be checked against the monthly limit');
    expect(startDisabled(html)).toBe(true);
  });

  it('names a bad cap or round limit, shows the server’s refusal, and waits while starting', () => {
    expect(text(form({ maxCostUsd: 'lots' }))).toContain(
      'The per-run cap must be a number of dollars, zero or more.',
    );
    expect(text(form({ maxRounds: '0' }))).toContain(
      'The round limit must be a whole number, one or more.',
    );
    expect(startDisabled(form({ problem: '' }))).toBe(true);
    const refused = form({}, { serverError: 'Ollama is unreachable at http://localhost:11434' });
    expect(text(refused)).toContain('Ollama is unreachable at http://localhost:11434');
    const starting = form({}, { starting: true });
    expect(startDisabled(starting)).toBe(true);
    expect(text(starting)).toContain('checks Ollama and warms its model first');
  });
});
