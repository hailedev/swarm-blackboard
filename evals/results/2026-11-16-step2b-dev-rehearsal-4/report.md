# Eval pass: step2b-dev-rehearsal-4

- Pass id: `01a1e2e0-08ef-7538-82c4-d9c4f396a826`
- Started: 2026-11-16T05:41:35.599Z; ended: 2026-11-16T05:51:29.404Z
- Controller commit: `72e20dd`
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
| Mean rubric score | 50.8% | 57.9% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 1 / 0 / 2 | |
| Mean delta (swarm − baseline) | -7.1 points | |
| Judge consistency (spread between orders) | 14.0 points | |
| First-shown answer preferred | 3 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e2e0-08f8-790d-a911-17c72a7cdb87` | 10 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 13077 / 0 of 1532 / 0 of 1774 | 66.7% | 81.9% | -15.3 | baseline | baseline cached |
| oidc-migration | `01a1e2e4-429f-7ceb-8c3b-76f7da2e9961` | 4 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 7590 / 0 of 2113 / 0 of 1313 | 14.3% | 66.7% | -52.4 | baseline | baseline cached |
| teen-reading-programme | `01a1e2e6-780a-76d2-b126-df6505498c5f` | 5 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 9146 / 0 of 207 / 0 of 1293 | 71.4% | 25.0% | +46.4 | swarm | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 29813, baseline 0 of 0 (uncached calls only), judge 0 of 4380.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 501 / 1350 | $0.0000 | 1203 / 1350 | complete, cached |
| oidc-migration | final write-up | 72 / 1350 | $0.0000 | 1680 / 1350 | complete, cached |
| teen-reading-programme | final write-up | 1355 / 1350 | $0.0000 | 168 / 1350 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. A subproblem takes one answer: a hypothesis posted where one stands replaces it or is declared its rival, so the last two columns should read 0. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Rivals declared | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open | Claims that supersede nothing | Subproblems with an undeclared second answer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 10 | completed | 10 / 15 | 5 | none | 0 / 19 | 1 | 0 | 0 (0) | 5 | 5 / 0 / 0 | 0 | 0 |
| oidc-migration | 4 | completed | 0 / 11 | 5 | 6 major | 0 / 8 | 0 | 0 | 0 (0) | 1 | 0 / 6 / 0 | 0 | 0 |
| teen-reading-programme | 5 | completed | 6 / 11 | 5 | none | 0 / 10 | 0 | 0 | 0 (0) | 1 | 5 / 0 / 0 | 0 | 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 2. The answer makes the technical claim that Leaky Bucket is better for bursty traffic than Token Bucket, which is generally incorrect as Token Buckets are preferred for allowing bursts while smoothing output, whereas Leaky Buckets smooth input/output more aggressively; this is a questionable claim regarding algorithm suitability.
- `api-rate-limiting` · **correctness** (weight 2; order A = swarm): swarm 0, baseline 3. Answer A claims Leaky Bucket allows a scheduled job to send its whole minute's allowance in two seconds. This is technically incorrect for a standard Leaky Bucket, which smooths output rate; a burst into the bucket is limited by the leak rate (output). A Token Bucket is what allows instant depletion. This is a material error in algorithm mechanics.
- `oidc-migration` · **sequencing** (weight 3; order A = baseline): swarm 0, baseline 2. Answer B only provides a brief introductory sentence and does not provide an ordered sequence of steps, reversal paths, or states after each step as required.
- `oidc-migration` · **credentials** (weight 3; order A = baseline): swarm 0, baseline 1. It mentions the strategy relies on a bridge architecture but does not explain how bcrypt users migrate without forced reset or handle dormant users.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 0, baseline 1. It does not describe how sessions behave while both systems are live.
- `oidc-migration` · **constraints** (weight 2; order A = baseline): swarm 0, baseline 1. It mentions the constraints but provides no plan or schedule to fit them.
- `oidc-migration` · **cutover** (weight 2; order A = baseline): swarm 0, baseline 2. It does not identify a point of no return or cleanup steps.
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 2. The single sentence is factually plausible but provides no substance to evaluate for correctness in the context of the problem's complexity.
- `oidc-migration` · **sequencing** (weight 3; order A = swarm): swarm 1, baseline 3. Answer A provides a high-level overview of the plan's structure but fails to list the specific ordered steps required by the rubric.
- `oidc-migration` · **credentials** (weight 3; order A = swarm): swarm 1, baseline 2. It mentions a 'bridge' architecture and passive migration but lacks specific details on how bcrypt hashes are handled or migrated without reset.
- `oidc-migration` · **dual-run** (weight 2; order A = swarm): swarm 0, baseline 2. The answer does not describe the behavior of sessions or logout mechanisms during the transition period.
- `oidc-migration` · **constraints** (weight 2; order A = swarm): swarm 1, baseline 2. It states the plan is for three part-time engineers but offers no evidence that it fits within a quarter or details the reversibility mechanics requested.
- `oidc-migration` · **cutover** (weight 2; order A = swarm): swarm 0, baseline 3. The point of no return and cleanup are not addressed in the provided text.
- `oidc-migration` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. The concepts are generally sound but too vague to evaluate for material errors or precision.
- `teen-reading-programme` · **correctness** (weight 2; order A = swarm): swarm 0, baseline 2. The claim that $170 per week for food fits within a total of $500 for six weeks is materially false ($170 * 6 = $1020), making the budget breakdown impossible.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
- `pairs/api-rate-limiting.md` — the closest call
