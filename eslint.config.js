import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Node built-ins that packages/core must never import.
// CLAUDE.md, architecture rule 1: core has no I/O — everything arrives through interfaces.
const nodeBuiltins = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.vitest/',
    '**/test-results/',
    '**/playwright-report/',
    'data/',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md conventions: no `any`, no non-null assertions.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', ...nodeBuiltins.flatMap((name) => [name, `${name}/*`])],
              message:
                'packages/core has no I/O (CLAUDE.md architecture rule 1). Inject it through an interface instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // The web app: the rules of hooks, and nothing in the bundle that needs Node. The
    // server's API contract (`@team/server/api`) and core are the only workspace imports
    // a browser can load (ADR-0011).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@team/server',
              message: 'Importing the server entry point starts a server. Use @team/server/api.',
            },
            { name: '@team/host', message: '@team/host needs Node; the browser cannot load it.' },
            {
              name: '@team/providers',
              message: 'Model calls go through the server, never from the browser.',
            },
          ],
          patterns: [
            {
              group: ['node:*', ...nodeBuiltins.flatMap((name) => [name, `${name}/*`])],
              message: 'apps/web/src runs in the browser: no Node built-ins.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
