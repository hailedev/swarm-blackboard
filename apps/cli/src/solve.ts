// Entry point for `pnpm solve "<problem>" --fake` (run with tsx).
import { main } from './run-solve';

process.exitCode = await main(process.argv.slice(2), {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
