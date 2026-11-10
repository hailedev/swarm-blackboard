# Eval pass: dev-rehearsal

- Pass id: `01a1c3e0-93e5-788f-8f83-d9c109a3f12e`
- Started: 2026-11-10T05:13:57.477Z; ended: 2026-11-10T05:27:09.939Z
- Controller commit: `953659b`
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
| Mean rubric score | 80.3% | 78.5% |
| Judged pairs | 2 of 2 | |
| Wins / ties / losses (swarm) | 1 / 1 / 0 | |
| Mean delta (swarm − baseline) | +1.8 points | |
| Judge consistency (spread between orders) | 14.7 points | |
| First-shown answer preferred | 3 of 4 decided judgements | |

With 2 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. The swarm's spend includes every traced call of its runs; the baseline's cap was each run's cost.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mobile-release-cadence | `01a1c3e0-93e6-7c0e-b97b-10f06e92f102` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 3672/4096 (2600 words) | 86.9% | 75.0% | +11.9 | swarm |  |
| local-first-sync | `01a1c3e6-45a5-7a38-b32c-1ef5f9761f9a` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 1982/4096 (2600 words) | 73.6% | 81.9% | -8.3 | tie |  |

## Pairs written out

- `pairs/mobile-release-cadence.md` — the swarm's widest win
- `pairs/local-first-sync.md` — the baseline's widest win
