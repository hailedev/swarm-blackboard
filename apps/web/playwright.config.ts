import { defineConfig, devices } from '@playwright/test';

// The smoke test (docs/PLAN.md §6, Phase 4) runs the real stack with nothing real behind
// it: the API server in `--fake` mode (scripted models, in-memory database, ADR-0011) and
// the Vite dev server proxying to it, both on ports of their own so a `pnpm dev` that is
// already running is left alone. `pnpm test:e2e` from the repository root.

const API_PORT = 3101;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // One run at a time: the tests share one fake server and its run list.
  workers: 1,
  fullyParallel: false,
  // A `test.only` left in by mistake fails the run instead of quietly skipping the rest.
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
  ],
  webServer: [
    {
      // Each scripted call takes this long, so a round lasts long enough to be paused.
      command: 'pnpm exec tsx apps/server/src/index.ts --fake',
      cwd: '../..',
      env: { PORT: String(API_PORT), FAKE_DELAY_MS: '1500' },
      url: `http://localhost:${String(API_PORT)}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${String(WEB_PORT)} --strictPort`,
      env: { TEAM_API_URL: `http://localhost:${String(API_PORT)}` },
      url: `http://localhost:${String(WEB_PORT)}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
