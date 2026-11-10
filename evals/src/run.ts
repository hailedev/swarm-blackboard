import { createInterface } from 'node:readline/promises';

import { main, type EvalIo } from './cli';

// pnpm eval — see cli.ts. Loads .env like the other entry points, asks for confirmation
// on a terminal, and requires --yes elsewhere.

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: rely on the environment
}

const io: EvalIo = {
  write: (line) => {
    console.log(line);
  },
};
if (process.stdin.isTTY) {
  io.confirm = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  };
}

process.exitCode = await main(process.argv.slice(2), io, process.env);
