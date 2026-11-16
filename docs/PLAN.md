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
| `subproblem` | One step of a decomposition | `status: open \| claimed \| done` as posted; where it stands is read off the board (below) |
| `hypothesis` | Candidate answer or approach | `confidence 0–1`, `supportedBy[]`, `contradictedBy[]`, `resolves[]` (the critiques this version answers), `rivalOf[]` (the answers it was posted as a rival to; stamped by the controller) |
| `evidence` | A fact or finding with its source | `source`, `supports[]`, `contradicts[]` |
| `critique` | An attack on a specific entry | `target`, `severity: blocking \| major \| minor`, `resolvedBy?` (in logs written before Step 2b; no agent can set it now, see below) |
| `question` | Something the board can't yet answer | `answeredBy?` |
| `decision` | A resolved conflict between hypotheses | `chosen`, `rejected[]`, `rationale` |
| `synthesis` | The answer: drafts during the run, the final write-up when it ends (§2.3 step 9) | `version`, `confidence`, `cites[]`, `stage: draft \| final` (stamped by the controller, never by a model) |
| `human_note` | User intervention | `priority` |

**Common fields:** `id`, `runId`, `type`, `round`, `author` (agent id or `"human"`), `createdAt`, `parents[]`, `supersedes?`, `status`, `content` (markdown; the Synthesizer returns it as an array of paragraphs that core joins with a blank line, since a local model under a JSON `format` may never emit a line break, ADR-0008), `payload` (type-specific, Zod-validated), `usage { inputTokens, outputTokens, costUsd }`.

**State that is derived, not posted** (Phase 5, Step 2b). The runs of 2026-11-16 showed that no model keeps books on the board: subproblems were claimed and never finished, and critiques were replaced without anybody saying which had been answered. So:

- **A subproblem's status is read off the board** (`subproblemStatus` in core). It is *done* when a live hypothesis that no decision has rejected names it among its parents and has no open blocking or major critique; *claimed* when every such hypothesis is contested; otherwise what was stored, which for a new subproblem is `open`. Supersede chains are followed on both sides. No agent posts a status change, and the Solver posts hypotheses only.
- **A critique closes when what it attacks is replaced, and in no other way.** The schema a model answers against has no `resolvedBy`: in the rehearsals of 2026-11-16 the local Critic set it on 44 of 125 new critiques, most often to the very hypothesis under attack, and a critique born resolved is never open, so nobody was sent back to it and it held no synthesis up.
- **`resolves` is a record, not a switch.** What it adds is the claim of which critiques a new version answers: the Critic is told to check each claim against the new version and to critique again if it does not hold, and the eval report counts a critique as resolved only when it was named this way and no longer stands. Only a critique that still stands can be named, and only by the version that replaces what it attacks: a closed critique is not offered, and a rival resolves nothing.
- **A subproblem takes one answer.** A hypothesis posted on a subproblem that already has a standing one either **replaces** it (`supersedes`, and only a hypothesis standing for that same subproblem can be replaced) or is **declared its rival** (`rivalOf`), and a declared rivalry is a contradiction the decision flow settles (§2.3 step 7). The schema the Solver answers against makes this unavoidable instead of asking for it: one variant per live subproblem, told apart by `answers`, whose `relation` admits `"new version of H…"` for that subproblem's standing hypotheses and `"rival"`, and whose `resolves` admits the open critiques against them; `answers` and `relation` come before the content. With no standing answer there is no `relation`; with exactly one it may be left out and the controller links the hypothesis as a new version of it; with two or more it is required. A reply is then settled as a whole (`settleAnswers`): one new version per hypothesis, one first answer per subproblem, a subproblem that already has another answer struck from the parents, and what is left over dropped with a note on the log. In the rehearsals of 2026-11-16 the local Solver, free to set `supersedes` or not, left 15 of 93 hypotheses standing beside the ones they rewrote: it named critiques on hypotheses that superseded nothing, and in two runs of three wrote a second full set of answers beside the first.
- **Rejection follows the line.** A decision settles between two lines of answers, not two entries: a later version of a rejected hypothesis is rejected with it (the Solver may post one in the very round the Synthesizer decides), and a rivalry stays the same conflict when either side is replaced by a new version.
- **A hypothesis a live `decision` rejected is out of the running**: not a candidate for a synthesis, not sent back to the Solver, not counted as answering a subproblem, and shown to the final write-up apart from the candidates.

### 2.2 Agents (knowledge sources)

**Agents never talk to each other.** They read the board and write to the board. That single discipline is what keeps the system debuggable.

Each agent is defined by: a role prompt, a model (per-role config), a **trigger** (board conditions under which it is eligible to act), and an **output schema** (Zod) for its contributions.

**v1 roster**

| Agent | Contributes | Eligible when | Default model |
|---|---|---|---|
| Planner | `subproblem`, reframes | Board is new, or a stall is detected | Claude Sonnet |
| Researcher | `evidence` | Open subproblems, or hypotheses lacking evidence | Local (Ollama) |
| Solver | `hypothesis`, nothing else, each as the answer to one subproblem: a first answer, a new version of the standing one, or its declared rival (§2.1) | First, a live hypothesis with an open blocking or major critique: post a version that supersedes it and names the critiques it `resolves` (ahead of new work, at most four such hypotheses per call, worst first). Otherwise open subproblems; evidence with no hypothesis yet | Local (Ollama) |
| Critic | `critique`, `question` — **never** hypotheses | Standing hypotheses it has not reviewed in their current version, or that have had evidence since it did (at most six a call). Being called on a version is the review, whether or not it raises anything: what each selected agent was pointed at is on the log (`agents_selected`, `targetIds`), so "reviewed, nothing to raise" can be told from "never reviewed". Forced, and then certain to run, onto the two hypotheses of a contradiction (§2.3 step 7) | Claude Sonnet |
| Synthesizer | `synthesis`; `decision` entries before it when a contradiction is to be decided | ≥1 standing hypothesis with no blocking critique, or round ≥ N, and in either case **only when something has been posted since its last synthesis**; in any round when a decision is owed | Claude Sonnet |

Model assignment is configuration, not code — any role can be flipped to any provider. Start hybrid; if a local worker is measurably dragging quality down, flip it and re-measure.

**Limits.** A role may post only so many contributions per call (Planner 8, the others 6). A reply that goes over is not rejected: the first ones are kept, the Critic's ranked blocking, major, minor, then questions, and the rest are dropped with a note on the log (`agent_failed`, reason `over_limit`, which is not a failure of the call). Rejecting such replies cost 16 of 27 Critic calls in the runs of 2026-11-16.

**Agent board view.** An agent never sees the raw board. It sees a role-specific, size-bounded view: the problem, the entries its trigger matched, their linked neighbours, and a rolling summary of everything else. This is the primary defence against context bloat. (Phase 2 builds the view per round as a pure function of the board, with bounds in `RunConfig.view`; the incremental summary cache of §2.3 step 1 is deferred until a run shows it matters.)

**Handles, not ids.** Models never generate ids. The view names every entry by a short handle: its type letter plus its ordinal in commit order (`P1` problem, `S2` subproblem, `H3` hypothesis, `E7` evidence, `C2` critique, `Q1` question, `D1` decision, `A1` synthesis, `N1` human note), stable for the life of the run. The agent's output schema is built per call: every link field is an enum of the handles its view names, and `supersedes` an enum of the live entries of the same type, so a provider that decodes against the schema cannot produce a dangling link and one that does not fails validation into the repair path. Core resolves handles back to UUIDs the moment the model's answer validates; the board, the event log and everything after the agent stay in UUID space (hardening pass, 2026-11-09; the re-run of the local-model trial is recorded in ADR-0008).

### 2.3 The controller

One cycle = one round:

1. **Snapshot** the board; update the cached board summary incrementally.
2. **Eligibility** — evaluate each agent's trigger rules (pure functions over the board).
3. **Bidding** (Phase 5; earlier phases use rule-based priority) — eligible agents return a cheap structured bid `{ wants, targetIds, estimatedValue, rationale }` from a small, fast model.
4. **Selection** — top-k by value, k = parallelism (default 2), with a diversity rule: the same agent can't be selected three rounds running unless it is the only eligible one.
5. **Execution** — run selected agents in parallel. Each returns contributions validated against its schema. Invalid output → one repair attempt → fall back to Claude for that call → otherwise discard and log. A reply that is valid but longer than its role may post is cut to the limit, not discarded (§2.2, Limits).
6. **Commit** — write contributions with provenance; emit events.
7. **Conflict check** — two live hypotheses contradict (one lists the other in `contradictedBy`, evidence supports one and contradicts the other, or one was posted as the other's declared rival on a subproblem and both still stand) → the Critic is forced next round, certain to run and aimed at that pair only (aimed at every live hypothesis it wrote more than it may post, every round, to the end of a run); still contested after critique → a `decision` entry is required before a synthesis can complete the run. The Synthesizer posts it (Phase 5, Step 2b): while a decision is owed it is eligible in any round, its prompt names each undecided pair and the evidence that sets them against each other, and its schema admits up to three `decision` entries before its one synthesis, committed in that order so the run can complete in the same round. A decision names which hypothesis is `chosen` and which `rejected`; the rejected one is out of the running (§2.1). An undecided contradiction still **caps the synthesis**: however confident, it cannot complete the run while the contradiction stands, and such a run ends on a budget or stall reason instead (enforced in `checkTermination`; hardening pass, 2026-11-09). A decision does not by itself call the Synthesizer back, so one that fails to settle a contradiction is not retried on an unchanged board.
8. **Termination** — stop when any of:
   - a synthesis may end the run (`completed`) when all of these hold: `synthesis.confidence ≥ threshold`; **no blocking or major critique is open** (the set the Solver is sent back for; critiques of a rejected hypothesis aside); **it was written after the last hypothesis or critique landed** (agents of a round read the board as the round began, so a synthesis has read only what landed in earlier rounds); **the Critic has nothing left to review** on the standing versions (its own trigger, §2.2); and no contradiction is undecided (step 7). Until 2026-11-17 only a blocking critique held a run: a rehearsal run completed in four rounds on a draft at 0.85 written in the very round the Critic raised six major critiques, none of which was ever answered. A run that never gets there ends on a budget and is written up all the same;
   - no agent is eligible (`no_eligible_agents`): since the Synthesizer no longer rewrites a synthesis on an unchanged board, a run with nothing left to answer ends here instead of spending its remaining rounds;
   - stall (no new entries for 2 rounds) → one Planner reframe, then stop;
   - any budget hit: rounds, tokens, dollars, wall-clock.
9. **Final write-up** (Phase 5, Step 2a) — once the run is ending for good, for whatever reason of step 8 or because the user stopped it, the Synthesizer's model writes the answer one more time, and this time from the **whole live board** instead of an agent's bounded view: every live entry in full, up to `writeUp.maxBoardChars`, with critiques of entries that have since been replaced or rejected left out, and hypotheses a decision rejected listed apart from the candidates. It writes for a reader who has never seen the board (`prompts/write-up.md`): no board, agents, handles or talk of its own confidence in the text, every success criterion answered with the specifics the board holds, most of its words spent on concrete figures, every point the board left open decided and marked "Assumption:" rather than listed as unresolved, and no claim repeated as it stood while a critique stands against it. It is asked for the words its output allowance buys (`writeUp.maxOutputTokens`, 2,700 tokens ≈ 900 words by default; `wordBudgetFor` in core, the function and the sentence the eval baseline is given). The model returns paragraphs, a confidence and the handles it cites; the controller commits them as a `synthesis` one version past the latest draft, superseding it, with `stage: final`, so the run's answer (`latestSynthesis`) is the write-up everywhere. The rounds' syntheses stay what they were: short drafts that steer the run.
   - It is not a round: `write_up_started` and `write_up_completed` bracket it on the log, between the last round and `run_terminated`; the run's reason and status are unchanged.
   - Its worst-case cost is **held back from `maxCostUsd` from the first round on**, so no round can spend the answer's money, and a cap that cannot cover it is refused at start (`docs/budget-guardrails.md` §2).
   - No write-up for a run ended by `billing` or `auth`, for a board that holds nothing but the problem, or when the month's budget is already spent. When the call fails, the last draft stays the answer and the reason is on the log.
   - **Length guard.** A write-up that comes back under half the words it was asked for is asked for once more, with the shortfall stated and the short answer to build on, on whatever the run has left; the longer of the two is committed. `write_up_completed` records `attempts`, the `words` of the answer kept and `short` when even that is under half, and the eval report flags it. (One rehearsal write-up was a single 72-word paragraph, shorter than the draft it replaced.)
   - A host that dies during the call leaves `write_up_started` on the log; the resumed run finishes that same end instead of running more rounds.

**Budgets are hard limits enforced in the controller, not requests in prompts.** Default run config: `maxRounds: 12`, `maxCostUsd: 0.25`, `maxTokens: 400_000`, `maxWallClockMs: 15 min`, `parallelism: 2`, `synthesisThreshold: 0.8`, `writeUp: { maxOutputTokens: 2_700, maxBoardChars: 48_000 }`. Every model call reserves its worst-case cost before dispatch, a paid profile is checked against the monthly ledger, and provider errors are classified rather than retried blindly — see `docs/budget-guardrails.md`.

**Human-in-the-loop:** pause / resume; inject a `human_note` (highest priority next round); pin or dismiss entries; force synthesis; stop. Force synthesis is a recorded request (`synthesis_requested` event, Phase 4, ADR-0011): the Synthesizer runs in the first round that starts after it, whatever its trigger says and exempt from the diversity rule, and the run ends on that synthesis only if the termination rules of step 8 say so. A stop ends the run with the final write-up of step 9, so stopping early still leaves an answer written from everything on the board; until that call has returned the run accepts no further command. Pinning and dismissing are not built yet (backlog, §6).

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
│   ├── providers/            # AI SDK adapters, FakeModel, cost tables
│   └── host/                 # Node adapters + Drizzle/SQLite store shared by cli and server (ADR-0010)
├── apps/
│   ├── cli/                  # `pnpm solve` — run the swarm from the terminal
│   ├── server/               # Hono API + SSE + run manager
│   └── web/                  # Vite + React dashboard
├── evals/
│   ├── problems/             # benchmark problems (markdown + rubric)
│   ├── results/              # committed eval reports
│   └── src/                  # pnpm eval: swarm vs baseline, blind judge, report (ADR-0012)
├── prompts/                  # role prompts, one file per agent, and write-up.md for the final answer
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

- [x] `packages/providers`: Anthropic + Ollama via AI SDK; structured output; retries and timeouts; token and cost accounting; `FakeModel` is re-exported here (defined in `packages/core/src/model/`, Phase 1, so core can test itself without a workspace cycle).
- [x] Role prompts for all five agents; agent board-view builder with size bounds and rolling summary.
- [x] `agents.yaml` roster loader with profiles; one fallback per profile; load-time validation (ADR-0009).
- [x] Malformed-output path: repair → profile fallback → discard and log.
- [x] Budget guardrails, core (`docs/budget-guardrails.md` §2, §3, §5): per-call reservation that shrinks `maxOutputTokens` to the 256-token floor or skips the call; price table schema and pure cost functions; usage with cache tokens; shared run-end reason enum with paused/failed states; `SpendLedger`/`PeriodBudget` with monthly refusal, pause and one `budget_warning`.
- [x] Budget guardrails, providers (§2, §4): dated price table; `ProviderError` classification; retry with exponential backoff (3 attempts from 1 s); per-call tracing.
- [x] Budget guardrails, CLI (§5, §8): `--profile`, `--yes`, `--max-cost`; confirmation banner; JSONL spend ledger in `data/spend.jsonl`; stale-price-table warning; `.env` loading.
- [x] Trial 2–3 local models; record results in an ADR (ADR-0008; `pnpm trial:local`).
- [x] Tests: provider contract tests (skipped without keys / Ollama); prompt snapshot tests; repair and fallback paths with `FakeModel`.
- **DoD:** the CLI solves a real problem end-to-end with the hybrid roster; full trace saved to JSON. ✔ 2026-11-09: `fixtures/runs/2026-11-09-cheap-release-process/` (`cheap` profile, 12 rounds, 23 calls all valid first time, $0.024, four synthesis versions).

### Phase 3 — Persistence + server (~1–2 days)

- [x] Drizzle schema: `runs`, `entries`, `events`, `model_calls`, `agent_configs` (in `packages/host`, shared with the CLI; ADR-0010).
- [x] Hono API: the problem is posted with the run (`POST /runs`); runs (start / pause / resume / stop / inject a note); board (fold of the log, with handles); log; trace; profiles; monthly budget.
- [x] SSE: `GET /runs/:id/events`, with replay from `from` / `Last-Event-ID`, a ping while quiet, closed after `run_terminated`.
- [x] Run manager: one controller loop per run, in-process; a paused run is rebuilt from its event log when resumed, stopped or annotated after a restart; runs a dead process left running are paused as `interrupted` at start-up, and a round left in flight is recorded as `round_abandoned` first (it counts as used; the resumed run continues at the next round, so every round has one start; Phase 5).
- [x] Tests: API tests on in-memory SQLite; SSE integration tests (backlog, `Last-Event-ID`, live delivery); replaying `events` reproduces the board exactly (scripted run and the recorded fixture); recovery and resume from the log.
- **DoD:** start a run over HTTP, watch it with `curl`, replay it from the database. ✔ 2026-11-09: `dev` profile over HTTP, three rounds, 19 entries, every event on the stream; a second run killed mid-way came back `paused/interrupted` after a restart and was resumed from the database.

### Phase 4 — Web UI (~2–3 days)

- [x] Board view, live feed, agent panel, controls, run list + replay scrubber, trace viewer, cost meter (ADR-0011). The board names every entry by its handle; the start-run dialog and the two-gauge cost meter are those of `docs/budget-guardrails.md` §5; every run that is not running shows its reason. Controls are start, pause, resume, stop, inject note and force synthesis; pinning and dismissing entries moved to the backlog.
- [x] Tests: component tests for board rendering (static markup in Node, against the recorded run; no DOM package, ADR-0011); Playwright smoke in `--fake` mode — start a run, see entries appear, pause, inject, force a synthesis, stop, reload and replay (`pnpm test:e2e`, its own CI job).
- **DoD:** a full run can be started, watched, steered and replayed in the browser. ✔ 2026-11-10, in Chromium: a `dev` run on `local-fast` (`qwen3.6:35b-mlx`, seven calls, all valid first time) was watched live, paused, given a note and a forced synthesis (served by round 3, the first to start after the request; at confidence 0.75 it did not end the run) and ran to its four-round limit with 30 entries; a second run whose server was killed mid-way came back `paused/interrupted` in the list and was resumed from the browser to its five-round limit; the recorded 96-entry run of Phase 2 was loaded into a database and replayed round by round. The same flow on scripted models is the Playwright smoke.

### Phase 5 — Smarter control + evals (~2–3 days)

Controller changes, one per paid eval pass, each adopted or rejected on it, in the order set after the third pilot (2026-11-16). The three pilot problems are the development set; the other seven are held out until one full pass at the end (`evals/README.md`).

- [x] **2a** The final write-up at run end (§2.3 step 9). Adopted on the step2a pass, 2026-11-16: swarm 55.9 → 69.2 %, baseline 85.4 → 94.4 % (ADR-0014).
- [ ] **2b** Closing the loop: the Solver answers open critiques and names the ones it resolves; a reply over its limit keeps its first contributions instead of being rejected; the Synthesizer runs only when the board has changed; subproblems reach done; the contradiction → decision flow.
- [ ] LLM bidding with a small model.
- [ ] Stall escalation and critic gating of synthesis.
- [ ] Thinking on for the Critic and Synthesizer (`haiku-think`, `sonnet-think`) measured against thinking off (ADR-0013).
- [ ] Eval harness: ≥10 problems with rubrics; swarm vs single-Claude baseline at equal cost; LLM judge plus human spot-check; report committed to `evals/results/`.
- **DoD:** an eval report exists; at least one controller change has been adopted or rejected on eval evidence.

### Phase 6 — Backlog (post-v1)

- Tools for the Researcher: web search + URL fetch.
- Pin or dismiss an entry from the UI (§2.3): the board already models both as a superseding copy with the new status; the controller method, the route and the buttons are not built.
- Render entry content and the answer as markdown in the UI (shown as written for now).
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

- ~~Which 2–3 local models to trial for the worker roles in Phase 2.~~ Settled by ADR-0008.
- ~~Judge model and rubric format for the evals.~~ Settled by ADR-0012: Sonnet judges blind in both orders; markdown problems with a YAML rubric of weighted 0–3 criteria.
- Whether bidding should run on a local model or Claude Haiku — decide on measured reliability in Phase 5.
- Web search provider, when Phase 6 arrives.
