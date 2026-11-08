import { IdSchema } from '@team/core';
import { ManualClock, TEST_EPOCH_MS } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { createConsoleLogger } from './console-logger';
import { systemClock } from './system-clock';
import { createUuidV7Generator } from './uuid-v7';

describe('systemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    const now = systemClock.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('createUuidV7Generator', () => {
  it('produces valid, distinct, time-ordered v7 ids', () => {
    const clock = new ManualClock();
    const ids = createUuidV7Generator(clock);
    const first = ids.next();
    clock.advance(1);
    const second = ids.next();
    expect(IdSchema.safeParse(first).success).toBe(true);
    expect(IdSchema.safeParse(second).success).toBe(true);
    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });

  it('encodes the clock in the first 48 bits and keeps version/variant bits', () => {
    const clock = new ManualClock(TEST_EPOCH_MS);
    const ids = createUuidV7Generator(clock, (bytes) => bytes.fill(0xff));
    const id = ids.next();
    const timestampHex = id.replace(/-/g, '').slice(0, 12);
    expect(parseInt(timestampHex, 16)).toBe(TEST_EPOCH_MS);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7fff-bfff-ffffffffffff$/);
  });
});

describe('createConsoleLogger', () => {
  it('filters below the minimum level and appends fields as JSON', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger((line) => lines.push(line), 'info');
    logger.debug('hidden');
    logger.info('started', { runId: 'r1' });
    logger.warn('careful');
    logger.error('broken', {});
    expect(lines).toEqual(['[info] started {"runId":"r1"}', '[warn] careful', '[error] broken']);
  });

  it('defaults to warnings and above', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger((line) => lines.push(line));
    logger.info('quiet');
    logger.warn('loud');
    expect(lines).toEqual(['[warn] loud']);
  });
});
