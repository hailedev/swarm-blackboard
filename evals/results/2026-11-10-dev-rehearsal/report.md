# Eval pass: dev-rehearsal

- Pass id: `01a1c397-7eae-7298-843f-b2e60dfed824`
- Started: 2026-11-10T03:54:07.919Z; ended: 2026-11-10T04:04:57.770Z
- Controller commit: `c30ff8e`
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
| Mean rubric score | 77.8% | 8.3% |
| Judged pairs | 2 of 2 | |
| Wins / ties / losses (swarm) | 2 / 0 / 0 | |
| Mean delta (swarm − baseline) | +69.4 points | |
| Judge consistency (spread between orders) | 11.1 points | |
| First-shown answer preferred | 2 of 4 decided judgements | |

With 2 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| mobile-release-cadence | `01a1c397-7eaf-794c-ab9c-04b0ebdf9e9a` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 73.6% | 0.0% | +73.6 | swarm |  |
| local-first-sync | `01a1c39c-5d4e-727c-b377-4ada4aa2383b` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 81.9% | 16.7% | +65.3 | swarm |  |

## Pairs written out

- `pairs/mobile-release-cadence.md` — the swarm's widest win
- `pairs/local-first-sync.md` — the baseline's widest win
