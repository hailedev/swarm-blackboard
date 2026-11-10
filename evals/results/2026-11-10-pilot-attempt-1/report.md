# Eval pass: pilot

- Pass id: `01a1c3ed-5ee0-76a9-b0c9-9f84f8bc7e5f`
- Started: 2026-11-10T05:27:55.873Z; ended: 2026-11-10T05:45:00.733Z
- Controller commit: `32ab729`
- Swarm profile: `cheap`
  - planner: `haiku` (anthropic/claude-haiku-5-5)
  - researcher: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - solver: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - critic: `haiku` (anthropic/claude-haiku-5-5)
  - synthesizer: `haiku` (anthropic/claude-haiku-5-5)
  - fallback: `haiku`
- Baseline: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Judge: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Caps: pass $1.0000, per swarm run $0.0800; baseline capped at each swarm run's cost
- Judging: both orders per pair; blind to the arm
- Spent: $0.1414 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | — | — |
| Judged pairs | 0 of 3 | |
| Wins / ties / losses (swarm) | 0 / 0 / 0 | |
| Mean delta (swarm − baseline) | — points | |
| Judge consistency (spread between orders) | — | |
| First-shown answer preferred | 0 of 0 decided judgements | |

With 0 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1c3ed-5ee2-7654-8639-3a700df85673` | 12 | completed/budget_rounds | $0.0245 | — | — | — | 0.0% | — | — | baseline skipped: truncated: the answer used its whole allowance of 2100 output tokens and its JSON never closed; judge: no baseline answer |
| oidc-migration | `01a1c3f3-c470-728f-8ad9-b6625807b0ea` | 12 | completed/budget_rounds | $0.0231 | — | — | — | 0.0% | — | — | baseline skipped: truncated: the answer used its whole allowance of 1967 output tokens and its JSON never closed; judge: no baseline answer |
| teen-reading-programme | `01a1c3f7-3804-77db-8bb1-a110259c364e` | 12 | completed/budget_rounds | $0.0251 | — | — | — | 0.0% | — | — | baseline skipped: truncated: the answer used its whole allowance of 2179 output tokens and its JSON never closed; judge: no baseline answer |

## Notes

- Some pairs were not judged for the reason in their row; the means cover judged pairs only.

## Pairs written out

No pair was judged.
