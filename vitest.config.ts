import { defineConfig } from 'vitest/config';

// One Vitest project per workspace package.
// `pnpm test` runs unit tests only and never touches the network.
// `pnpm test:llm` (`--mode llm`) runs only `*.llm.test.ts`, which call real models.
const workspaces = [
  { name: 'core', root: 'packages/core' },
  { name: 'providers', root: 'packages/providers' },
  { name: 'cli', root: 'apps/cli' },
  { name: 'server', root: 'apps/server' },
  { name: 'web', root: 'apps/web' },
  { name: 'evals', root: 'evals' },
];

export default defineConfig(({ mode }) => {
  const llm = mode === 'llm';
  return {
    test: {
      passWithNoTests: llm,
      projects: workspaces.map(({ name, root }) => ({
        test: {
          name,
          root,
          include: llm ? ['**/*.llm.test.ts'] : ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...(llm ? [] : ['**/*.llm.test.ts'])],
        },
      })),
      coverage: {
        provider: 'v8',
        include: ['packages/*/src/**', 'apps/*/src/**', 'evals/src/**'],
        exclude: ['**/*.test.ts'],
        reporter: ['text', 'html', 'lcov'],
        // CLAUDE.md: core coverage target is 90 %. A phase is not done while this is red.
        thresholds: {
          'packages/core/src/**': { lines: 90, statements: 90, functions: 90, branches: 90 },
        },
      },
    },
  };
});
