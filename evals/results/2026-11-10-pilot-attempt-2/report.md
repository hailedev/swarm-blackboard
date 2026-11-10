# Eval pass: pilot

- Pass id: `01a1c400-2fd2-723f-a95d-4f2b56150a97`
- Started: 2026-11-10T05:48:29.010Z; ended: 2026-11-10T06:05:37.576Z
- Controller commit: `8a43767`
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
- Spent: $0.2030 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 81.0% | 42.9% |
| Judged pairs | 1 of 3 | |
| Wins / ties / losses (swarm) | 1 / 0 / 0 | |
| Mean delta (swarm − baseline) | +38.1 points | |
| Judge consistency (spread between orders) | — | |
| First-shown answer preferred | 1 of 1 decided judgements | |

With 1 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1c400-2fd3-770d-8778-888bb1f86248` | 12 | completed/budget_rounds | $0.0216 | — | — | — | 0.0% | — | — | baseline skipped: truncated: the answer used its whole allowance of 1814 output tokens and not one paragraph was finished; judge: no baseline answer |
| oidc-migration | `01a1c405-7d66-79e1-bc1d-79cb2bd77099` | 12 | completed/budget_rounds | $0.0258 | — | — | — | 0.0% | — | — | baseline skipped: truncated: the answer used its whole allowance of 2236 output tokens and not one paragraph was finished; judge: no baseline answer |
| teen-reading-programme | `01a1c40a-f90f-7b03-9eaf-31ff9f281d43` | 12 | completed/budget_rounds | $0.0280 | $0.0280 → $0.0267 | 2464/2464 (1250 words) **truncated** | 81.0% | 42.9% | +38.1 | swarm | judge: order baseline/swarm: invalid_output; baseline truncated at its allowance |

## Notes

- 1 baseline answer used the whole output allowance (teen-reading-programme) and probably lost its ending; the judge scored what arrived.
- Some pairs were not judged for the reason in their row; the means cover judged pairs only.
- 1 pair was judged in one order only, so their consistency figure is missing.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
