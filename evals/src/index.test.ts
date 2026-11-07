import { describe, expect, it } from 'vitest';

import { packageName } from './index';

describe('@team/evals', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@team/evals');
  });
});
