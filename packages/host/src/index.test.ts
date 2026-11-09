import { describe, expect, it } from 'vitest';

import { packageName } from './index';

describe('@team/host', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@team/host');
  });
});
