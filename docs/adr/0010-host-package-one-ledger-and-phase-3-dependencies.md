# ADR-0010: Share the Node adapters and the SQLite store in `packages/host`; one spend ledger per machine

- **Status:** accepted
- **Date:** 2026-11-09

## Context

Phase 3 adds the server: a Drizzle/SQLite store (ADR-0007), a Hono API, SSE and a run manager. Three things it needs already exist in `apps/cli`: the roster and prompt loaders, the environment parsing, and the edge adapters for the clock, ids and logging. The CLI's spend ledger is a JSONL file; the server's would be a `SUM` over `model_calls`. That leaves one machine with two month-to-date figures, which defeats the point of a monthly budget (docs/budget-guardrails.md §3). The contract tests in `packages/providers` bill Haiku on every `pnpm test:llm` and write nothing to any ledger, and a package cannot import from `apps/`.

## Decision

- A new package, **`packages/host`** (`@team/host`), holds everything a Node host needs that is neither domain (core) nor model access (providers): the roster and prompt loaders, environment parsing, the system clock, UUID v7 ids, the console logger, and the **Drizzle/SQLite store** behind core's `BoardStore`, `SpendLedger` and `TraceSink` ports, with the `runs`, `entries`, `events`, `model_calls` and `agent_configs` tables, migrations, and the calibration-sample query the token estimate uses.
- **`host` depends on `core` only.** The trace shape it stores is core's `ModelCallTraceSchema`. `providers` never imports `host`; its contract tests dev-depend on it, which is why the dependency may not run the other way.
- **One ledger.** The CLI, the server and `pnpm test:llm` all write the database named by `DATABASE_URL` (default `file:./data/team.db`). The month-to-date figure is `SUM(cost_usd)` over `model_calls WHERE billing = 'api'`. The JSONL ledger is retired after a one-shot import (`pnpm ledger:import`).
- Dependencies added (all pinned): `hono` 4.13.17 and `drizzle-orm` 0.45.4 (both named in docs/PLAN.md §4), `better-sqlite3` 13.0.3 (ADR-0007; its install script is allowed in `pnpm-workspace.yaml`), `@hono/node-server` 2.1.6 (Hono has no Node listener of its own), `drizzle-kit` 0.31.11 (dev; generates the SQL migrations from the schema so the DDL is written once), `@types/better-sqlite3` 9.6.0 (dev). Approved by Hai on 2026-11-09.

## Consequences

- `+` The CLI and the server cannot drift apart on how a roster is read, an id is minted or a trace is stored; a run started from either shows up in the same database and the same ledger.
- `+` The monthly guard sees every paid call made on the machine, test runs included.
- `+` Resuming a paused run after a server restart has somewhere to read the event log from.
- `−` `pnpm solve --fake` now opens a database it does not strictly need; `--db :memory:` is the escape hatch, and the tests use it.
- `−` `better-sqlite3` is a native module. It ships prebuilt binaries for the platforms we use; if one is missing it needs a C++ toolchain to build.
- `−` A fourth package to keep in the layout docs and the CI matrix.

## Alternatives considered

- **SQLite only in `apps/server`, JSONL ledger kept in the CLI and moved into `providers` for the tests** — rejected: two ledgers on one machine, and `providers` would gain file I/O that has nothing to do with model access.
- **`apps/server` importing from `apps/cli`** — rejected: an app depending on an app; the shared code is a library and should be packaged as one.
- **Two packages, `store` and `adapters`** — rejected for now: both are "what a Node host needs", neither is reusable without the other, and one package is less ceremony. Split later if a non-SQLite host appears.
- **`pino` for the server's logging** — deferred: the CLI's console logger is thirty lines and already never logs prompt contents; add pino when structured log shipping is wanted.
