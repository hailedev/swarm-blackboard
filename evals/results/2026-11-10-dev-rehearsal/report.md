# Eval pass: dev-rehearsal

- Pass id: `01a1c3a3-3329-7736-8508-4e154ee6e69b`
- Started: 2026-11-10T04:06:55.017Z; ended: 2026-11-10T04:16:50.134Z
- Controller commit: `538a51e`
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
| Mean rubric score | 74.3% | 83.3% |
| Judged pairs | 2 of 2 | |
| Wins / ties / losses (swarm) | 0 / 1 / 1 | |
| Mean delta (swarm − baseline) | -9.0 points | |
| Judge consistency (spread between orders) | 18.8 points | |
| First-shown answer preferred | 3 of 4 decided judgements | |

With 2 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| mobile-release-cadence | `01a1c3a3-3329-7707-9468-42786eae2c39` | 8 | completed/completed | $0.0000 | $0.0000 → $0.0000 | 73.6% | 94.4% | -20.8 | baseline |  |
| local-first-sync | `01a1c3a6-ae1a-7a0a-9973-580a9e4f22f0` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 75.0% | 72.2% | +2.8 | tie |  |

## Pairs written out

- `pairs/local-first-sync.md` — the swarm's widest win
- `pairs/mobile-release-cadence.md` — the baseline's widest win
