// A value against a limit (docs/budget-guardrails.md §5): amber from the warning fraction,
// red at the limit.

export type GaugeLevel = 'ok' | 'warning' | 'over';

/** The fraction at which a gauge turns amber when the server does not say otherwise. */
export const DEFAULT_WARN_AT = 0.8;

/** `value / limit`; a zero limit is full as soon as anything is spent against it. */
export const fractionOf = (value: number, limit: number): number => {
  if (limit > 0) return value / limit;
  return value > 0 ? 1 : 0;
};

export const gaugeLevel = (fraction: number, warnAt: number = DEFAULT_WARN_AT): GaugeLevel => {
  if (fraction >= 1) return 'over';
  return fraction >= warnAt ? 'warning' : 'ok';
};

/** What the level means in words, so the colour never carries it alone. */
export const GAUGE_LEVEL_LABEL: Record<GaugeLevel, string> = {
  ok: 'within limit',
  warning: 'close to the limit',
  over: 'limit reached',
};
