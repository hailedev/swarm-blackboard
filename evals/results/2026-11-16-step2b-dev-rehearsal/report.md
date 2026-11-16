# Eval pass: step2b-dev-rehearsal

- Pass id: `01a1e292-617c-7533-9a4e-e0c93c7e2786`
- Started: 2026-11-16T04:16:46.460Z; ended: 2026-11-16T04:31:13.363Z
- Controller commit: `6d1734b`
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
| Mean rubric score | 76.7% | 54.0% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 3 / 0 / 0 | |
| Mean delta (swarm − baseline) | +22.7 points | |
| Judge consistency (spread between orders) | 9.9 points | |
| First-shown answer preferred | 3 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e292-617e-79e5-8a79-38a5b4971545` | 8 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 1532/4096 (1350 words) | 0 of 11796 / 0 of 1532 / 0 of 1409 | 94.4% | 68.1% | +26.4 | swarm | baseline cached |
| oidc-migration | `01a1e296-1746-79ae-a3ac-1fe7fbfe20dc` | 8 | completed/completed | $0.0000 | $0.0300 → $0.0000 | 2113/4096 (1350 words) | 0 of 14724 / 0 of 2113 / 0 of 2729 | 63.1% | 61.9% | +1.2 | swarm | baseline cached |
| teen-reading-programme | `01a1e29a-a564-7691-857a-b842923f0274` | 12 | completed/budget_rounds | $0.0000 | $0.0300 → $0.0000 | 207/4096 (1350 words) | 0 of 16624 / 0 of 207 / 0 of 1382 | 72.6% | 32.1% | +40.5 | swarm | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 43144, baseline 0 of 0 (uncached calls only), judge 0 of 5520.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 817 / 1350 | $0.0000 | 1203 / 1350 | complete, cached |
| oidc-migration | final write-up | 982 / 1350 | $0.0000 | 1680 / 1350 | complete, cached |
| teen-reading-programme | final write-up | 953 / 1350 | $0.0000 | 168 / 1350 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when a hypothesis names it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open |
|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 8 | completed | 14 / 14 | 0 | none | 0 / 16 | 0 | 0 (0) | 2 | 5 / 0 / 0 |
| oidc-migration | 8 | completed | 16 / 18 | 2 | none | 0 / 16 | 0 | 0 (0) | 2 | 5 / 0 / 0 |
| teen-reading-programme | 12 | budget_rounds | 18 / 24 | 2 | 1 blocking, 3 major | 0 / 24 | 0 | 0 (0) | 5 | 4 / 1 / 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `oidc-migration` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 1. The proposal to store plaintext passwords in server-side variables during the migration hook is a significant security flaw and technically unsound for production systems handling sensitive credentials.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 1, baseline 1. Answer B describes dual-run with backend token exchange but fails to address critical edge cases like session expiry mid-switch or API clients in detail.
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 1. Answer B has a material error in claiming that backend token exchange can silently maintain authenticated state without forcing re-logins or redirects when a monolith session exists but no OIDC token does, which violates standard OIDC flows where tokens are usually required for resource access.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
