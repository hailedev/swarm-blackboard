import { compact, duration, percent, usd } from '../lib/format';
import { fractionOf, GAUGE_LEVEL_LABEL, gaugeLevel, type GaugeLevel } from '../lib/gauge';
import { cx } from './ui';

// A value against a limit is a meter (not a chart): the fill carries the state, the track
// is a lighter step of the same colour so the state reads across the whole bar, and the
// figures and the level are printed beside it so the colour never carries them alone.
// Amber from the warning fraction, red at the limit (docs/budget-guardrails.md §5).

const FILL: Record<GaugeLevel, string> = {
  ok: 'bg-accent',
  warning: 'bg-warning',
  over: 'bg-critical',
};

const TRACK: Record<GaugeLevel, string> = {
  ok: 'bg-accent/20',
  warning: 'bg-warning/30',
  over: 'bg-critical/25',
};

const LEVEL_ICON: Record<GaugeLevel, string> = { ok: '●', warning: '▲', over: '■' };

const ICON_TONE: Record<GaugeLevel, string> = {
  ok: 'text-accent',
  warning: 'text-warning',
  over: 'text-critical',
};

export interface MeterProps {
  /** Names the gauge in tests and to assistive technology. */
  id: string;
  label: string;
  value: number;
  limit: number;
  format: (amount: number) => string;
  /** The fraction at which the meter turns amber; 0.8 unless the server says otherwise. */
  warnAt?: number;
}

export const Meter = ({ id, label, value, limit, format, warnAt }: MeterProps) => {
  const fraction = fractionOf(value, limit);
  const level = gaugeLevel(fraction, warnAt);
  const reading = `${format(value)} of ${format(limit)}`;
  const summary = `${label}: ${reading}, ${percent(fraction)}, ${GAUGE_LEVEL_LABEL[level]}`;
  return (
    <div data-testid={`meter-${id}`} data-level={level} title={summary} className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="tabular-nums">
          <span className="font-medium">{format(value)}</span>
          <span className="text-ink-2"> of {format(limit)}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        aria-valuetext={summary}
        className={cx('mt-1 h-2 overflow-hidden rounded-full', TRACK[level])}
      >
        <div
          className={cx('h-2 rounded-full', FILL[level], value > 0 && 'min-w-1')}
          style={{ width: `${String(Math.min(100, Math.max(0, fraction * 100)))}%` }}
        />
      </div>
      <div className="mt-1 flex items-center gap-1 text-xs text-ink-2">
        <span aria-hidden="true" className={cx('text-[0.6rem]', ICON_TONE[level])}>
          {LEVEL_ICON[level]}
        </span>
        <span>
          {percent(fraction)} — {GAUGE_LEVEL_LABEL[level]}
        </span>
      </div>
    </div>
  );
};

export interface CostMeterProps {
  run: { spentUsd: number; capUsd: number };
  /** Undefined while the month's figure has not been read. */
  month: { spentUsd: number; limitUsd: number; warnAtFraction: number } | undefined;
}

/** The two gauges: this run against its cap, and this month against its limit. */
export const CostMeter = ({ run, month }: CostMeterProps) => (
  <div data-testid="cost-meter" className="grid grid-cols-2 gap-4">
    <Meter id="run-cost" label="This run" value={run.spentUsd} limit={run.capUsd} format={usd} />
    {month === undefined ? (
      <p className="self-center text-xs text-ink-2">Reading this month’s spend…</p>
    ) : (
      <Meter
        id="month-cost"
        label="This month (API)"
        value={month.spentUsd}
        limit={month.limitUsd}
        warnAt={month.warnAtFraction}
        format={(amount) => usd(amount, 2)}
      />
    )}
  </div>
);

export interface BudgetStripProps extends CostMeterProps {
  rounds: { done: number; max: number };
  tokens: { used: number; max: number };
  time: { elapsedMs: number; maxMs: number };
}

/** Every hard limit the controller enforces, against what the run has used so far. */
export const BudgetStrip = ({ run, month, rounds, tokens, time }: BudgetStripProps) => (
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr]">
    <CostMeter run={run} month={month} />
    <div className="grid grid-cols-3 gap-4">
      <Meter id="rounds" label="Rounds" value={rounds.done} limit={rounds.max} format={String} />
      <Meter id="tokens" label="Tokens" value={tokens.used} limit={tokens.max} format={compact} />
      <Meter id="time" label="Time" value={time.elapsedMs} limit={time.maxMs} format={duration} />
    </div>
  </div>
);
