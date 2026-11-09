# ADR-0009: Choose models through profiles, with the fallback a profile property

- **Status:** accepted
- **Date:** 2026-11-09
- **Amended:** 2026-11-09, dependency note in Consequences (the subset YAML reader gave way to the `yaml` package)

## Context

ADR-0006 assigned a provider and model per role in `agents.yaml` and had every local role declare its own `fallback: anthropic` for schema failures. Two things have changed since. The monthly API budget is small (about $5, `docs/budget-guardrails.md`), so a run that quietly reaches a paid model is a real cost rather than a nuisance. And day-to-day development needs a configuration that cannot spend anything at all. With per-role fallbacks, a "local only" roster is one forgotten `fallback:` away from billing, and moving the whole roster between a cheap and a quality configuration meant editing five lines.

## Decision

`agents.yaml` gains **profiles**. Agents (prompt, trigger, output schema) are defined once; a profile maps every role to a model alias and names one fallback model for the whole profile, or `none`.

- `defaultProfile` is `dev`: every role local, `fallback: none`. A paid profile is always an explicit choice per run (`pnpm solve "…" --profile quality`; `profile` on `POST /runs` in Phase 3).
- **Fallback is a profile property, not a role property.** The loader rejects a profile whose every role is local but whose fallback resolves to a paid provider: that configuration is almost certainly a mistake, and it is the one that would bill by accident.
- Validation happens at load time, in core: every role in every profile resolves to a known alias, the default profile exists, and an unknown profile name is rejected with the valid names listed.
- The run record stores the profile name **and** the resolved provider/model for every role, so traces and evals stay reproducible after `agents.yaml` changes.
- The malformed-output path keeps its shape: validate → one repair attempt on the same model → the profile's fallback → discard and log. Provider errors (billing, auth, rate limits, network) never take this path; they are classified by the provider layer and decided by the controller.
- Per-role model assignment and the hybrid default of ADR-0006 stand: in the paid profiles the steering roles run on Claude and the worker roles run locally.

## Consequences

- `+` The `dev` profile cannot spend, and the loader enforces it; no prompt or env var has to be trusted.
- `+` One word switches the whole roster. Eval A/Bs are profile names, not edited files.
- `+` Runs are reproducible: the event log carries the models that actually ran.
- `+` The file shape already names the Phase 5 bidder, so the roster does not change shape when it arrives.
- `−` A fallback cannot differ per role (say, Sonnet only when the Critic fails). Acceptable: that is a role choice, so make it one in the profile.
- `−` Every profile must list every role; adding a role touches every profile. The loader reports the omission, so it cannot go unnoticed.
- `−` Reading `agents.yaml` needs a YAML parser. The CLI first shipped a strict subset reader to avoid a dependency; on 2026-11-09 Hai approved the `yaml` package (pinned 2.9.1) and the subset reader was deleted, so the file may use any YAML the package accepts. The roster rules themselves are still validated in core.

## Alternatives considered

- **Per-role fallback as in ADR-0006** — rejected: a local roster can reach a paid model by accident, and there is no way to say "never spend".
- **Environment-variable overrides** (`PLANNER_MODEL=…`) — rejected: invisible in version control, not reproducible, and nothing validates the combination at load time.
- **One roster file per environment** (`agents.dev.yaml`, `agents.quality.yaml`) — rejected: duplicates the agent definitions and lets the files drift.
- **A `paid: false` switch on the run** — rejected: a boolean does not say which models to use instead; profiles subsume it.
