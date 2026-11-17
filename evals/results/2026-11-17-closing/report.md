# Measurement: closing

- Arms: `call:sonnet`, `call:haiku`, `swarm:cheap`, `swarm:dev`, `call:local-fast`; 3 runs per problem for a swarm arm, one call for a call arm
  - call:sonnet: one call of `sonnet` (anthropic/claude-sonnet-5-5)
  - call:haiku: one call of `haiku` (anthropic/claude-haiku-5-5)
  - swarm:cheap: the `cheap` swarm: planner `haiku`, researcher `local`, solver `local`, critic `haiku`, synthesizer `haiku`, fallback `haiku`
  - swarm:dev: the `dev` swarm: planner `local-fast`, researcher `local-fast`, solver `local-fast`, critic `local-fast`, synthesizer `local-fast`, fallback none
  - call:local-fast: one call of `local-fast` (ollama/qwen3.6:35b-mlx)
  - judge: `sonnet` (anthropic/claude-sonnet-5-5)
  - answer length sized on: `sonnet` (anthropic/claude-sonnet-5-5)
- Problems: 10; every answer asked for about 900 words with the same sentence; each swarm run capped at $0.0300
- Scoring: each answer alone against the rubric, 2 times, blind to the arm; nothing is judged pairwise
- Commit: `d37db99`
- Spent: answers $0.8015 of a $1.2000 cap; scores $0.0000

## Stage 1: the answers

88 of 90 answers made; 2 void, 0 failed, 0 not yet made. Void: no answer, or under half its word budget after its one retry; not scored, and left out of every mean. Failed: nothing came of the attempt for a reason outside the arm; tried again by the next invocation.

| Arm | Expected | Answered | Void | Failed | Not yet made | Cost | Words min / median / max |
|---|---|---|---|---|---|---|---|
| `call:sonnet` | 10 | 10 | 0 | 0 | 0 | $0.2339 | 922 / 1117 / 1254 |
| `call:haiku` | 10 | 10 | 0 | 0 | 0 | $0.0089 | 654 / 815 / 1140 |
| `swarm:cheap` | 30 | 30 | 0 | 0 | 0 | $0.5587 | 590 / 729 / 885 |
| `swarm:dev` | 30 | 30 | 0 | 0 | 0 | $0.0000 | 534 / 838 / 1336 |
| `call:local-fast` | 10 | 8 | 2 | 0 | 0 | $0.0000 | 764 / 1010 / 2045 |

| Swarm arm | How the runs ended | Rounds | Final write-ups | Drafts in their place | Write-up asked again: short | for a leak | Still leaking | Mean minutes a run |
|---|---|---|---|---|---|---|---|---|
| `swarm:cheap` | budget_rounds × 30 | 12 to 12 | 30 | 0 | 0 | 1 | 0 | 4.7 |
| `swarm:dev` | budget_rounds × 30 | 12 to 12 | 30 | 0 | 4 | 4 | 3 | 5.3 |

**Void answers**

- `teen-reading-programme/call-local-fast`: 238 words of about 900 asked for, after a second attempt
- `monorepo-decision/call-local-fast`: 109 words of about 900 asked for, after a second attempt

**Write-ups that still mention the board, the agents or their own confidence after the retry (scored, flagged)**

- `confidential-llm-summaries/swarm-dev--r1`
  - "If the model produces conflicting outputs across repeated runs or low-confidence scores, the summary is flagged for manual review."
- `onboarding-dropoff/swarm-dev--r2`
  - "If results are inconclusive for both experiments, the team will ship the 'Connect Data Source' simplification (if engineering audit revealed specific technical errors) as a high-confidence fix, while scheduling further research for long-te…"
- `confidential-llm-summaries/swarm-dev--r3`
  - "If the variance exceeds a set threshold, the summary is flagged as 'low confidence.' Phase 2 is manual review."
  - "The staff member reviews only the flagged summaries or a random 10% sample of high-confidence ones."

**Call answers that used their whole allowance (end probably missing):** `onboarding-dropoff/call-local-fast`

## Stage 2: the scores

0 of 176 scores given (2 for each answered answer); 0 failed, 176 not yet given.

No answer has been scored yet: the sections below appear once stage 2 has run.
