# Eval pass: dev-rehearsal

- Pass id: `01a1c3d5-4ef5-77b0-a9c3-ae6835c7efd3`
- Started: 2026-11-10T05:01:38.933Z; ended: 2026-11-10T05:12:31.762Z
- Controller commit: `d3841b3`
- Swarm profile: `dev`
  - planner: `local-fast` (ollama/qwen3.6:35b-mlx)
  - researcher: `local-fast` (ollama/qwen3.6:35b-mlx)
  - solver: `local-fast` (ollama/qwen3.6:35b-mlx)
  - critic: `local-fast` (ollama/qwen3.6:35b-mlx)
  - synthesizer: `local-fast` (ollama/qwen3.6:35b-mlx)
  - fallback: none
- Baseline: `local-fast` (ollama/qwen3.6:35b-mlx) → qwen3.6:35b-mlx
- Judge: `local-fast` (ollama/qwen3.6:35b-mlx) → qwen3.6:35b-mlx
- Caps: pass $1.0000, per swarm run $0.0800; baseline capped at each swarm run's cost
- Judging: both orders per pair; blind to the arm
- Spent: $0.0000 over 2 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 87.5% | 44.9% |
| Judged pairs | 2 of 2 | |
| Wins / ties / losses (swarm) | 2 / 0 / 0 | |
| Mean delta (swarm − baseline) | +42.6 points | |
| Judge consistency (spread between orders) | 5.7 points | |
| First-shown answer preferred | 2 of 4 decided judgements | |

With 2 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mobile-release-cadence | `01a1c3d5-4ef6-7bc9-b88d-d13aa32b45a8` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 318/4096 (2600 words) | 91.7% | 44.0% | +47.6 | swarm |  |
| local-first-sync | `01a1c3da-17f6-7416-a149-ac450ab80a88` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 231/4096 (2600 words) | 83.3% | 45.8% | +37.5 | swarm |  |

## Pairs written out

- `pairs/mobile-release-cadence.md` — the swarm's widest win
- `pairs/local-first-sync.md` — the baseline's widest win
