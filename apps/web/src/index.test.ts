import { describe, expect, it } from 'vitest';

import { packageName } from './index';

describe('@team/web', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@team/web');
  });
});
