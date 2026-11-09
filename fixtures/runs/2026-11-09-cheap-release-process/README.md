# Recorded run: release process for a four-person Node team (cheap profile)

The first end-to-end run on real models, recorded as the Phase 2 definition of done
(docs/PLAN.md) and kept as a replay and UI fixture.

- **Date:** 2026-11-09
- **Problem:** "A four-person team ships a Node service whose deploys burn about 3 % of the
  monthly error budget each time. How should they change their release process to stop
  regressions without dropping below weekly releases?"
- **Command:** `pnpm solve "<problem>" --profile cheap --yes --trace … --json …`
- **Profile `cheap`:** planner, critic, synthesizer and fallback on `claude-haiku-5-5`;
  researcher and solver on `qwen3.6:35b-a3b-q8_0` (Ollama 0.40.15, thinking off); see
  ADR-0008 and ADR-0009.
- **Outcome:** `budget_rounds` after 12 rounds, 96 entries, 23 model calls, every one valid
  on the first attempt (no repair, no fallback), 197 201 tokens, $0.0238, 468 s. Four
  synthesis versions from round 8 on; the last at confidence 0.6, below the 0.8 threshold,
  so the run ended on the round cap rather than on completion. The answer recommends an
  automated canary with rollback and lists six open issues.

## Files

- `events.json`: every board event, `run_started` first (config, profile and resolved
  models), `run_terminated` last. Folding the `entry_committed` events reproduces the board.
- `trace.jsonl`: one model call per line: prompt, response, usage, cost, latency, the
  reservation estimate next to the actual prompt tokens, provider warnings.

## Notes

- A first attempt the same day ended after 12 rounds with 40 hypotheses and no synthesis:
  a contradiction in round 5 set `decisionRequired`, nothing posts decisions until Phase 5,
  and the Synthesizer's trigger checked that flag before the round rule. Fixed in core
  before this run (commit "fix(core): the synthesis round rule overrides the decision gate").
- Eleven of the twelve Haiku calls reported 30–47 % more prompt tokens than the reservation
  estimated (`[warn] input token estimate undershot…` lines); the local model stayed within
  10 %. Recorded in docs/budget-guardrails.md §2 as a follow-up.
