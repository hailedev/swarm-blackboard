// Core never reads the wall clock. Time arrives through this interface.
export interface Clock {
  nowMs(): number;
}

// Dates are ISO-8601 strings at boundaries; `Date` is used only transiently.
export const isoFromMs = (ms: number): string => new Date(ms).toISOString();
