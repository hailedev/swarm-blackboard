# Budget guardrails

**Status:** Phase 2 parts implemented on 2026-11-09 (profiles, per-run cap, pricing, error classification, JSONL ledger, CLI banner); Phase 3 (ledger over `model_calls`) pending. Where the implementation deviates from the original spec, this document describes what was built. Referenced from `docs/PLAN.md`.

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
  sonnet: { provider: anthropic, model: claude-sonnet-5-5 }
  haiku:  { provider: anthropic, model: claude-haiku-5-5 }
  local:  { provider: ollama, model: qwen3.6:35b-mlx, think: false }
  local-think: { provider: ollama, model: qwen3.6:35b-mlx, think: true }

profiles:
  dev:                         # zero API spend; the default
    fallback: none             # schema failure → repair once → discard and log
    roles:
      planner: local
      researcher: local
      solver: local-think
      critic: local
      synthesizer: local
      bidder: local
  cheap:                       # ~1–2 cents per run
    fallback: haiku
    roles:
      planner: haiku
      researcher: local
      solver: local-think
      critic: haiku
      synthesizer: haiku
      bidder: haiku
  quality:                     # ~15–25 cents per run
    fallback: haiku
    roles:
      planner: haiku
      researcher: local
      solver: local-think
      critic: sonnet
      synthesizer: sonnet
      bidder: haiku

agents:
  planner:     { prompt: prompts/planner.md }
  researcher:  { prompt: prompts/researcher.md }
  solver:      { prompt: prompts/solver.md }
  critic:      { prompt: prompts/critic.md }
  synthesizer: { prompt: prompts/synthesizer.md }
```

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
2. **Before each model call — reservation:** the controller estimates the prompt's input tokens as ⌈(system + prompt characters) / 3⌉ + 1 000, a flat allowance for the JSON schema the provider receives; there is no provider count-tokens call. With the call's `maxOutputTokens` it computes the worst-case cost of the call. If `spentUsd + worstCase > maxCostUsd`, it first tries to **shrink `maxOutputTokens`** to fit the remaining budget (floor: 256 tokens — below that a structured contribution can't be valid). If it still doesn't fit, the call is skipped and the round ends; if no call in the round can run, the run terminates with `budget_cost`.
3. **Parallel calls** each reserve before dispatch, so two agents can't both spend the last 10 cents.
4. **After each call:** actual cost from returned usage replaces the reservation.
5. **Estimate drift is visible, not silent:** every trace records the estimated input tokens next to the actual prompt tokens (input + cache read + cache write). When the actual exceeds the estimate by more than 20 %, the controller logs a warning naming both numbers. The first real run (2026-11-09, `cheap` profile) measured actual ÷ estimate at 1.3–1.5 for Claude Haiku on board-heavy prompts and 0.6–1.1 for the local Qwen model: the 3-characters-per-token assumption undershoots Claude's tokenizer on UUID-dense text. Retuning the constant is a follow-up; the cap is still protected by the output allowance, which dominates the worst case.

Only cost is reserved per call. The token budget (`maxTokens`) is checked before each round, like rounds and wall-clock, so a run can overshoot it by at most one round of calls.

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
- **Phase 2 (CLI):** the ledger is an append-only `data/spend.jsonl` — one line per paid call: timestamp, model, tokens, cost. Sum for the period.
- **Phase 3 (server):** the ledger is `SELECT SUM(cost_usd) FROM model_calls WHERE billing = 'api' AND created_at >= :start`. Same interface, so core and its tests don't change.
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
- **Web UI (Phase 4):** the start-run dialog shows the same; the cost meter shows run spend vs cap **and** month spend vs limit, turning amber at 80 % and red at 100 %.
- **Run record:** stores the budget snapshot, the profile, resolved models, final spend, and the termination reason.
- **Reasons are an enum** shared by core, API and UI: `completed`, `budget_cost`, `budget_rounds`, `budget_tokens`, `budget_time`, `monthly_budget`, `stalled`, `no_eligible_agents`, `billing`, `auth`, `rate_limit`, `provider_unreachable`, `user_stopped`. Statuses are `completed`, `failed`, `paused` and `stopped`: `billing` and `auth` end a run as `failed`; `monthly_budget`, `rate_limit` and `provider_unreachable` leave it `paused`; `user_stopped` ends it as `stopped`; every other reason, budget stops included, ends it as `completed`.

---

## 6. Defaults

| Setting | Default | Where |
|---|---|---|
| `defaultProfile` | `dev` | `agents.yaml` |
| `maxCostUsd` | `0.25` | run config |
| `MONTHLY_BUDGET_USD` | `5.00` | `.env` |
| `warnAtFraction` | `0.8` | run config |
| Reservation floor | 256 output tokens | core constant |
| Input-token estimate | 3 characters per token + 1 000 schema tokens | core constants |
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
- **Phase 3:** `SpendLedger` backed by `model_calls`; `profile` on `POST /runs`; `monthly_budget` pause/resume through the API.
- **Phase 4:** cost meter with both gauges; start-run dialog.

Suggested line for the Phase 2 kick-off prompt:

> Implement `docs/budget-guardrails.md` as part of Phase 2 (sections 1, 2, 4, 5 and the Phase 2 items in section 8), add its items to the Phase 2 checklist in `docs/PLAN.md`, and record the profile/fallback design as ADR-0009.
