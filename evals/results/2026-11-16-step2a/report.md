# Eval pass: step2a

- Pass id: `01a1e1cf-33e8-79d7-b354-b9764f7a85fe`
- Started: 2026-11-16T00:43:35.273Z; ended: 2026-11-16T00:58:29.396Z
- Controller commit: `007b2cb`
- Swarm profile: `cheap`
  - planner: `haiku` (anthropic/claude-haiku-5-5)
  - researcher: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - solver: `local` (ollama/qwen3.6:35b-a3b-q8_0)
  - critic: `haiku` (anthropic/claude-haiku-5-5)
  - synthesizer: `haiku` (anthropic/claude-haiku-5-5)
  - fallback: `haiku`
- Baseline: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Judge: `sonnet` (anthropic/claude-sonnet-5-5) → claude-sonnet-5-5
- Caps: pass $0.3500; each swarm run and each baseline call capped at $0.0300, the same budget for both arms
- Judging: both orders per pair; blind to the arm
- Spent: $0.2743 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 69.2% | 94.4% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 0 / 0 / 3 | |
| Mean delta (swarm − baseline) | -25.2 points | |
| Judge consistency (spread between orders) | 3.0 points | |
| First-shown answer preferred | 3 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e1cf-8612-7ab4-b493-069bb38d90b1` | 12 | completed/budget_rounds | $0.0215 | $0.0300 → $0.0232 | 2109/2694 (900 words) | 0 of 26249 / 0 of 2109 / 0 of 1987 | 79.2% | 100.0% | -20.8 | baseline |  |
| oidc-migration | `01a1e1d5-2cf4-7640-9637-e544eb49fc97` | 12 | completed/budget_rounds | $0.0171 | $0.0300 → $0.0238 | 2175/2702 (900 words) | 0 of 18067 / 0 of 2175 / 0 of 2548 | 57.1% | 90.5% | -33.3 | baseline |  |
| teen-reading-programme | `01a1e1d8-99a8-79f2-ad06-882011484999` | 12 | completed/budget_rounds | $0.0256 | $0.0300 → $0.0227 | 2067/2709 (900 words) | 0 of 31191 / 0 of 2067 / 0 of 2551 | 71.4% | 92.9% | -21.4 | baseline |  |

Thinking tokens, as a share of output tokens: swarm 0 of 75507, baseline 0 of 6351 (uncached calls only), judge 0 of 7086.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 531 / 900 | $0.0021 | 1079 / 900 | complete |
| oidc-migration | final write-up | 565 / 900 | $0.0016 | 1089 / 900 | complete |
| teen-reading-programme | final write-up | 591 / 900 | $0.0019 | 1020 / 900 | complete |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `oidc-migration` · **constraints** (weight 2; order A = swarm): swarm 1, baseline 2. Week ranges are given and 'well under an hour' is claimed, but there is no effort per step for three part-time engineers and no named step most likely to slip with a buffer.
- `oidc-migration` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. Claims are mostly sound and flags assumptions honestly, but the 'point of no return' that is also revertible in an hour muddles the logic, and the plan to migrate dormant users 'after cutover' via a hook that disables local password checks conflicts with its own cutover step.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 1, baseline 2. Says the monolith accepts both session types and exchanges legacy sessions for OIDC, with back-channel logout, but gives no clear rule on session ownership, expiry mid-switch, API clients or admins.
- `oidc-migration` · **constraints** (weight 2; order A = baseline): swarm 1, baseline 2. Gives week ranges that plausibly fit a quarter, but no effort per step and no named slip risk; the plan is internally inconsistent on what the legacy database dependency costs.
- `teen-reading-programme` · **feasibility** (weight 2; order A = baseline): swarm 1, baseline 2. A 4-hour session each week leaves the librarian's 4 hours fully consumed by facilitation, yet the stated split (30 min prep, 3 hours facilitation, 30 min data entry) does not match the 4-hour session and ignores outreach, school visits and volunteer coordination.
- `teen-reading-programme` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 3. Contains an internal contradiction (4-hour sessions versus 3 hours facilitation), a stray reference to the board and confidence level, and unrealistic assumptions about devices and volunteer-run recruitment, though it candidly flags uncertainties.
- `teen-reading-programme` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. A's four-hour teen session is long and implausible, 'tacos at $3 a head' for $240 across six sessions is shaky, and $25 gift cards for completion are questionable, though it flags assumptions about devices and partner buy-in.

## Pairs written out

- `pairs/api-rate-limiting.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
