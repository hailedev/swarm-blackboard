# Eval pass: step2b

- Pass id: `01a1e6d4-e1f1-7210-a5f3-f16713d7ec7f`
- Started: 2026-11-17T00:07:53.585Z; ended: 2026-11-17T00:22:40.794Z
- Controller commit: `44df353`
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
- Spent: $0.2023 over 3 problems

## Result

| | Swarm | Baseline |
|---|---|---|
| Mean rubric score | 67.9% | 93.5% |
| Judged pairs | 3 of 3 | |
| Wins / ties / losses (swarm) | 0 / 0 / 3 | |
| Mean delta (swarm − baseline) | -25.7 points | |
| Judge consistency (spread between orders) | 4.6 points | |
| First-shown answer preferred | 3 of 6 decided judgements | |

With 3 judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.

## Per problem

| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | `01a1e6d4-e1fa-7d5d-83ba-33e842f71f6f` | 12 | completed/budget_rounds | $0.0184 | $0.0300 → $0.0232 | 2109/2694 (900 words) | 0 of 23968 / 0 of 2109 / 0 of 2069 | 83.3% | 97.2% | -13.9 | baseline | baseline cached |
| oidc-migration | `01a1e6da-4f48-7feb-b5f4-82a7ad677d91` | 12 | completed/budget_rounds | $0.0193 | $0.0300 → $0.0238 | 2175/2702 (900 words) | 0 of 21806 / 0 of 2175 / 0 of 2679 | 45.2% | 90.5% | -45.2 | baseline | baseline cached |
| teen-reading-programme | `01a1e6de-c251-71d5-9668-757737928b91` | 12 | completed/budget_rounds | $0.0177 | $0.0300 → $0.0227 | 2067/2709 (900 words) | 0 of 19398 / 0 of 2067 / 0 of 2746 | 75.0% | 92.9% | -17.9 | baseline | baseline cached |

Thinking tokens, as a share of output tokens: swarm 0 of 65172, baseline 0 of 0 (uncached calls only), judge 0 of 7494.

## Answers

What each arm wrote against what it was asked for. The swarm’s answer is its final write-up, written from the whole board when the run ended and given the baseline’s output allowance; where that call failed, its last draft. A write-up that comes back under half the words asked for is asked for once more and the longer of the two is kept.

| Problem | Swarm answer | Swarm words written / asked | Write-up cost | Baseline words written / asked | Baseline answer |
|---|---|---|---|---|---|
| api-rate-limiting | final write-up | 796 / 900 | $0.0017 | 1079 / 900 | complete, cached |
| oidc-migration | final write-up | 626 / 900 | $0.0015 | 1089 / 900 | complete, cached |
| teen-reading-programme | final write-up | 627 / 900 | $0.0015 | 1020 / 900 | complete, cached |

## Closing the loop

How far each swarm run got with its own objections, counted from its board, its event log and its model calls. A critique is resolved when it no longer stands and a hypothesis named it among the critiques it answers; replaced when what it attacked was superseded or rejected without anybody naming it; open when it still stood against a live entry at the end, whatever a hypothesis claimed. A call is rejected when its reply did not match the schema; a reply over its role’s limit is trimmed to the limit, not rejected. A subproblem takes one answer: a hypothesis posted where one stands replaces it or is declared its rival, so the last two columns should read 0. None of this is judged: it says that an objection was replied to, not that the reply was good.

| Problem | Rounds | End | Critiques resolved / raised | Replaced unnamed | Still open | Calls rejected / made | Replies trimmed | Rivals declared | Decisions (hypotheses rejected) | Drafts | Subproblems done / claimed / open | Claims that supersede nothing | Subproblems with an undeclared second answer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | 12 | budget_rounds | 8 / 29 | 21 | none | 0 / 24 | 3 | 0 | 0 (0) | 5 | 5 / 0 / 0 | 0 | 0 |
| oidc-migration | 12 | budget_rounds | 16 / 26 | 6 | 1 blocking, 3 major | 0 / 24 | 1 | 1 | 0 (0) | 6 | 1 / 4 / 0 | 0 | 0 |
| teen-reading-programme | 12 | budget_rounds | 8 / 25 | 12 | 3 major, 2 minor | 0 / 21 | 1 | 0 | 0 (0) | 6 | 2 / 3 / 0 | 0 | 0 |

## Where the swarm scored 0 or 1

Every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge’s reason and the baseline’s score on the same criterion.

- `api-rate-limiting` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 2. Candid about unmeasured lag and estimates, but the overage formula is shaky (the 2x limit x T/window gives 20 requests, not 1,200), the claim of 3x conflicts with 200% excess figures, and the fallback arithmetic is muddled.
- `oidc-migration` · **credentials** (weight 3; order A = swarm): swarm 1, baseline 3. Describes verify-locally-then-provision at login with no password pushed and a conditional bulk import for dormant users, but 'sending only user_id and email' does not actually migrate the credential, so users would still depend on the monolith's hashes; the dormant case is hedged on an unconfirmed assumption.
- `oidc-migration` · **dual-run** (weight 2; order A = swarm): swarm 1, baseline 2. States the monolith stays session authority and issues its own cookies throughout, with subject-to-user_id mapping and unchanged lifetime, but defers single sign-out and says nothing about API clients, admin accounts or expiry mid-switch.
- `oidc-migration` · **constraints** (weight 2; order A = swarm): swarm 1, baseline 2. Fits a 12-week calendar and gives one effort figure (about 3 engineer-days) for weeks 1-2, but offers no other estimates and names no step as likely to slip.
- `oidc-migration` · **correctness** (weight 2; order A = swarm): swarm 1, baseline 3. Mostly plausible and appropriately hedged on whether the provider verifies bcrypt natively, but the provisioning model is incoherent (provider accounts with no credentials), the 'point of no return' is reversible, and the architecture leaves the monolith as auth authority, undermining the goal of moving authentication to the provider.
- `oidc-migration` · **credentials** (weight 3; order A = baseline): swarm 1, baseline 3. Provisions only user_id and email at login, with no password or hash sent. This means the user never gets a credential in the IdP unless the bulk hash import works, and it never explains how active users end up verifiable at the provider; the dormant plan is conditional on native bcrypt verification and leaves a permanent local fallback.
- `oidc-migration` · **dual-run** (weight 2; order A = baseline): swarm 1, baseline 2. The monolith keeps issuing its own sessions and maps the subject ID to the internal user_id, which is a clear rule, but it explicitly defers single sign-out and does not address API clients, admins, or expiry mid-switch.
- `oidc-migration` · **constraints** (weight 2; order A = baseline): swarm 1, baseline 2. Gives a rough effort for the first step (3 engineer-days) but not for the others, and names no step as most likely to slip or buffered.
- `oidc-migration` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 3. The credential flow is incoherent: provisioning users without credentials at login while claiming no one needs a reset, a client-side-only 'migration flag', and a shadow-mode correlation metric that is never defined, so the steps don't clearly fit together.
- `teen-reading-programme` · **correctness** (weight 2; order A = baseline): swarm 1, baseline 3. Honest about uncertainty (5% conversion unsupported, Week 4 untested, survey noise, first cohort as test), but the conversion arithmetic is weak (150 passes at 5% gives about 7, not 15), the pizza on passes vs $25/week snacks is inconsistent, and relying on library tablets and 'sound files' is questionable.

## Pairs written out

- `pairs/api-rate-limiting.md` — the swarm's widest win
- `pairs/oidc-migration.md` — the baseline's widest win
