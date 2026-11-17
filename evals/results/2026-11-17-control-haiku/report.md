# Eval pass: control-haiku

- Pass id: `01a1e6fe-75d8-78bd-9490-3795ae7a6826`
- Started: 2026-11-17T00:53:18.425Z; ended: 2026-11-17T01:08:40.955Z
- Controller commit: `f3ce93d`
- Swarm profile: `cheap`
  - planner: `haiku` (anthropic/claude-haiku-5-5)
  - researcher: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - solver: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - critic: `haiku` (anthropic/claude-haiku-5-5)
  - synthesizer: `haiku` (anthropic/claude-haiku-5-5)
  - fallback: `haiku`
- Baseline: `haiku` (anthropic/claude-haiku-5-5) → claude-haiku-5-5
  - **Control pass.** --baseline haiku: this model writes the baseline in place of the profile's `sonnet`, with the same prompt and the output allowance, and so the word budget, `sonnet` would be given under the cap.
- Judge: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Caps: pass $0.3000; each swarm run and each baseline call capped at $0.0300, the same budget for both arms
- Judging: both orders per pair; blind to the arm
- Spent: $0.1820 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 91.1% | 52.6% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 3 / 0 / 0 | |
| Mean delta (swarm − baseline) | +38.4 points | |
| Judge consistency (spread between orders) | 5.9 points | |
| First-shown answer preferred | 3 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e6fe-a341-7741-bf65-3bfba6abaa88` | 12 | completed/budget_rounds | $0.0188 | $0.0300 → $0.0010 | 1718/2693 (900 words) | 0 of 24991 / 0 of 1718 / 0 of 2163 | 95.8% | 88.9% | +6.9 | swarm |  |
| oidc-migration | `01a1e704-54a9-7a4b-9407-a97f5093787c` | 12 | completed/budget_rounds | $0.0169 | $0.0300 → $0.0009 | 1596/2700 (900 words) | 0 of 20667 / 0 of 1596 / 0 of 2623 | 90.5% | 69.0% | +21.4 | swarm |  |
| teen-reading-programme | `01a1e708-c374-79a1-816a-9ed0da900538` | 12 | completed/budget_rounds | $0.0165 | $0.0300 → $0.0001 | 30/2707 (900 words) | 0 of 19136 / 0 of 30 / 0 of 1906 | 86.9% | 0.0% | +86.9 | swarm |  |

Thinking tokens, as a share of output tokens: swarm 0 of 64794, baseline 0 of 3344 (uncached calls only), judge 0 of 6692.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft. A write-up that comes back under half the words asked for is asked for once more and the longer of the two is kept.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 683 / 900 | $0.0016 | 952 / 900 | complete |
| oidc-migration | final write-up | 778 / 900 | $0.0017 | 837 / 900 | complete |
| teen-reading-programme | final write-up | 615 / 900 | $0.0015 | 5 / 900 | complete |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. A subproblem takes one answer: a hypothesis posted where one stands replaces it or is declared its rival, so the last two columns should read 0. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Rivals declared | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open | Claims that supersede nothing | Subproblems with an undeclared second answer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 12 | budget_rounds | 20 / 33 | 13 | none | 0 / 24 | 3 | 0 | 0 (0) | 4 | 5 / 0 / 0 | 0 | 0 |
| oidc-migration | 12 | budget_rounds | 20 / 28 | 8 | none | 0 / 22 | 4 | 0 | 0 (0) | 5 | 5 / 0 / 0 | 0 | 0 |
| teen-reading-programme | 12 | budget_rounds | 14 / 33 | 14 | 1 blocking, 4 major | 0 / 22 | 5 | 0 | 0 (0) | 5 | 0 / 5 / 0 | 0 | 0 |

## Where the swarm scored 0 or 1

Nowhere: the swarm scored 2 or 3 on every criterion of every judgement.

## Pairs written out

- `pairs/teen-reading-programme.md` — the swarm's widest win
- `pairs/api-rate-limiting.md` — the baseline's widest win
