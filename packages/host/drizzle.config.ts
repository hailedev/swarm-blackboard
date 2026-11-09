import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` turns src/db/schema.ts into SQL migrations under ./drizzle, which
// openDatabase() applies at start-up. The schema stays Postgres-portable (ADR-0007):
// text ids, ISO-8601 text timestamps, JSON as text, no SQLite-only types.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
