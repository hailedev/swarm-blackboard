# Eval pass: dev-rehearsal

- Pass id: `01a1c45c-437f-705a-93e8-468b454663cb`
- Started: 2026-11-10T07:29:03.359Z; ended: 2026-11-10T07:39:25.910Z
- Controller commit: `5e2db43`
- Swarm profile: `dev`
  - planner: `local-fast` (ollama/qwen3.6:35b-mlx)
  - researcher: `local-fast` (ollama/qwen3.6:35b-mlx)
  - solver: `local-fast` (ollama/qwen3.6:35b-mlx)
  - critic: `local-fast` (ollama/qwen3.6:35b-mlx)
  - synthesizer: `local-fast` (ollama/qwen3.6:35b-mlx)
  - fallback: none
- Baseline: `local-fast` (ollama/qwen3.6:35b-mlx) → qwen3.6:35b-mlx
- Judge: `local-fast` (ollama/qwen3.6:35b-mlx) → qwen3.6:35b-mlx
- Caps: pass $1.0000; each swarm run and each baseline call capped at $0.0300, the same budget for both arms
- Judging: both orders per pair; blind to the arm
- Spent: $0.0000 over 2 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 49.9% | 72.4% |
| Judged pairs | 2 of 2 | |
| Wins / ties / losses (swarm) | 0 / 1 / 1 | |
| Mean delta (swarm − baseline) | -22.5 points | |
| Judge consistency (spread between orders) | 29.7 points | |
| First-shown answer preferred | 3 of 4 decided judgements | |

With 2 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mobile-release-cadence | `01a1c45c-4380-70a3-b376-1621b68637bd` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 3672/4096 (2600 words) | 0 of 13054 / 0 of 3672 / 0 of 1569 | 51.2% | 81.0% | -29.8 | baseline | baseline cached |
| local-first-sync | `01a1c460-56df-753c-9683-e1cee3434289` | 12 | completed/budget_rounds | $0.0000 | $0.0000 → $0.0000 | 1982/4096 (2600 words) | 0 of 18364 / 0 of 1982 / 0 of 1490 | 48.6% | 63.9% | -15.3 | tie | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 31418, baseline 0 of 0 (uncached calls only), judge 0 of 3059.

## Notes

- `mobile-release-cadence`: the cached baseline was capped at $0.0000 (about 2600 words) on an earlier pass; this pass's cap is $0.0300, so the arms did not share one budget. Pass `--refresh-baselines` to redo it.
- `local-first-sync`: the cached baseline was capped at $0.0000 (about 2600 words) on an earlier pass; this pass's cap is $0.0300, so the arms did not share one budget. Pass `--refresh-baselines` to redo it.

## Pairs written out

- `pairs/local-first-sync.md` — the swarm's widest win
- `pairs/mobile-release-cadence.md` — the baseline's widest win
