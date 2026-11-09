import { useSyncExternalStore } from 'react';

// The current time, to the second, for a clock that ticks while a run is running. Read
// through an external store so render stays pure: the time is a snapshot, not a call.

const TICK_MS = 1_000;

const tick = (onChange: () => void): (() => void) => {
  const id = setInterval(onChange, TICK_MS);
  return () => {
    clearInterval(id);
  };
};

const still = (): (() => void) => () => undefined;

const nowToTheSecond = (): number => Math.floor(Date.now() / TICK_MS) * TICK_MS;

/** Milliseconds since the epoch, refreshed every second while `ticking` is true. */
export const useNow = (ticking: boolean): number =>
  useSyncExternalStore(ticking ? tick : still, nowToTheSecond, nowToTheSecond);
