# ADR-0007: Use SQLite, local-first, with a Postgres-portable schema

- **Status:** accepted
- **Date:** 2026-11-07

## Context

v1 is a single-user app running on the owner's machine. It needs durable storage for runs, the event log, materialised entries and every model-call trace, with fast reads for the replay scrubber and trace viewer. A hosted, multi-user mode is a possible later phase, not a v1 requirement.

## Decision

Use **SQLite** via **Drizzle ORM** with the `better-sqlite3` driver. The controller and the database live in the same process.

Write the schema to be Postgres-portable from day one: UUID v7 ids as text, ISO-8601 timestamps as text, JSON payloads as text columns, no SQLite-specific types or pragmas in the schema, and all queries through Drizzle rather than raw SQL.

## Consequences

- `+` Zero operational overhead; the database is a file next to the app.
- `+` Synchronous, fast reads suit the replay and trace views.
- `+` Tests run against an in-memory database with no setup.
- `−` Single writer. Fine while the controller is in-process; a hosted mode would move the controller behind a queue anyway.
- `−` A later move to Postgres is a Drizzle driver swap plus a migration review — not free, but not a rewrite, provided the portability rules above are kept.

## Alternatives considered

- **Postgres now** — rejected: a running service to manage for no v1 benefit.
- **JSON files per run** — rejected: no queries for the trace viewer, no joins for replay, and concurrent writes during a run get messy.
- **An embedded document store** — rejected: adds a dependency with a smaller ecosystem than SQLite and no clearer path to hosting.
