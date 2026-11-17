# Judge-only session: judge-only

- Session id: `01a1e720-adf1-7b92-b93a-b97046bfbbab`
- Started: 2026-11-17T01:30:41.009Z; ended: 2026-11-17T01:33:23.152Z
- Commit: `061d67c`
- Judge: `sonnet` → claude-sonnet-5-5
- No swarm ran: every answer judged here already existed, bar the baselines listed under "Baselines made".
- Spent: $0.3114 of a $0.3500 cap

## Baselines made

A baseline the session needed and the cache did not hold, or held only as an answer under half its word budget. Made with the baseline’s length guard: under half its word budget it is asked for once more, and one that is still short is void and not judged.

| Problem | Baseline | Words / asked | Attempts | Cost | |
|---|---|---|---|---|---|
| teen-reading-programme | `haiku` (claude-haiku-5-5) | 810 / 900 | 1 | $0.0009 | kept and cached |

## Pairwise

Two answers side by side, blind to which arm wrote which, as a pass judges a pair; each score is the mean over the orders judged.

| Problem | Swarm answer | Baseline | Swarm | Baseline | Δ | Preferred | Spread between orders | Notes |
|---|---|---|---|---|---|---|---|---|
| api-rate-limiting | of control-haiku | `sonnet` | 77.8% | 100.0% | -22.2 | baseline | 0.0 points |  |
| oidc-migration | of control-haiku | `sonnet` | 61.9% | 90.5% | -28.6 | baseline | 0.0 points |  |
| teen-reading-programme | of control-haiku | `sonnet` | 65.5% | 95.2% | -29.8 | baseline | 8.3 points |  |

## Per problem: solo beside pairwise

Solo: the answer alone against the rubric, nothing beside it, one call. Pairwise so far: every score the same text has received with another answer beside it, with that other answer and the pass that gave it; a score from this session is marked with its label. A cached baseline is the same text in every pass that reused it.

### api-rate-limiting

| Answer | Words / asked | Solo | Pairwise so far |
|---|---|---|---|
| sonnet baseline (claude-sonnet-5-5) | 1079 / 900 | 100.0% | 100.0% beside the swarm answer of step2a (step2a); 97.2% beside the swarm answer of step2b (step2b); 100.0% beside the swarm answer of control-haiku (judge-only) |
| swarm answer of step2b | 796 / 900 | 86.1% | 83.3% beside the claude-sonnet-5-5 baseline (step2b) |
| swarm answer of control-haiku | 683 / 900 | 77.8% | 95.8% beside the claude-haiku-5-5 baseline (control-haiku); 77.8% beside the claude-sonnet-5-5 baseline (judge-only) |
| haiku baseline (claude-haiku-5-5) | 952 / 900 | 100.0% | 88.9% beside the swarm answer of control-haiku (control-haiku) |

### oidc-migration

| Answer | Words / asked | Solo | Pairwise so far |
|---|---|---|---|
| sonnet baseline (claude-sonnet-5-5) | 1089 / 900 | 85.7% | 90.5% beside the swarm answer of step2a (step2a); 90.5% beside the swarm answer of step2b (step2b); 90.5% beside the swarm answer of control-haiku (judge-only) |
| swarm answer of step2b | 626 / 900 | 50.0% | 45.2% beside the claude-sonnet-5-5 baseline (step2b) |
| swarm answer of control-haiku | 778 / 900 | 73.8% | 90.5% beside the claude-haiku-5-5 baseline (control-haiku); 61.9% beside the claude-sonnet-5-5 baseline (judge-only) |
| haiku baseline (claude-haiku-5-5) | 837 / 900 | 66.7% | 69.0% beside the swarm answer of control-haiku (control-haiku) |

### teen-reading-programme

| Answer | Words / asked | Solo | Pairwise so far |
|---|---|---|---|
| sonnet baseline (claude-sonnet-5-5) | 1020 / 900 | 90.5% | 92.9% beside the swarm answer of step2a (step2a); 92.9% beside the swarm answer of step2b (step2b); 95.2% beside the swarm answer of control-haiku (judge-only) |
| swarm answer of step2b | 627 / 900 | 85.7% | 75.0% beside the claude-sonnet-5-5 baseline (step2b) |
| swarm answer of control-haiku | 615 / 900 | 73.8% | 86.9% beside the claude-haiku-5-5 baseline (control-haiku); 65.5% beside the claude-sonnet-5-5 baseline (judge-only) |
| haiku baseline (claude-haiku-5-5) | 810 / 900 | 83.3% | none |
