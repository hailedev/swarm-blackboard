import { describe, expect, it } from 'vitest';

import { calendarMonth } from './period';

const utc = (iso: string): number => Date.parse(iso);

describe('calendarMonth', () => {
  it('bounds the month in UTC', () => {
    expect(calendarMonth(utc('2026-01-15T12:00:00Z'), 'UTC')).toEqual({
      ok: true,
      value: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
    });
  });

  it('rolls December into the next year', () => {
    expect(calendarMonth(utc('2026-12-31T23:59:59Z'), 'UTC')).toEqual({
      ok: true,
      value: { start: '2026-12-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
    });
  });

  it('uses local midnight in the given zone', () => {
    // Sydney is UTC+11 in January (daylight time).
    expect(calendarMonth(utc('2026-01-15T00:00:00Z'), 'Australia/Sydney')).toEqual({
      ok: true,
      value: { start: '2025-12-31T13:00:00.000Z', end: '2026-01-31T13:00:00.000Z' },
    });
    // 13:30Z on 31 January is already 1 February in Sydney.
    expect(calendarMonth(utc('2026-01-31T13:30:00Z'), 'Australia/Sydney')).toEqual({
      ok: true,
      value: { start: '2026-01-31T13:00:00.000Z', end: '2026-02-28T13:00:00.000Z' },
    });
  });

  it('handles a daylight-saving change inside the month', () => {
    // Sydney leaves daylight time on 5 April 2026: April starts at UTC+11, May at UTC+10.
    expect(calendarMonth(utc('2026-04-10T00:00:00Z'), 'Australia/Sydney')).toEqual({
      ok: true,
      value: { start: '2026-03-31T13:00:00.000Z', end: '2026-04-30T14:00:00.000Z' },
    });
  });

  it('rejects an unknown time zone instead of guessing', () => {
    expect(calendarMonth(utc('2026-01-15T00:00:00Z'), 'Mars/Olympus_Mons')).toEqual({
      ok: false,
      error: { kind: 'invalid_time_zone', timeZone: 'Mars/Olympus_Mons' },
    });
  });
});
