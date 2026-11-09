# Team — Blackboard Agent Swarm

A local, single-user app in which a swarm of LLM agents collaborates on open-ended problems through a shared blackboard. The user poses a problem, watches the board evolve live, can intervene, and gets a synthesised answer with provenance back to the board entries that produced it.

**Read `docs/PLAN.md` before starting any work.** It defines the architecture, the board schema, the controller cycle, the phases and their definitions of done. Decisions are recorded in `docs/adr/` — read the relevant ADR before proposing a change to anything it covers.

## Start of every session

1. Read the phase checkboxes in `docs/PLAN.md` to find the current phase.
2. Work on the current phase only. Don't pull items forward from later phases without asking.
3. If the current phase is ambiguous, ask before writing code.

## Stack

| Package | Role |
|---|---|
| `packages/core` | Board, entry schemas, controller, agent abstractions, budgets, termination. **Pure TypeScript, no I/O.** |
| `packages/providers` | Model adapters via Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `ollama-ai-provider-v2`), cost tables, call tracing; re-exports `FakeModel` (defined in core so core can test itself) |
| `packages/host` | What a Node host needs (ADR-0010): roster/prompt loaders, env, clock, UUID v7 ids, console logger, and the Drizzle/SQLite store (`better-sqlite3`) behind core's `BoardStore`, `SpendLedger` and `TraceSink` ports. Depends on core only. One `data/team.db` is the ledger for CLI, server and `pnpm test:llm` |
| `apps/cli` | `pnpm solve` — runs the swarm from the terminal on the host adapters and store |
| `apps/server` | Hono API, SSE event stream, run manager, on the host store |
| `apps/web` | Vite + React, TanStack Query, Zustand, Tailwind |
| `evals/` | Benchmark problems and the swarm-vs-single-agent harness |
| `prompts/` | One markdown file per agent role — prompts are never inline in code |
| `agents.yaml` | Roster: role → provider/model/fallback |

TypeScript strict, Node 22 LTS, pnpm workspaces. Zod at every boundary; schemas are the source of truth for types.

## Commands

```
pnpm install
pnpm dev                         # API server on PORT (3001) and the web app on http://localhost:5173, both with reload
pnpm dev:fake                    # the same with scripted models and an in-memory database: no Ollama, no spend
pnpm test                        # unit + integration — never touches the network
pnpm test:llm                    # opt-in tests against real models (needs keys / Ollama)
pnpm lint
pnpm typecheck
pnpm solve "<problem>" [--fake]  # run the swarm from the CLI; --fake uses FakeModel
pnpm ledger:import [file]        # one-shot import of the old data/spend.jsonl into model_calls
pnpm db:generate                 # regenerate the SQL migrations after a schema change
pnpm eval                        # swarm vs single-agent baseline at equal budget
```

## Architecture rules — non-negotiable

1. **`packages/core` has no I/O.** No `fetch`, `fs`, database, `process.env`, or wall-clock access. Everything arrives through interfaces: `Model`, `Clock`, `BoardStore`, `Logger`. If you need an import from Node built-ins in core, you're in the wrong package.
2. **Agents communicate only through the board.** No agent calls another agent. No shared mutable state outside the board. An agent is a function of `(boardView, config) → contributions`.
3. **The board is append-only.** Nothing is edited in place. A correction is a new entry whose `supersedes` field points at the old one. The event log is the source of truth; the current view is derived from it.
4. **Budgets are enforced in the controller, in code.** A prompt may mention a budget; the controller is what actually stops the run. Rounds, tokens, dollars and wall-clock are all hard limits.
5. **Schemas first.** Define or change the Zod schema before the code that produces or consumes it. Every model output is validated against a schema before it touches the board.
6. **Every model call goes through `packages/providers`** and is traced: prompt, response, tokens, cost, latency. No direct vendor-SDK calls anywhere else.
7. **Model assignment is configuration.** Which provider and model back a role lives in `agents.yaml`, never in code.

## Testing rules

- Unit tests never touch the network. Controller and agent tests use `FakeModel` with scripted responses.
- Tests that call real models are named `*.llm.test.ts`, run only via `pnpm test:llm`, and skip themselves when `ANTHROPIC_API_KEY` or a reachable Ollama is absent.
- Snapshot-test prompt **inputs** (the rendered prompt), never model outputs.
- Recorded runs in `fixtures/runs/` are the fixtures for replay and UI tests.
- Core coverage target: 90%. A phase is not done while its definition-of-done tests are red.
- Evals (`pnpm eval`) measure quality, not correctness. They are not part of `pnpm test` and never gate a commit.

## Workflow

- Use Plan Mode for every phase and for any change touching `packages/core`. Show the plan before writing files.
- Keep changes small and reviewable: one concern per commit, conventional commit messages (`feat(core): …`, `test(server): …`).
- When a phase item lands, tick its checkbox in `docs/PLAN.md` in the same commit.
- A decision that changes an existing ADR, or adds a dependency, gets a new ADR in `docs/adr/` (copy `0000-template.md`). Never edit an accepted ADR — supersede it.
- Pin dependency versions exactly. No `^` or `~` ranges.
- Don't add a dependency when ~50 lines of code would do.
- Don't refactor outside the scope of the current task. Note it and move on.

## Conventions

- No `any`. No non-null assertions (`!`). Prefer discriminated unions to optional fields.
- Named exports only. One module per concept; file names kebab-case.
- Schemas end in `Schema` (`EntrySchema`); inferred types don't (`Entry`).
- Inside core, errors are values (`Result<T, E>`-style). Throw only at the edges (server handlers, CLI).
- Dates are ISO-8601 strings at boundaries, `Date` only transiently.
- IDs are UUID v7 strings (time-ordered, Postgres-portable).

## Secrets and environment

- `.env` is gitignored. Copy `.env.example` to get started: `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`.
- Never commit keys. Never log prompt or response contents at `info` level — they go to the trace table only.
- The app calls the Anthropic API directly; it needs an API key from the Anthropic Console (billed separately from a Claude.ai subscription).
