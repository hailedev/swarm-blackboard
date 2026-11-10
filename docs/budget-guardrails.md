# Budget guardrails

**Status:** Phases 2–4 implemented, 2026-11-09 to 2026-11-10 (§8 says what landed when: profiles, per-run cap with per-model calibrated estimates, pricing, error classification, the `model_calls` ledger shared by CLI and server, the CLI banner and the web cost meter). Phase 5 adds the bidder's calls to the per-run cap and an eval pass cap (§9). Where the implementation deviates from the original spec, this document describes what was built. Referenced from `docs/PLAN.md`.

## Goal

The app must be unable to spend more than the user intends, and a budget stop must be a **graceful run state with a clear reason**, never an API error mid-round. The monthly API budget is small (about **$5**), so these are not nice-to-haves.

Defence in depth, innermost first:

1. **App-level** (this document) — stops a run cleanly before the money is spent.
2. **Anthropic Console monthly spend limit** — stops anything the app gets wrong.
3. **Prepaid credit balance with auto-reload off** — stops anything the Console gets wrong.

Layers 2 and 3 are configured by the user in the Console. This document specifies layer 1.

---

## 1. Profiles

A **profile** maps every role to a model alias and says what to fall back to when a local model's output fails schema validation. Agents (prompts, triggers, schemas) are defined once; profiles only choose models.

```yaml
# agents.yaml
defaultProfile: dev

models:
  # Thinking off on the Claude aliases: the thinking tokens are billed as output and count
  # against the allowance (ADR-0013). The -think aliases keep it on for experiments.
  sonnet: { provider: anthropic, model: claude-sonnet-5-5, think: false }
  haiku: { provider: anthropic, model: claude-haiku-5-5, think: false }
  sonnet-think: { provider: anthropic, model: claude-sonnet-5-5, think: true }
  haiku-think: { provider: anthropic, model: claude-haiku-5-5, think: true }
  # Worker model chosen by the Phase 2 trial (ADR-0008). Thinking is off: on this model
  # it was 7x slower and less link-valid. `local-think` stays for experiments.
  local: { provider: ollama, model: qwen3.6:35b-a3b-q8_0, think: false }
  local-think: { provider: ollama, model: qwen3.6:35b-a3b-q8_0, think: true }
  # The MLX build of the same model: as valid as `local` once agents link by handle, and
  # faster on long answers (ADR-0008, amendments). Only `dev` uses it until the Phase 5
  # evals have compared the two on quality.
  local-fast: { provider: ollama, model: qwen3.6:35b-mlx, think: false }

profiles:
  dev: # zero API spend; the default
    fallback: none # schema failure → repair once → discard and log
    roles:
      planner: local-fast
      researcher: local-fast
      solver: local-fast
      critic: local-fast
      synthesizer: local-fast
      bidder: local-fast
  cheap: # ~1–2 cents per run
    fallback: haiku
    roles:
      planner: haiku
      researcher: local
      solver: local
      critic: haiku
      synthesizer: haiku
      bidder: haiku
  quality: # ~15–25 cents per run
    fallback: haiku
    roles:
      planner: haiku
      researcher: local
      solver: local
      critic: sonnet
      synthesizer: sonnet
      bidder: haiku

agents:
  planner: { prompt: prompts/planner.md }
  researcher: { prompt: prompts/researcher.md }
  solver: { prompt: prompts/solver.md }
  critic: { prompt: prompts/critic.md }
  synthesizer: { prompt: prompts/synthesizer.md }
```

This block is the file at the repository root as of 2026-11-10. An alias may also carry `numCtx` (context window to request from a local model) and `charsPerToken` (§2); no alias sets either today.

Rules:

- `defaultProfile` is `dev`. A paid profile is always an explicit choice per run (`pnpm solve "…" --profile quality`, or `profile` in `POST /runs`).
- **Fallback is a profile property, not a role property**, so the `dev` profile can never reach a paid model by accident. The loader rejects a profile whose `fallback` resolves to a paid provider when every role is local — that configuration is almost certainly a mistake.
- A run record stores the profile name **and** the resolved provider/model for every role, so traces and evals are reproducible even after `agents.yaml` changes.
- Validation at load time: every role in every profile resolves to a known model alias; unknown profile names are rejected with the list of valid ones.

---

## 2. Per-run cost cap (core)

```ts
interface RunBudget {
  maxRounds: number;        // default 12
  maxCostUsd: number;       // default 0.25
  maxTokens: number;        // default 400_000 (all roles, in + out)
  maxWallClockMs: number;   // default 15 min
  parallelism: number;      // default 2
}
```

Enforcement points, all inside the controller:

1. **Before each round:** if `spentUsd >= maxCostUsd` → terminate with reason `budget_cost`. Same for rounds, tokens and wall-clock, each with its own reason.
2. **Before each model call — reservation:** the controller estimates the prompt's input tokens as ⌈(system + prompt + serialised JSON schema characters) / charsPerToken⌉; there is no provider count-tokens call. The schema counts because it varies per call (its link fields are an enum of the handles the agent can see). `charsPerToken` is **per model**: 2.0 for Anthropic and 3.0 for Ollama by default, an explicit `charsPerToken` on the alias in `agents.yaml`, or, for API-billed models, a figure **calibrated from the model's own traces**: the pooled Σ chars ÷ Σ reported prompt tokens over its last 50 calls, divided by a 1.15 safety factor, used once at least 5 calls exist and clamped to 1–8. Local models keep the default: Ollama reports only the newly evaluated prompt tokens after a KV-cache hit, so calibrating on its counts would make the estimate optimistic, and for a free model the estimate only guards the context window, where conservative is right. With the call's `maxOutputTokens` it computes the worst-case cost of the call. On a Claude model the allowance also has to hold any thinking the model does, since thinking tokens are billed as output and count against `max_tokens`; the `sonnet` and `haiku` aliases therefore carry `think: false`, and the thinking share of every call is recorded as `reasoningTokens` (ADR-0013). If `spentUsd + worstCase > maxCostUsd`, it first tries to **shrink `maxOutputTokens`** to fit the remaining budget (floor: 256 tokens — below that a structured contribution can't be valid). If it still doesn't fit, the call is skipped and the round ends; if no call in the round can run, the run terminates with `budget_cost`.
3. **Parallel calls** each reserve before dispatch, so two agents can't both spend the last 10 cents.
4. **After each call:** actual cost from returned usage replaces the reservation.
5. **Estimate drift is visible, not silent:** every trace records the estimate (`chars`, `charsPerToken`, `tokens`) next to the actual prompt tokens (input + cache read + cache write). When the actual exceeds the estimate by more than 20 %, the controller logs a warning naming both numbers. The first real run (2026-11-09, `cheap` profile) measured actual ÷ estimate at 1.3–1.5 for Claude Haiku on board-heavy prompts and 0.6–1.1 for the local Qwen model: one constant of 3 characters per token undershot Claude's tokenizer on UUID-dense text. That is why the figure is now per model and calibrated, and why agents reference entries by short handles rather than UUIDs. The cap is also protected by the output allowance, which dominates the worst case.

Only cost is reserved per call. The token budget (`maxTokens`) is checked before each round, like rounds and wall-clock, so a run can overshoot it by at most one round of calls.

### Local context guard

A local model costs nothing, so what its estimate protects is the context window: Ollama silently drops the start of a prompt longer than `num_ctx`, which is where the role instructions and the problem are. The Ollama adapter therefore refuses a call before it is sent when

> estimated prompt tokens + `maxOutputTokens` + thinking allowance > `num_ctx`

with the estimate of point 2 at the model's `charsPerToken` (3.0 by default, deliberately conservative), a thinking allowance of 8 192 tokens for an alias with `think: true` and none otherwise, and `num_ctx` 32 768 unless the alias sets `numCtx`. This covers every call that reaches Ollama through the adapter, repair attempts and a local fallback included.

A refusal is an `invalid_request` (§4) whose message names each term of the sum. It is traced, not retried and not sent to the fallback; the agent contributes nothing that round and the run goes on, with the reason on the event log as `agent_failed`. The board view is **not** trimmed to make a prompt fit: its bounds (`RunConfig.view`) are fixed per run, and at their defaults the largest prompt of the recorded twelve-round run (`fixtures/runs/2026-11-09-cheap-release-process`) was about 25 000 characters, some 8–9 thousand estimated tokens with its schema, so the guard is reached only by an oversized problem statement or human note (both always shown in full), raised bounds, or a small `numCtx`. An agent refused for that reason is refused again each round, and the run then ends as `stalled`.

Why reservation and not just a post-hoc check: a post-hoc check lets the last call overshoot by a whole call's cost, which on Sonnet with a large board view can be several cents — a meaningful fraction of a $0.25 cap.

### Cost accounting

- Every provider call returns `usage`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`. All four are stored.
- `packages/providers/pricing.ts` holds a **price table** keyed by model id with an `asOf` date. It must support **tiered pricing by prompt length** (Haiku 5.5 charges five times more above 100K input tokens) and separate cache-read / cache-write rates. Local models have zero cost but their tokens are still recorded.
- Prices are data, not code: core receives a `PriceTable` and computes cost with a pure function. Cost is computed once in the provider layer and recorded on the `model_calls` trace; core reads it back through the ledger.
- `pnpm solve` and the server log a **warning if the price table is more than 90 days old**. Not a failing test — a stale date must never break CI — but visible.

---

## 3. Monthly budget (host)

```ts
interface SpendLedger {
  spentUsd(period: { start: string; end: string }): Promise<number>; // ISO-8601, end exclusive
}
interface PeriodBudget {
  limitUsd: number;         // MONTHLY_BUDGET_USD, default 5.00
  warnAtFraction: number;   // default 0.8
  timezone: string;         // default Australia/Sydney; calendar month boundaries
  ledger: SpendLedger;
}
```

- `SpendLedger` is an **interface defined in core**, implemented by the host. Core never touches storage. Period bounds are ISO-8601 strings (dates are strings at boundaries), `end` exclusive.
- **One ledger per machine (ADR-0010):** the ledger is `SELECT SUM(cost_usd) FROM model_calls WHERE billing = 'api' AND at >= :start AND at < :end` over the SQLite database named by `DATABASE_URL` (default `data/team.db`). The CLI, the server and `pnpm test:llm` all record every model call there, so there is exactly one month-to-date figure. Phase 2's append-only `data/spend.jsonl` was imported once with `pnpm ledger:import` and is no longer written.
- **Before starting a run** on a paid profile: refuse if `spentThisMonth + run.maxCostUsd > limitUsd`. The message says how much is left and what cap would fit. The `dev` profile is never refused — it spends nothing.
- **Before each round:** re-read the ledger. If `spentThisMonth >= limitUsd`, the run **pauses** (not fails) with reason `monthly_budget`; it can be resumed next month or after the limit is raised. If spend crosses `warnAtFraction`, emit a `budget_warning` event once per run.
- Month boundaries are calendar months in `timezone`. This won't match the Console's reset to the minute; the Console limit is the backstop for that gap.

---

## 4. Provider errors: classify, don't retry blindly

The provider layer maps every failure to a typed `ProviderError`:

| `kind` | Examples | Controller behaviour |
|---|---|---|
| `billing` | credit balance too low, Console spend limit reached | Run → `failed`, reason `billing`. **No retry, no fallback** to another paid model. The message tells the user which layer stopped it. |
| `auth` | 401, invalid or revoked key | Run → `failed`, reason `auth`. No retry. |
| `rate_limit` | 429 | Exponential backoff, max 3 attempts, then run → `paused` with reason `rate_limit` (resumable). |
| `overloaded` | 529, 5xx | Same as `rate_limit`. |
| `invalid_request` | 400 other than billing | The call fails; the agent's contribution is discarded and logged; the run continues. |
| `network` | timeout, DNS, Ollama unreachable | Backoff ×3, then `paused` with reason `provider_unreachable`. For the local provider this is the common case when the Mac mini is asleep. |
| `schema` | output failed Zod validation after repair | Profile fallback if any, else discard and log. Never counts as a provider error for retry purposes. |

`billing` and `auth` are **terminal** because retrying them can only waste time, and falling back from Sonnet to Haiku on a billing error would be exactly the kind of silent spend the guardrails exist to prevent.

---

## 5. Visibility and confirmation

- **CLI:** before a paid-profile run, print profile, resolved models, per-run cap, month-to-date spend vs limit, then require `--yes` or an interactive confirmation.
- **Web UI (Phase 4):** the start-run dialog shows the same; the cost meter shows run spend vs cap **and** month spend vs limit, turning amber at 80 % and red at 100 %. As built: the dialog lists the resolved model of every role and of the fallback, each marked free or paid; a paid profile needs a ticked confirmation that names the cap, and a cap the month cannot absorb is refused in the dialog with the cap that would fit (the same arithmetic as the server, which stays the authority and whose refusal is shown if the two ever differ). The month gauge turns amber at `warnAtFraction` from `GET /budget`, the run gauge at 80 %; each gauge also states its level in words and in its accessible value, so the colour never carries it alone. Rounds, tokens and wall-clock are shown against their limits beside the two cost gauges.
- **Run record:** stores the budget snapshot, the profile, resolved models, final spend, and the termination reason.
- **Reasons are an enum** shared by core, API and UI: `completed`, `budget_cost`, `budget_rounds`, `budget_tokens`, `budget_time`, `monthly_budget`, `stalled`, `no_eligible_agents`, `billing`, `auth`, `rate_limit`, `provider_unreachable`, `user_paused`, `interrupted`, `user_stopped`. Statuses are `completed`, `failed`, `paused` and `stopped`: `billing` and `auth` end a run as `failed`; `monthly_budget`, `rate_limit`, `provider_unreachable`, `user_paused` (the user asked) and `interrupted` (the host died mid-run and found the run still marked running when it came back; a round it left in flight is recorded as `round_abandoned` and counts as used, with the usage of whatever it had committed) leave it `paused`; `user_stopped` ends it as `stopped`; every other reason, budget stops included, ends it as `completed`. A paused run resumes from its own event log (`run_resumed` event), in the same process or a later one; its wall-clock budget does not run while it is paused.

---

## 6. Defaults

| Setting | Default | Where |
|---|---|---|
| `defaultProfile` | `dev` | `agents.yaml` |
| `maxCostUsd` | `0.25` | run config |
| `MONTHLY_BUDGET_USD` | `5.00` | `.env` |
| `warnAtFraction` | `0.8` | run config |
| Reservation floor | 256 output tokens | core constant |
| Chars per token | 2.0 Anthropic, 3.0 Ollama, 3 fakes; `charsPerToken` on an alias overrides | provider constants, `agents.yaml` |
| Calibration (API models) | last 50 traces, pooled chars ÷ tokens, ÷ 1.15, at least 5 samples, clamped 1–8 | core `calibrateCharsPerToken`; samples from the host's `model_calls` |
| Schema size in the estimate | serialised JSON schema characters; 3 000 when it cannot be rendered | core `schemaChars` |
| Estimate undershoot warning | actual prompt tokens > 1.2 × estimate | core constant |
| Retry attempts (rate limit / overload / network) | 3, exponential from 1 s | provider config |

---

## 7. Tests (all core tests use `FakeModel` and a fake ledger — no network)

- Cost from usage × price table: plain, cached, and Haiku's over-100K tier; local models cost zero but record tokens.
- Reservation shrinks `maxOutputTokens` to fit remaining budget; skips the call below the 256 floor; terminates the run with `budget_cost` when no call fits.
- Two parallel calls can't jointly exceed the cap.
- Monthly: run refused when `spent + cap > limit`; run pauses with `monthly_budget` when the fake ledger crosses the limit mid-run; `budget_warning` emitted once at 80 %.
- `dev` profile: every role resolves local, fallback `none`; a `dev`-like profile with a paid fallback is rejected at load.
- Error classification: `billing` → `failed`, zero retries, no fallback call recorded; `rate_limit` → three attempts then `paused`; `schema` → fallback per profile.
- Snapshot the CLI confirmation banner.
- Estimate undershoot: a model reporting more than 1.2 × the estimated prompt tokens makes the controller log a warning; a smaller overshoot does not.

---

## 8. Phase mapping

- **Phase 2 (done 2026-11-09):** profiles and loader validation; `RunBudget` with reservation; price table; usage capture incl. cache tokens; `ProviderError` classification; `SpendLedger` interface in core with the JSONL implementation; CLI banner and `--profile` / `--yes`.
- **Phase 2 hardening (2026-11-09):** per-model `charsPerToken` with the schema counted; calibration arithmetic in core; agents link by handle so prompts carry no UUIDs.
- **Phase 3 (done 2026-11-09):** `SpendLedger` backed by `model_calls` in the shared database, which the CLI and the contract tests write too (ADR-0010); calibration samples read from `model_calls`; `profile` on `POST /runs`, refused with the fits-cap figure when the month cannot absorb the run; `monthly_budget` and the other pauses resumed through `POST /runs/:id/resume`, from the event log if the process that paused the run is gone.
- **Phase 4 (done 2026-11-10):** cost meter with both gauges; start-run dialog; the reason shown on every run that is not running, in the run list and the run header (labels exhaustive over the reason enum, so a new reason does not compile without one); the local context guard written down (§2) and its refusal naming the thinking allowance. In the server's `--fake` mode a stand-in carries the price of the model it stands in for, so a paid profile moves the run gauge, while its calls are traced as `fake` and never reach the month's ledger.

Suggested line for the Phase 2 kick-off prompt:

> Implement `docs/budget-guardrails.md` as part of Phase 2 (sections 1, 2, 4, 5 and the Phase 2 items in section 8), add its items to the Phase 2 checklist in `docs/PLAN.md`, and record the profile/fallback design as ADR-0009.

---

## 9. Eval pass cap (Phase 5)

An eval pass (`pnpm eval`, ADR-0012) spends on three kinds of call: the swarm runs, one baseline call per problem, and one judge call per problem per order. All three go through the same traced models and the same `model_calls` ledger as everything else; the baseline and judge calls carry `runId` `eval:<pass id>` and the roles `eval-baseline` and `eval-judge`.

- **The pass cap** (`--max-cost`, default $1.00) is a hard limit over the whole pass, kept in code by a sequential ledger (`PassBudget`): each call is charged its actual cost when it returns, and before each call the harness checks the worst case fits what is left.
- **Each swarm run** gets `maxCostUsd = min(--run-cap, remaining)` (default run cap $0.03, ADR-0013), and the controller enforces it as in §2.
- **The baseline call** is capped at the same run cap, less what the pass has left if that is smaller (equal budget means the same cap for both arms, ADR-0013), and sized with the §2 arithmetic: the output allowance shrinks to fit, the prompt states the words that allowance buys, and below the 256-token floor the call is skipped and the report says so. An answer that still uses its whole allowance is kept and reported as truncated.
- **A judge call** is sized the same way against the pass's remainder; a call that does not fit is skipped with a reason and the pair goes unjudged.
- **The month** is re-read from the ledger before each problem; a spent month stops the pass before the next problem, with a partial report. A paid pass is refused up front when `spentThisMonth + passCap > limitUsd`, with the cap that would fit, and needs `--yes` or a yes at the prompt. `--fake` passes bill nothing and never touch the month.
- **Cached baselines** are not charged; the report says when a cached baseline's cap no longer matches the swarm's current cost.
