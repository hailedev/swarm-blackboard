import type { Clock } from '@team/core';

// The only place in Phase 1 that reads the wall clock.
export const systemClock: Clock = { nowMs: () => Date.now() };
