# Eval pass: step2a-dev-rehearsal

- Pass id: `01a1e1bd-fd31-76e7-86b9-e1c3fe24d138`
- Started: 2026-11-16T00:24:47.154Z; ended: 2026-11-16T00:42:01.292Z
- Controller commit: `7d2a2b0`
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
- Spent: $0.0000 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 76.4% | 67.7% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 1 / 1 / 1 | |
| Mean delta (swarm − baseline) | +8.7 points | |
| Judge consistency (spread between orders) | 21.7 points | |
| First-shown answer preferred | 2 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e1be-5687-7964-8302-5a90f7c5da94` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 17625 / 0 of 1532 / 0 of 1353 | 79.2% | 79.2% | +0.0 | tie |  |
| oidc-migration | `01a1e1c4-310f-7d08-9974-84458f01d9ad` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 11991 / 0 of 2113 / 0 of 1623 | 66.7% | 83.3% | -16.7 | baseline |  |
| teen-reading-programme | `01a1e1c7-d39b-710a-944c-c7720b3a40a8` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 19518 / 0 of 207 / 0 of 1456 | 83.3% | 40.5% | +42.9 | swarm |  |

Thinking tokens, as a share of output tokens: swarm 0 of 49134, baseline 0 of 3852 (uncached calls only), judge 0 of 4432.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 496 / 1350 | $0.0000 | 1203 / 1350 | complete |
| oidc-migration | final write-up | 727 / 1350 | $0.0000 | 1680 / 1350 | complete |
| teen-reading-programme | final write-up | 956 / 1350 | $0.0000 | 168 / 1350 | complete |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **client** (weight 1; order A = swarm): swarm 1, baseline 3. Answer A describes standard rate limit headers but incorrectly suggests omitting them during outages, which fails to address how a client learns their limit reliably or handles retries effectively during failure, missing key aspects of the '3' anchor regarding burst advice.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
- `pairs/api-rate-limiting.md` — the closest call
