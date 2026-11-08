import { describe, expect, it } from 'vitest';

import { isoFromMs } from './clock';
import { nullLogger } from './logger';

describe('ports', () => {
  it('formats epoch milliseconds as ISO-8601 UTC', () => {
    expect(isoFromMs(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoFromMs(1_767_225_600_000)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('nullLogger swallows every level', () => {
    expect(() => {
      nullLogger.debug('d', { a: 1 });
      nullLogger.info('i');
      nullLogger.warn('w');
      nullLogger.error('e');
    }).not.toThrow();
  });
});
