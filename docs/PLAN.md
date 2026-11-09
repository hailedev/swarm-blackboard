# Team — Blackboard Agent Swarm

**Project plan · v1 · 7 November 2026**

---

## 1. What we're building

A local, single-user application in which a swarm of LLM agents collaborates on an open-ended problem — research, analysis, design decisions, planning — through a shared **blackboard**. The user poses a problem, watches the board evolve live, can step in at any point, and receives a synthesised answer with full provenance back to the board entries that produced it.

### Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Topology | Blackboard | Agents respond to the state of a shared board rather than a fixed script — the only topology where "swarm" is more than a metaphor |
| v1 problem domain | Open-ended reasoning (text in, text out) | No sandbox or file tools in v1; keeps the focus on coordination, which is the hard part |
| Models | Hybrid: Claude via API + local Ollama | Quality where it matters (control, critique, synthesis); cheap parallel workers for the rest |
| Deployment | Local, single-user | SQLite, no auth, controller runs in-process |
| Language / stack | TypeScript end-to-end | See §4 |
| Implementation | Claude Code does most implementation and testing; Hai reviews | Plan is structured as work packages, each with a definition of done |

### What "done" means for v1

1. A run is fully observable live and replayable afterwards.
2. Every model call is traced: prompt, output, tokens, cost, latency.
3. Hard budgets are enforced in code and visible in the UI.
4. An eval harness compares the swarm against a single-agent baseline at equal budget on at least 10 problems — and we're honest about the result. The swarm beating one strong model is the *goal*, not an assumption.

---

## 2. The blackboard model

Classic blackboard systems have three parts: the board, knowledge sources, and control. Here's how they map.

### 2.1 The board

An append-only log of typed **entries**, plus a materialised "current view". Nothing is edited in place: a correction or refinement is a new entry that `supersedes` the old one. This gives provenance and replay for free.

**Entry types (v1)**

| Type | Purpose | Type-specific fields |
|---|---|---|
| `problem` | Root statement, constraints, success criteria | `constraints[]`, `successCriteria[]` |
| `subproblem` | One step of a decomposition | `status: open \| claimed \| done` |
| `hypothesis` | Candidate answer or approach | `confidence 0–1`, `supportedBy[]`, `contradictedBy[]` |
| `evidence` | A fact or finding with its source | `source`, `supports[]`, `contradicts[]` |
| `critique` | An attack on a specific entry | `target`, `severity: blocking \| major \| minor`, `resolvedBy?` |
| `question` | Something the board can't yet answer | `answeredBy?` |
| `decision` | A resolved conflict between hypotheses | `chosen`, `rejected[]`, `rationale` |
| `synthesis` | Draft final answer | `version`, `confidence`, `cites[]` |
| `human_note` | User intervention | `priority` |

**Common fields:** `id`, `runId`, `type`, `round`, `author` (agent id or `"human"`), `createdAt`, `parents[]`, `supersedes?`, `status`, `content` (markdown), `payload` (type-specific, Zod-validated), `usage { inputTokens, outputTokens, costUsd }`.

### 2.2 Agents (knowledge sources)

**Agents never talk to each other.** They read the board and write to the board. That single discipline is what keeps the system debuggable.

Each agent is defined by: a role prompt, a model (per-role config), a **trigger** (board conditions under which it is eligible to act), and an **output schema** (Zod) for its contributions.

**v1 roster**

| Agent | Contributes | Eligible when | Default model |
|---|---|---|---|
| Planner | `subproblem`, reframes | Board is new, or a stall is detected | Claude Sonnet |
| Researcher | `evidence` | Open subproblems, or hypotheses lacking evidence | Local (Ollama) |
| Solver | `hypothesis`, subproblem work | Open subproblems; evidence with no hypothesis yet | Local (Ollama) |
| Critic | `critique`, `question` — **never** hypotheses | Hypotheses without critique; new evidence on a hypothesis | Claude Sonnet |
| Synthesizer | `synthesis` | ≥1 hypothesis with no blocking critique, or round ≥ N | Claude Sonnet |

Model assignment is configuration, not code — any role can be flipped to any provider. Start hybrid; if a local worker is measurably dragging quality down, flip it and re-measure.

**Agent board view.** An agent never sees the raw board. It sees a role-specific, size-bounded view: the problem, the entries its trigger matched, their linked neighbours, and a rolling summary of everything else. This is the primary defence against context bloat.

### 2.3 The controller

One cycle = one round:

1. **Snapshot** the board; update the cached board summary incrementally.
2. **Eligibility** — evaluate each agent's trigger rules (pure functions over the board).
3. **Bidding** (Phase 5; earlier phases use rule-based priority) — eligible agents return a cheap structured bid `{ wants, targetIds, estimatedValue, rationale }` from a small, fast model.
4. **Selection** — top-k by value, k = parallelism (default 2), with a diversity rule: the same agent can't be selected three rounds running unless it is the only eligible one.
5. **Execution** — run selected agents in parallel. Each returns contributions validated against its schema. Invalid output → one repair attempt → fall back to Claude for that call → otherwise discard and log.
6. **Commit** — write contributions with provenance; emit events.
7. **Conflict check** — two live hypotheses contradict → Critic is forced next round; still contested after critique → a `decision` entry is required before synthesis is allowed.
8. **Termination** — stop when any of:
   - `synthesis.confidence ≥ threshold` **and** no open blocking critiques;
   - stall (no new entries for 2 rounds) → one Planner reframe, then stop;
   - any budget hit: rounds, tokens, dollars, wall-clock.

**Budgets are hard limits enforced in the controller, not requests in prompts.** Default run config: `maxRounds: 12`, `maxCostUsd: 0.25`, `maxTokens: 400_000`, `maxWallClockMs: 15 min`, `parallelism: 2`, `synthesisThreshold: 0.8`. Every model call reserves its worst-case cost before dispatch, a paid profile is checked against the monthly ledger, and provider errors are classified rather than retried blindly — see `docs/budget-guardrails.md`.

**Human-in-the-loop:** pause / resume; inject a `human_note` (highest priority next round); pin or dismiss entries; force synthesis; stop.

---

## 3. User interface

- **Board view** — lanes by entry type; links drawn between entries; confidence and status badges; click an entry for details and its full provenance chain.
- **Live feed** — events as they happen.
- **Agent panel** — each agent's state (idle / bidding / running), assigned model, spend this run.
- **Controls** — start, pause, resume, stop, inject note, force synthesis.
- **Run list and replay** — scrub round-by-round through any past run.
- **Trace viewer** — every model call: prompt, response, tokens, latency, cost.
- **Cost meter** — live spend against budget.

---

## 4. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript, strict; Node 22 LTS | One language from board schema to UI; shared Zod types; the environment Claude Code is most fluent in |
| Monorepo | pnpm workspaces | Simple, fast, well supported |
| Core domain | `packages/core` — pure TS, **no I/O** | Board, schemas, controller, agents, budgets, termination — fully unit-testable with a fake model |
| Model access | Vercel AI SDK (`ai`, current major — v7 as of writing; verify at scaffold) + `@ai-sdk/anthropic` + `ollama-ai-provider-v2` | One interface for `generateText` / `generateObject` / tools across providers; Zod structured output; swapping a role's provider is a config change |
| Schemas | Zod | Shared between core, API and UI |
| Server | Node + Hono; Server-Sent Events for run events | Lightweight; controller loop runs in-process |
| Database | SQLite via Drizzle ORM (`better-sqlite3`) | Local-first; schema kept Postgres-compatible for a later hosted mode |
| Web | Vite + React + TypeScript; TanStack Query; Zustand; Tailwind | Dashboard-grade component ecosystem; fast iteration |
| Tests | Vitest; Playwright (smoke); `FakeModel` provider | Deterministic core tests; LLM-touching tests opt-in |
| Logging | pino; `model_calls` trace table | Everything visible in the trace viewer |
| Local models | Ollama on the Mac mini (M4 Pro, 64 GB unified memory) | Several mid-size models resident at once for parallel workers |

**Why not Python.** Python has more agent frameworks, but a blackboard isn't a framework pattern — the controller is custom either way — and the live UI is central to this app. TypeScript gives one language and one set of types from board to browser.

**Why no agent framework** (LangGraph, CrewAI, Microsoft Agent Framework). They model fixed graphs or manager-led chats; blackboard control is dynamic and board-driven. A framework would fight us. We use a thin provider layer and own the loop — it's a few hundred lines.

**Why the AI SDK rather than raw vendor SDKs.** It covers exactly our surface — structured output with Zod, tool calling, streaming, multi-provider — and makes per-role provider selection trivial. Fallback for Ollama if the v2 provider misbehaves: `@ai-sdk/openai-compatible` pointed at Ollama's OpenAI-compatible endpoint.

**Notes**

- The app calls the Anthropic API directly, so it needs an API key from the Anthropic Console; API usage is billed separately from a Claude.ai subscription.
- Pin every version at scaffold time. AI SDK majors move quickly, and the Ollama provider tracks the current provider spec.
- Local model choice: trial 2–3 candidates in Phase 2. Rank on structured-output reliability first, reasoning quality second — a worker that returns malformed JSON half the time is worse than a slightly weaker one that doesn't.

**`agents.yaml` shape.** Profiles map every role to a model alias and name one fallback for the whole profile (ADR-0009; the file itself is at the repository root). The `dev` profile runs every role locally with no fallback and is the default; `cheap` and `quality` are explicit choices per run. The full shape and the loader rules are in `docs/budget-guardrails.md` §1.

---

## 5. Repository layout

```
swarm-blackboard/
├── CLAUDE.md
├── docs/
│   ├── PLAN.md               # this document — phase checkboxes kept current
│   └── adr/                  # one file per decision (see §9)
├── packages/
│   ├── core/                 # board, schemas, controller, agents, budgets — no I/O
│   └── providers/            # AI SDK adapters, FakeModel, cost tables
├── apps/
│   ├── cli/                  # `pnpm solve` — run the swarm from the terminal
│   ├── server/               # Hono API + SSE + run manager + SQLite
│   └── web/                  # Vite + React dashboard
├── evals/
│   ├── problems/             # benchmark problems (markdown + rubric)
│   ├── results/              # committed eval reports
│   └── run.ts                # swarm vs baseline; LLM judge; report
├── prompts/                  # role prompts, one file per agent
├── fixtures/
│   └── runs/                 # recorded runs used as replay and UI test fixtures
├── agents.yaml               # roster: role → provider/model, prompt, fallback
├── .env.example
└── pnpm-workspace.yaml
```

---

## 6. Phases — Claude Code work packages

Each phase is sized for one or a few Claude Code sessions in Plan Mode, with the definition of done as the acceptance test. Estimates are rough and assume Hai reviewing diffs as they land.

### Phase 0 — Scaffold (~½ day)

- [x] Monorepo; TypeScript strict; ESLint + Prettier; Vitest; GitHub Actions (lint + test).
- [x] `CLAUDE.md` (see §9) and ADRs 0001–0007 — provided with this plan; commit them as-is.
- [x] `.env.example` committed; `.env` gitignored.
- **DoD:** `pnpm lint && pnpm test` green locally and in CI with a placeholder test in each package.

### Phase 1 — Board + controller, no real models (~1–2 days)

- [x] Zod schemas for every entry type; append-only `BoardStore` (in-memory) with materialised view, links, supersede.
- [x] `Agent` interface; `FakeModel` with scripted responses.
- [x] Controller: rule-based eligibility, priority selection, parallel execution, commit, conflict check, termination, budgets.
- [x] CLI: `pnpm solve "<problem>" --fake` prints the board round by round.
- [x] Tests: schema validation; linking and supersede; each eligibility rule; selection diversity; each termination condition; each budget limit; one full scripted run.
- **DoD:** a scripted swarm runs to completion from the CLI; core coverage ≥ 90%.

### Phase 2 — Real models, hybrid roster (~1–2 days)

- [ ] `packages/providers`: Anthropic + Ollama via AI SDK; structured output; retries and timeouts; token and cost accounting; `FakeModel` is re-exported here (defined in `packages/core/src/model/`, Phase 1, so core can test itself without a workspace cycle).
- [ ] Role prompts for all five agents; agent board-view builder with size bounds and rolling summary.
- [x] `agents.yaml` roster loader with profiles; one fallback per profile; load-time validation (ADR-0009).
- [x] Malformed-output path: repair → profile fallback → discard and log.
- [x] Budget guardrails, core (`docs/budget-guardrails.md` §2, §3, §5): per-call reservation that shrinks `maxOutputTokens` to the 256-token floor or skips the call; price table schema and pure cost functions; usage with cache tokens; shared run-end reason enum with paused/failed states; `SpendLedger`/`PeriodBudget` with monthly refusal, pause and one `budget_warning`.
- [x] Budget guardrails, providers (§2, §4): dated price table; `ProviderError` classification; retry with exponential backoff (3 attempts from 1 s); per-call tracing.
- [x] Budget guardrails, CLI (§5, §8): `--profile`, `--yes`, `--max-cost`; confirmation banner; JSONL spend ledger in `data/spend.jsonl`; stale-price-table warning; `.env` loading.
- [ ] Trial 2–3 local models; record results in an ADR.
- [ ] Tests: provider contract tests (skipped without keys / Ollama); prompt snapshot tests; repair and fallback paths with `FakeModel`.
- **DoD:** the CLI solves a real problem end-to-end with the hybrid roster; full trace saved to JSON.

### Phase 3 — Persistence + server (~1–2 days)

- [ ] Drizzle schema: `runs`, `entries`, `events`, `model_calls`, `agent_configs`.
- [ ] Hono API: problems; runs (start / pause / resume / stop / inject); board; trace.
- [ ] SSE: `GET /runs/:id/events`.
- [ ] Run manager: one controller loop per run, in-process.
- [ ] Tests: API tests on in-memory SQLite; SSE integration test; replaying `events` reproduces the board exactly.
- **DoD:** start a run over HTTP, watch it with `curl`, replay it from the database.

### Phase 4 — Web UI (~2–3 days)

- [ ] Board view, live feed, agent panel, controls, run list + replay scrubber, trace viewer, cost meter.
- [ ] Tests: component tests for board rendering; Playwright smoke in `--fake` mode — start a run, see entries appear, pause, inject, stop.
- **DoD:** a full run can be started, watched, steered and replayed in the browser.

### Phase 5 — Smarter control + evals (~2–3 days)

- [ ] LLM bidding with a small model; conflict detection → forced critique / decision; stall escalation; critic gating of synthesis.
- [ ] Eval harness: ≥10 problems with rubrics; swarm vs single-Claude baseline at equal cost; LLM judge plus human spot-check; report committed to `evals/results/`.
- **DoD:** an eval report exists; at least one controller change has been adopted or rejected on eval evidence.

### Phase 6 — Backlog (post-v1)

- Tools for the Researcher: web search + URL fetch.
- Dynamic roster: the Planner can request a specialist agent for a subproblem.
- Sub-boards for large decompositions.
- Problem library; answer export as markdown with citations back to entries.
- MCP tool support.
- Hosted / multi-user mode (Postgres swap, auth).
- Code sandbox and file tools for coding tasks.

---

## 7. Testing strategy

- **Core is pure and deterministic** → tested with `FakeModel`. Unit tests never touch the network.
- **LLM-touching tests** are tagged and opt-in (`pnpm test:llm`), auto-skipped when keys or Ollama are absent.
- **Prompts are snapshot-tested** on their inputs, never on model outputs.
- **Recorded runs** are fixtures for replay and UI tests.
- **Evals are not tests.** Tests measure correctness; evals measure quality. They live in different directories and run on different schedules.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cost runaway | Hard budgets in the controller with per-call reservation; monthly spend ledger; `dev` profile that cannot spend; cheap bidding model; local workers; live cost meter (`docs/budget-guardrails.md`) |
| Groupthink / premature convergence | Critic cannot propose; diversity rule in selection; hypotheses must link evidence; devil's-advocate prompt variant |
| Context bloat | Bounded per-agent views; rolling summary; supersede instead of pile-up |
| Non-termination | Stall detection + a single reframe + hard caps |
| Flaky tests | `FakeModel` for all core tests; LLM tests opt-in |
| Local models produce junk | Zod validation → repair → Claude fallback; measure failure rate per role and flip roles that fail |
| Swarm no better than a single agent | Eval harness from Phase 5; be willing to shrink the roster |
| Dependency churn | Pin versions; thin provider layer so swapping is cheap |

---

## 9. Working with Claude Code

`CLAUDE.md` should state:

- **Stack and commands:** `pnpm dev`, `pnpm test`, `pnpm test:llm`, `pnpm solve`, `pnpm eval`.
- **Architecture rules:** `packages/core` has no I/O; agents communicate only via the board; schemas first; budgets are enforced in code, never only in prompts.
- **Testing rules:** unit tests never hit a network; controller tests use `FakeModel`; LLM tests are opt-in.
- **Process:** Plan Mode for every phase; small, reviewable diffs; tick the checkboxes in `docs/PLAN.md` as items land; record decisions in `docs/adr/`.
- **Conventions:** strict TypeScript, no `any`, Zod at every boundary.

**ADRs to write in Phase 0**

1. Blackboard over orchestrator–workers
2. TypeScript monorepo
3. AI SDK as the provider layer; no agent framework
4. Append-only board with supersede links
5. Agents communicate only via the board
6. Hybrid model assignment by role
7. SQLite, local-first

**Suggested kick-off prompt (Phase 0)**

> Read `docs/PLAN.md`. Implement Phase 0 exactly as specified. Use Plan Mode first and show me the plan before writing any files.

---

## 10. Open questions

- Which 2–3 local models to trial for the worker roles in Phase 2.
- Judge model and rubric format for the evals.
- Whether bidding should run on a local model or Claude Haiku — decide on measured reliability in Phase 5.
- Web search provider, when Phase 6 arrives.
