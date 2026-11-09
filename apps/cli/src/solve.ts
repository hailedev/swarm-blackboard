// Entry point for `pnpm solve "<problem>" --fake [--profile <name>]` (run with tsx).
import { createInterface } from 'node:readline/promises';

import { main } from './run-solve';

// MONTHLY_BUDGET_USD, BUDGET_TIMEZONE and the provider keys come from .env when present.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: the process environment alone applies.
}

const confirm = process.stdin.isTTY
  ? async (question: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    }
  : undefined;

process.exitCode = await main(
  process.argv.slice(2),
  {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    confirm,
  },
  process.env,
);
