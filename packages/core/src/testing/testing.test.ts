import { describe, expect, it } from 'vitest';

import { IdSchema } from '../schemas/common';
import { ManualClock, TEST_EPOCH_MS } from './manual-clock';
import { SequentialIdGenerator, sequentialId } from './sequential-id-generator';

describe('SequentialIdGenerator', () => {
  it('issues valid, increasing UUID v7-shaped ids', () => {
    const ids = new SequentialIdGenerator();
    const first = ids.next();
    const second = ids.next();
    expect(first).toBe(sequentialId(1));
    expect(second).toBe(sequentialId(2));
    expect(IdSchema.safeParse(first).success).toBe(true);
    expect(first < second).toBe(true);
    expect(ids.issued).toBe(2);
  });
});

describe('ManualClock', () => {
  it('starts at the test epoch and advances only when told', () => {
    const clock = new ManualClock();
    expect(clock.nowMs()).toBe(TEST_EPOCH_MS);
    clock.advance(1_500);
    expect(clock.nowMs()).toBe(TEST_EPOCH_MS + 1_500);
  });
});
