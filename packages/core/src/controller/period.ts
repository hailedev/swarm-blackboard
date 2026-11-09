import { isoFromMs } from '../ports/clock';
import { err, ok, type Result } from '../ports/result';
import type { Period } from '../ports/spend-ledger';

export type PeriodError = { kind: 'invalid_time_zone'; timeZone: string };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterFor = (timeZone: string): Intl.DateTimeFormat | null => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
};

const zonedParts = (formatter: Intl.DateTimeFormat, ms: number): ZonedParts => {
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
};

// The instant at which `year-month-01 00:00:00` happens in the formatter's zone.
// Start from the UTC midnight and correct by the observed offset; a second pass
// settles DST edges, a third is a safety net.
const zonedMonthStartMs = (formatter: Intl.DateTimeFormat, year: number, month: number): number => {
  const target = Date.UTC(year, month - 1, 1);
  let guess = target;
  for (let pass = 0; pass < 3; pass += 1) {
    const p = zonedParts(formatter, guess);
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (observed === target) break;
    guess -= observed - target;
  }
  return guess;
};

/** The calendar month containing `nowMs` in `timeZone`, as a half-open ISO period. */
export const calendarMonth = (nowMs: number, timeZone: string): Result<Period, PeriodError> => {
  const formatter = formatterFor(timeZone);
  if (formatter === null) return err({ kind: 'invalid_time_zone', timeZone });
  const { year, month } = zonedParts(formatter, nowMs);
  return ok({
    start: isoFromMs(zonedMonthStartMs(formatter, year, month)),
    end: isoFromMs(zonedMonthStartMs(formatter, year, month + 1)),
  });
};
