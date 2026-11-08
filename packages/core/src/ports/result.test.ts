import { describe, expect, it } from 'vitest';

import { err, ok, type Result } from './result';

const divide = (a: number, b: number): Result<number, 'division_by_zero'> =>
  b === 0 ? err('division_by_zero') : ok(a / b);

describe('Result', () => {
  it('narrows on ok', () => {
    const r = divide(6, 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2);
  });

  it('narrows on err', () => {
    const r = divide(1, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('division_by_zero');
  });
});
