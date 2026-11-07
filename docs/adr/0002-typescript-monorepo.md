# ADR-0002: Build as a TypeScript monorepo

- **Status:** accepted
- **Date:** 2026-11-07

## Context

The app is as much a live observability UI as it is an agent runtime: the board view, event feed, controls, replay and trace viewer are central to v1, not an afterthought. Implementation will be done largely by Claude Code with the owner reviewing. The owner chose the best-fit stack over familiarity.

## Decision

TypeScript (strict) end-to-end on Node 22 LTS, organised as a pnpm-workspaces monorepo:

- `packages/core` — pure domain logic, no I/O
- `packages/providers` — model adapters and tracing
- `apps/server` — API, event stream, persistence
- `apps/web` — dashboard
- `evals/` — quality harness

Zod schemas are the single source of truth for types and are shared across all packages.

## Consequences

- `+` One language from board schema to browser; types flow through without duplication.
- `+` First-class streaming to the UI (SSE) with no serialisation boundary to maintain by hand.
- `+` Claude Code is highly productive in this stack; the ecosystem for LLM access in TypeScript is mature.
- `+` A pure `core` package is straightforward to keep I/O-free and unit-test exhaustively.
- `−` The Python ML ecosystem is not directly available. If evals later want Python tooling (e.g. a notebook for analysis), it can live beside `evals/` as scripts without changing this decision.
- `−` Monorepo tooling (workspaces, project references, shared tsconfig) is a small up-front cost paid in Phase 0.

## Alternatives considered

- **Python backend + React frontend** — richest agent-framework ecosystem. Rejected: two languages, duplicated types across the API boundary, and we are not using an agent framework (ADR-0003), which removes Python's main advantage here.
- **.NET (ASP.NET Core + Microsoft Agent Framework)** — the owner's home turf and a capable stack. Rejected on the owner's explicit instruction to pick best-fit over familiarity; the LLM tooling ecosystem is thinner and the UI story is a separate language either way.
- **Single Next.js app** — one framework for API and UI. Rejected: the controller is a long-running in-process loop, which fits a plain Node server better than a request-scoped framework.
