import { BoardEventSchema, type BoardEvent } from '@team/core';
import { z } from 'zod';

import raw from '../../../../fixtures/runs/2026-11-09-cheap-release-process/events.json';

// The recorded run in fixtures/runs/ is the fixture for replay and UI tests (CLAUDE.md,
// testing rules): `cheap` profile, twelve rounds, 96 entries, ended on the round limit.

const parsed = z.array(BoardEventSchema).parse(raw);

export const recordedEvents = (): readonly BoardEvent[] => parsed;

export const recordedRunId = (): string => {
  const first = parsed[0];
  if (first === undefined) throw new Error('the recorded run is empty');
  return first.runId;
};
