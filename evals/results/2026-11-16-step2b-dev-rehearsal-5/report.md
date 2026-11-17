# Eval pass: step2b-dev-rehearsal-5

- Pass id: `01a1e6c4-b8c0-74b8-ba9e-f749a88ba7da`
- Started: 2026-11-16T23:50:14.464Z; ended: 2026-11-17T00:06:13.543Z
- Controller commit: `eb0db67`
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
| Mean rubric score | 68.5% | 61.4% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 1 / 1 / 1 | |
| Mean delta (swarm − baseline) | +7.1 points | |
| Judge consistency (spread between orders) | 6.8 points | |
| First-shown answer preferred | 4 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e6c4-b8d0-7347-bdf5-db27a588ae33` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 17009 / 0 of 1532 / 0 of 1302 | 80.6% | 90.3% | -9.7 | baseline | baseline cached |
| oidc-migration | `01a1e6c9-cf97-78ff-a9ef-71c6a718f782` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 16613 / 0 of 2113 / 0 of 1414 | 70.2% | 72.6% | -2.4 | tie | baseline cached |
| teen-reading-programme | `01a1e6ce-bff1-7b82-87d8-eee3bfb807fa` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 15208 / 0 of 207 / 0 of 1459 | 54.8% | 21.4% | +33.3 | swarm | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 48830, baseline 0 of 0 (uncached calls only), judge 0 of 4175.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft. A write-up that comes back under half the words asked for is asked for once more and the longer of the two is kept.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 687 / 1350 | $0.0000 | 1203 / 1350 | complete, cached |
| oidc-migration | final write-up | 1071 / 1350 | $0.0000 | 1680 / 1350 | complete, cached |
| teen-reading-programme | final write-up | 939 / 1350 | $0.0000 | 168 / 1350 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. A subproblem takes one answer: a hypothesis posted where one stands replaces it or is declared its rival, so the last two columns should read 0. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Rivals declared | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open | Claims that supersede nothing | Subproblems with an undeclared second answer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 12 | budget_rounds | 13 / 25 | 8 | 3 blocking, 1 major | 0 / 21 | 0 | 0 | 0 (0) | 6 | 1 / 4 / 0 | 0 | 0 |
| oidc-migration | 12 | budget_rounds | 13 / 20 | 7 | none | 0 / 22 | 1 | 0 | 0 (0) | 6 | 4 / 0 / 0 | 0 | 0 |
| teen-reading-programme | 12 | budget_rounds | 6 / 22 | 12 | 1 blocking, 3 major | 0 / 22 | 2 | 0 | 0 (0) | 5 | 0 / 4 / 0 | 0 | 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. The answer contains a significant mathematical error regarding the maximum inaccuracy (claiming 3x instead of 2x), which undermines the technical validity of the state design description.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 1, baseline 2. It describes session invalidation via versioning, but the logic of invalidating all sessions when *any* user logs in is flawed and insecure (a shared session problem).
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 3. The claim that logging in as one user invalidates another's session via a global version increment is technically incorrect for standard OIDC/session implementations and represents a material error in design.
- `teen-reading-programme` · **feasibility** (weight 2; order A = swarm): swarm 0, baseline 1. The answer explicitly contradicts the constraint by stating the librarian spends 15 hours per week, while claiming it fits a four-hour weekly constraint.
- `teen-reading-programme` · **correctness** (weight 2; order A = swarm): swarm 0, baseline 2. It contains material errors regarding feasibility (claiming 15 hours fits in 4) and budget realism (3D printing services out of $150 total for hardware/software/snacks is highly unlikely/impossible for a branch library).
- `teen-reading-programme` · **feasibility** (weight 2; order A = baseline): swarm 0, baseline 2. The answer explicitly states the librarian spends 15 hours per week (2 hours session + 13 hours prep), which directly violates the four-hour weekly constraint.
- `teen-reading-programme` · **correctness** (weight 2; order A = baseline): swarm 0, baseline 1. The claim that a librarian can provide 15 hours of work per week within a four-hour limit is a material error regarding feasibility constraints.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/api-rate-limiting.md` — the baseline's widest win
- `pairs/oidc-migration.md` — the closest call
