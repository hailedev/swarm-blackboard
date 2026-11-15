# Eval pass: pilot-3

- Pass id: `01a1e15e-7463-752e-884a-c81e1115cf03`
- Started: 2026-11-15T22:40:26.211Z; ended: 2026-11-15T22:56:05.883Z
- Controller commit: `7ca9902`
- Swarm profile: `cheap`
  - planner: `haiku` (anthropic/claude-haiku-5-5)
  - researcher: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - solver: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - critic: `haiku` (anthropic/claude-haiku-5-5)
  - synthesizer: `haiku` (anthropic/claude-haiku-5-5)
  - fallback: `haiku`
- Baseline: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Judge: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Caps: pass $0.3000; each swarm run and each baseline call capped at $0.0300, the same budget for both arms
- Judging: both orders per pair; blind to the arm
- Spent: $0.2791 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 55.9% | 85.4% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 0 / 0 / 3 | |
| Mean delta (swarm − baseline) | -29.6 points | |
| Judge consistency (spread between orders) | 9.0 points | |
| First-shown answer preferred | 3 of 5 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e15e-7464-723c-aac7-d287740ec0b9` | 12 | completed/budget_rounds | $0.0297 | $0.0300 → $0.0289 | 2681/2681 (1350 words) **truncated** | 0 of 34362 / 0 of 2681 / 0 of 2023 | 65.3% | 94.4% | -29.2 | baseline | baseline truncated at its allowance |
| oidc-migration | `01a1e163-b288-7903-9abe-cd775f1dd76d` | 12 | completed/budget_rounds | $0.0225 | $0.0300 → $0.0289 | 2689/2689 (1350 words) **truncated** | 0 of 27881 / 0 of 2689 / 0 of 2430 | 50.0% | 73.8% | -23.8 | baseline | baseline truncated at its allowance |
| teen-reading-programme | `01a1e169-9141-7ff9-b50c-51a5e4c1d637` | 12 | completed/budget_rounds | $0.0199 | $0.0300 → $0.0290 | 2696/2696 (1350 words) **truncated** | 0 of 22068 / 0 of 2696 / 0 of 1094 | 52.4% | 88.1% | -35.7 | baseline | judge: order swarm/baseline: $0.0209 left does not cover the judge call ($0.0225); baseline truncated at its allowance |

Thinking tokens, as a share of output tokens: swarm 0 of 84311, baseline 0 of 8066 (uncached calls only), judge 0 of 5547.

## Notes

- 3 baseline answers used the whole output allowance (api-rate-limiting, oidc-migration, teen-reading-programme) and probably lost their ending; the judge scored what arrived.
- 1 pair was judged in one order only, so their consistency figure is missing.

## Pairs written out

- `pairs/oidc-migration.md` — the swarm's widest win
- `pairs/teen-reading-programme.md` — the baseline's widest win
