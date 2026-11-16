# Eval pass: step2b-dev-rehearsal-2

- Pass id: `01a1e2a2-a9d7-7c5f-ade7-78d7c6cc6798`
- Started: 2026-11-16T04:34:33.559Z; ended: 2026-11-16T04:51:59.346Z
- Controller commit: `0c614ac`
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
| Mean rubric score | 69.8% | 66.2% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 1 / 1 / 1 | |
| Mean delta (swarm − baseline) | +3.6 points | |
| Judge consistency (spread between orders) | 10.6 points | |
| First-shown answer preferred | 4 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e2a2-a9da-74ce-9198-8192ffd49f43` | 11 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 23675 / 0 of 1532 / 0 of 1618 | 73.6% | 81.9% | -8.3 | tie | baseline cached |
| oidc-migration | `01a1e2a9-49f4-700e-bd8d-0601c870b2a3` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 24578 / 0 of 2113 / 0 of 1791 | 59.5% | 84.5% | -25.0 | baseline | baseline cached |
| teen-reading-programme | `01a1e2b0-8ce6-7169-9209-529b5c587219` | 5 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 6840 / 0 of 207 / 0 of 1476 | 76.2% | 32.1% | +44.0 | swarm | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 55093, baseline 0 of 0 (uncached calls only), judge 0 of 4885.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 1142 / 1350 | $0.0000 | 1203 / 1350 | complete, cached |
| oidc-migration | final write-up | 539 / 1350 | $0.0000 | 1680 / 1350 | complete, cached |
| teen-reading-programme | final write-up | 1273 / 1350 | $0.0000 | 168 / 1350 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open |
|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 11 | completed | 27 / 31 | 2 | 2 major | 0 / 22 | 2 | 0 (0) | 4 | 5 / 0 / 0 |
| oidc-migration | 12 | budget_rounds | 17 / 32 | 2 | 3 blocking, 10 major (3 named as resolved, target not replaced) | 0 / 24 | 0 | 0 (0) | 5 | 4 / 0 / 0 |
| teen-reading-programme | 5 | completed | 6 / 6 | 0 | none | 0 / 9 | 0 | 0 (0) | 1 | 4 / 0 / 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 3. The claim that SWC allows consuming 3x the plan limit is a massive correctness error; if local limits are strictly enforced per region, the max is 1x the global limit (sum of local caps). If it claims 3x overage, it implies no local limits or a severe flaw not explained well, contradicting the 'Local Hard Limit' description.
- `oidc-migration` · **dual-run** (weight 2; order A = swarm): swarm 1, baseline 2. Answer A describes a hybrid session model but contains a significant technical contradiction by stating the monolith validates identity against the IdP token while still maintaining server-side sessions, which is not standard OIDC behavior for simple migration.
- `oidc-migration` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. Answer A contains material errors by proposing sending plaintext passwords to an IdP hook instead of using the provided hash migration capability, which is insecure and violates standard OIDC implementation practices.
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 1. Answer B makes questionable claims about retrieving plaintext passwords from a bcrypt database (often impossible if only hashes are stored) and uses mTLS which is an implementation detail not guaranteed by OIDC/IdP contracts, risking security or feasibility.
- `teen-reading-programme` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 2. The proposal contains a material error by claiming $500 covers incentives for a group likely to be larger than 1-2 people per week; $250 at $5-$10 per teen would last only 25-50 participants total, which is unrealistic for a 'mid-sized town' library program expecting retention, and ignores the cost of professional printing or hardware maintenance.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
- `pairs/api-rate-limiting.md` — the closest call
