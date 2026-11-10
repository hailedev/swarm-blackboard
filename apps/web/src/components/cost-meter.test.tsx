import { describe, expect, it } from 'vitest';

import { usd } from '../lib/format';
import { elements, render, text } from '../testing/markup';
import { BudgetStrip, CostMeter, Meter } from './cost-meter';

const month = { spentUsd: 1, limitUsd: 5, warnAtFraction: 0.8 };
const levels = (html: string): Record<string, string | undefined> =>
  Object.fromEntries(
    ['run-cost', 'month-cost', 'rounds', 'tokens', 'time'].flatMap((id) => {
      const meter = elements(html, `meter-${id}`)[0];
      return meter === undefined ? [] : [[id, meter['data-level']]];
    }),
  );

describe('Meter', () => {
  it('is blue below the warning fraction, amber from it and red at the limit', () => {
    const at = (value: number) => {
      const html = render(
        <Meter id="m" label="This run" value={value} limit={0.25} format={usd} />,
      );
      return { html, meter: elements(html, 'meter-m')[0] };
    };
    expect(at(0.1975).meter?.['data-level']).toBe('ok');
    expect(at(0.2).meter?.['data-level']).toBe('warning');
    expect(at(0.2499).meter?.['data-level']).toBe('warning');
    expect(at(0.25).meter?.['data-level']).toBe('over');
    expect(at(0.3).meter?.['data-level']).toBe('over');

    // The colour is on the bar; the same state is in words and in the accessible value.
    expect(at(0.1).html).toContain('bg-accent');
    expect(at(0.2).html).toContain('bg-warning');
    expect(at(0.25).html).toContain('bg-critical');
    expect(text(at(0.2).html)).toBe('This run $0.2000 of $0.2500 ▲ 80% — close to the limit');
    expect(text(at(0.25).html)).toContain('100% — limit reached');
    expect(at(0.2).html).toContain(
      'aria-valuetext="This run: $0.2000 of $0.2500, 80%, close to the limit"',
    );
    expect(at(0.2).html).toContain('role="meter"');
  });

  it('never draws the bar past its track, and shows a sliver for anything spent', () => {
    const over = render(<Meter id="m" label="x" value={9} limit={3} format={String} />);
    expect(over).toContain('width:100%');
    expect(text(over)).toContain('300% — limit reached');
    const sliver = render(<Meter id="m" label="x" value={0.0001} limit={3} format={String} />);
    expect(sliver).toContain('min-w-1');
    expect(render(<Meter id="m" label="x" value={0} limit={3} format={String} />)).not.toContain(
      'min-w-1',
    );
  });
});

describe('CostMeter', () => {
  it('shows two gauges: this run against its cap and this month against its limit', () => {
    const html = render(<CostMeter run={{ spentUsd: 0.0238, capUsd: 0.25 }} month={month} />);
    expect(levels(html)).toEqual({ 'run-cost': 'ok', 'month-cost': 'ok' });
    expect(text(html)).toContain('This run $0.0238 of $0.2500');
    expect(text(html)).toContain('This month (API) $1.00 of $5.00');
  });

  it('turns each gauge on its own, the month at the fraction the server gives', () => {
    const html = render(
      <CostMeter
        run={{ spentUsd: 0.25, capUsd: 0.25 }}
        month={{ spentUsd: 4, limitUsd: 5, warnAtFraction: 0.8 }}
      />,
    );
    expect(levels(html)).toEqual({ 'run-cost': 'over', 'month-cost': 'warning' });
    const early = render(
      <CostMeter
        run={{ spentUsd: 0, capUsd: 0.25 }}
        month={{ spentUsd: 2.5, limitUsd: 5, warnAtFraction: 0.5 }}
      />,
    );
    expect(levels(early)).toEqual({ 'run-cost': 'ok', 'month-cost': 'warning' });
    expect(
      levels(
        render(<CostMeter run={{ spentUsd: 0, capUsd: 0.25 }} month={{ ...month, spentUsd: 5 }} />),
      )['month-cost'],
    ).toBe('over');
  });

  it('says so while the month has not been read, instead of showing a zero', () => {
    const html = render(<CostMeter run={{ spentUsd: 0, capUsd: 0.25 }} month={undefined} />);
    expect(levels(html)).toEqual({ 'run-cost': 'ok' });
    expect(text(html)).toContain('Reading this month’s spend…');
  });
});

describe('BudgetStrip', () => {
  it('sets every hard limit beside what the run has used', () => {
    const html = render(
      <BudgetStrip
        run={{ spentUsd: 0.0238, capUsd: 0.25 }}
        month={month}
        rounds={{ done: 12, max: 12 }}
        tokens={{ used: 222_125, max: 400_000, reasoning: 1_500 }}
        time={{ elapsedMs: 467_993, maxMs: 900_000 }}
      />,
    );
    expect(levels(html)).toEqual({
      'run-cost': 'ok',
      'month-cost': 'ok',
      rounds: 'over',
      tokens: 'ok',
      time: 'ok',
    });
    expect(text(html)).toContain('Rounds 12 of 12');
    expect(text(html)).toContain('Tokens 222K of 400K');
    expect(text(html)).toContain('Time 7m 47s of 15m 00s');
  });
});
