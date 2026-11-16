# Eval pass: step2b-dev-rehearsal-3

- Pass id: `01a1e2b8-da41-7a67-99f8-79b98131f81e`
- Started: 2026-11-16T04:58:47.745Z; ended: 2026-11-16T05:16:12.861Z
- Controller commit: `98c7267`
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
| Mean rubric score | 73.8% | 52.1% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 2 / 1 / 0 | |
| Mean delta (swarm − baseline) | +21.7 points | |
| Judge consistency (spread between orders) | 16.4 points | |
| First-shown answer preferred | 4 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e2b8-da44-7379-8044-48c571d9ac9a` | 11 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 18714 / 0 of 1532 / 0 of 1651 | 83.3% | 69.4% | +13.9 | swarm | baseline cached |
| oidc-migration | `01a1e2be-8ed4-76f9-8740-98eedc036727` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 23569 / 0 of 2113 / 0 of 1576 | 59.5% | 61.9% | -2.4 | tie | baseline cached |
| teen-reading-programme | `01a1e2c5-6885-7044-baef-60036885684a` | 8 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 11860 / 0 of 207 / 0 of 1462 | 78.6% | 25.0% | +53.6 | swarm | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 54143, baseline 0 of 0 (uncached calls only), judge 0 of 4689.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 634 / 1350 | $0.0000 | 1203 / 1350 | complete, cached |
| oidc-migration | final write-up | 825 / 1350 | $0.0000 | 1680 / 1350 | complete, cached |
| teen-reading-programme | final write-up | 1400 / 1350 | $0.0000 | 168 / 1350 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open |
|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 11 | completed | 16 / 25 | 1 | 5 major, 3 minor (2 named as resolved, target not replaced) | 0 / 22 | 0 | 0 (0) | 4 | 5 / 0 / 0 |
| oidc-migration | 12 | budget_rounds | 22 / 34 | 3 | 5 blocking, 3 major, 1 minor (1 named as resolved, target not replaced) | 0 / 24 | 0 | 0 (0) | 4 | 5 / 0 / 0 |
| teen-reading-programme | 8 | completed | 9 / 16 | 5 | 2 minor | 0 / 15 | 0 | 0 (0) | 3 | 5 / 0 / 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 1. Answer B contains a material error: it claims partitioning prevents over-subscription beyond one times the plan limit, but if a client sends requests to all three regions, they are limited to ~1/3 of their global quota per region, meaning they cannot burst their *entire* 600 requests in two seconds as allowed by the problem statement (burstiness constraint).
- `oidc-migration` · **sequencing** (weight 3; order A = baseline): swarm 1, baseline 3. The answer provides an ordered sequence with reversibility, but the claim that one hour of reversibility is possible after invalidating all sessions and switching to IDP-only is incorrect/impossible.
- `oidc-migration` · **credentials** (weight 3; order A = baseline): swarm 1, baseline 2. It explains migration for active users but fails to address how dormant users are migrated without a forced reset if the assumption about plaintext transfer is wrong, or simply assumes it works without explaining the mechanism for the 'never logged in' group properly in context of the hook.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 1, baseline 2. It describes session invalidation upon OIDC token issuance, which effectively ends the dual-run state rather than managing it, leading to immediate forced logins if not handled carefully, violating the no-downtime/no-forced-reset spirit for those with expired sessions.
- `oidc-migration` · **constraints** (weight 2; order A = baseline): swarm 0, baseline 2. It ignores the constraint that steps must be reversible within an hour after PONR, as switching to IDP-only and invalidating sessions is a major break if it fails.
- `oidc-migration` · **cutover** (weight 2; order A = baseline): swarm 1, baseline 2. It identifies the PONR but incorrectly states it is reversible within an hour after switching to IDP-only write mode, which contradicts the definition of a point of no return for this specific constraint set.
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 0, baseline 1. The claim that bcrypt hashes cannot be imported directly due to salt formats is technically false (hashes include salt), making the assumption of plaintext transfer security-risky and technically misguided.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
