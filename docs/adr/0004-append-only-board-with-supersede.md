# ADR-0004: Make the board append-only with supersede links

- **Status:** accepted
- **Date:** 2026-11-07

## Context

A run of the swarm must be observable live, replayable afterwards, and debuggable when it goes wrong. A board that is edited in place loses the history that makes any of that possible.

## Decision

Board entries are **immutable**. A refinement, correction or status change is a **new entry** whose `supersedes` field points at the entry it replaces. The current board view is derived: an entry is *live* if no live entry supersedes it.

The persisted source of truth is the **event log** (`events` table: entry committed, run paused, human note injected, …). Board state at any round is a fold over the events up to that round. The `entries` table is a materialised convenience, rebuildable from events.

## Consequences

- `+` Replay and the round-by-round scrubber come for free.
- `+` Nothing is ever lost; provenance chains are complete.
- `+` Concurrency is simple: parallel agents append; the controller commits in a deterministic order.
- `+` A replay test can assert that folding the events reproduces the stored entries exactly.
- `−` Views must be computed and cached; the per-agent board view (bounded, summarised) is built on top of the live set.
- `−` Storage grows with every run. Acceptable at single-user, local scale; old runs can be archived or deleted whole.
- `−` "Current status" of an entry requires a rule, not a column: latest live entry in its supersede chain wins.

## Alternatives considered

- **Mutable entries with an audit log** — rejected: two sources of truth that drift; replay becomes a reconstruction exercise.
- **Snapshot per round** — rejected: wasteful and still loses intra-round ordering; snapshots can be *derived* from the log where useful for performance.
