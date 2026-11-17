# ADR-0015: Close the loop on the board: critiques get answered, a subproblem takes one answer, and a run ends only on a synthesis that has read everything

- **Status:** accepted
- **Date:** 2026-11-17

## Context

The step2a pass (`evals/results/2026-11-16-step2a`, ADR-0014) left the swarm at 69.2 % against the single-call baseline's 94.4 %, and its three runs' logs showed a board that nobody kept:

- **0 of 52 critiques were ever resolved**, though the Critic had already raised the flaws the judge later penalised. Nothing made an agent answer a critique.
- **16 of 27 Critic calls were thrown away** because the reply held more than six contributions ("Too big: expected array to have <=6 items"): Anthropic's structured output strips `maxItems`, so the model never saw the limit.
- One run selected only the Synthesizer for five rounds, which **rewrote its synthesis on an unchanged board** each time.
- **Subproblems were claimed and never finished** (12 of 13 live ones in one run): the Solver posted status copies that superseded nothing.
- A contradiction between hypotheses forced the Critic every round to the end of a run and was never decided: no agent could post a `decision`.

Step 2b was to close that loop in one measured change. Five dev rehearsals on the three development problems then found further holes, each closed before anything was paid for: the local Critic marked 44 of 125 new critiques as already resolved; the local Solver named the critiques it was answering without superseding the hypothesis they attacked, and wrote second full sets of answers beside the first (15 of 93 hypotheses in one rehearsal); and one run completed in four rounds on a draft at 0.85 written in the very round the Critic raised six major critiques, none of which was ever answered.

## Decision

Adopt Step 2b **on its mechanics**. It did **not** improve answer quality: the swarm scored 67.9 % on the step2b pass against 69.2 % on step2a (below). What is adopted is that the board now keeps its own books and that no call is lost to a length limit.

**Critiques get answered.**
- A standing hypothesis with an open blocking or major critique makes the Solver eligible ahead of new work (priority 85, at most four such hypotheses a call, worst first) to post a version that supersedes it.
- A hypothesis may name the critiques it answers in `payload.resolves`. It is a record, not a switch: a critique closes when what it attacks is replaced, and in no other way. Only a critique that still stands can be named, and only by the version that replaces its target.
- A model cannot post a critique that is already resolved: the schema a model answers against has no `resolvedBy` (the stored shape keeps it for older logs).

**A subproblem takes one answer.**
- Where a subproblem stands is read off the board (`subproblemStatus`): done when a standing hypothesis answers it with no open blocking or major critique, claimed when every such hypothesis is contested. No agent posts a status, and the Solver posts hypotheses only.
- The Solver answers against one schema variant per live subproblem, told apart by `answers`. Where a hypothesis already stands, `relation` says whether the new one is a `"new version of H…"` (choices limited to that subproblem's standing hypotheses) or a `"rival"`; with exactly one standing and nothing stated the controller links it as a new version; with two or more the field is required. Both fields come before the content.
- A reply is settled as a whole (`settleAnswers`): one new version per hypothesis, one first answer per subproblem; what is left over is dropped and noted on the log.
- A declared rival (`payload.rivalOf`, stamped by the controller) is a contradiction the decision flow settles.

**Contradictions get decided.**
- The forced Critic is certain to run and is aimed at the contradicting pair only.
- Once the pair has been critiqued the Synthesizer is eligible in any round and may post up to three `decision` entries before its synthesis.
- Rejection follows the line: a later version of a rejected hypothesis is rejected with it, and a rivalry stays the same conflict when either side is replaced.

**No reply is rejected for its length.** A role may post so many contributions a call (Planner 8, the others 6); a longer reply keeps its first ones, the Critic's ranked by severity, and the cut is noted on the log (`agent_failed`, reason `over_limit`). The schema itself carries one generous bound (24).

**The Synthesizer runs only when the board has changed** since its last synthesis; a run with nothing left to do ends (`no_eligible_agents`) and is written up.

**A run completes only on a synthesis that has read everything.** `completed` needs a confident synthesis (as before), no blocking **or major** critique open, a synthesis **written after the last hypothesis or critique landed**, **the Critic with nothing left to review** on the standing versions, and no undecided contradiction.
- To make "reviewed, nothing to raise" something the log can say, `agents_selected` records what each eligible agent was pointed at (`targetIds`, additive). The board view lists the calls that returned (`callsOf`), and the Critic is eligible for standing versions no call of its own was pointed at, or that have had evidence since. Being called on a version is the review.

**The final write-up** (ADR-0014) is shown the critiques that still stand and the hypotheses a decision rejected apart from the candidates; must not repeat a contested claim as it stands, mention the board or the agents, or state its own confidence; is asked to spend its words on concrete figures; and, when it comes back under half its word budget, is asked for once more, the longer of the two being kept (`write_up_completed` records `attempts`, `words` and `short`).

**The eval report** gains a "Closing the loop" table per run.

### What the step2b pass measured

`evals/results/2026-11-17-step2b`: `cheap` profile, the three development problems, $0.20, run once after a dev rehearsal met seven conditions set beforehand.

| | Swarm, step2a → step2b | Baseline, step2a → step2b |
|---|---|---|
| api-rate-limiting | 79.2 → 83.3 % | 100.0 → 97.2 % |
| oidc-migration | 57.1 → 45.2 % | 90.5 → 90.5 % |
| teen-reading-programme | 71.4 → 75.0 % | 92.9 → 92.9 % |
| Mean | 69.2 → 67.9 % | 94.4 → 93.5 % |

The baseline answers are the same cached ones, judged again; the judge's spread between orders was 4.6 points. Two problems moved up by about four points, inside that spread, and one fell by twelve. **On this evidence 2b made the answers no better.**

| Per run (api, oidc, teen) | step2a | step2b |
|---|---|---|
| Critiques resolved of raised | 0 of 52 | 8 of 29, 16 of 26, 8 of 25 |
| Critic calls rejected | 16 of 27 | 0 of 19 (no call of any role: 0 of 69) |
| Rounds used | 12, 12, 12 | 12, 12, 12 |
| Subproblems with one standing answer | not kept | all, bar one rival declared in a last round |
| Write-up words of 900 asked | 531 to 591 | 796, 626, 627 |

## Consequences

- `+` No call is lost to a length limit: in step2a that was most of the Critic's spend.
- `+` The board's books are right without any model keeping them: every subproblem has one standing answer, every hypothesis that names critiques replaces what they attack, and a subproblem's status means something.
- `+` Critiques get replies (32 of 80 named as resolved on the pass, against none), and the log says which.
- `+` The Synthesizer no longer spends rounds rewriting an unchanged board, and the Critic reviews each version once.
- `+` The log records what each agent was pointed at, which the UI and later analysis can use.
- `−` **Answer quality did not improve** (67.9 % against 69.2 %). Closing the loop on the board is not what separates the swarm from a single Sonnet call.
- `−` **No run converged.** All three hit the twelve-round cap with the Critic still raising critiques in the last round, and Haiku's drafts stood at 0.4 to 0.6, so the new completion rule never came into play on the paid pass; on the local model it turned three completing runs into three that ran to the cap.
- `−` **Half the critiques are closed unread.** 39 of 80 closed without being named because their target was replaced, 24 of them in the very round they were posted: the Solver and the Critic often share a round, and the Solver rewrites the versions the Critic is reviewing.
- `−` The rival → Critic → decision path has run only in a scripted test. On the pass one rival was declared, in a last round.
- `−` The Solver's schema is a union with one variant per subproblem. It has only ever been decoded by the local model; an Anthropic-backed Solver (the fallback, or another profile) is untested against it.
- `−` A forced synthesis ends a run only when these rules say so, which is now rarely at once.
- `−` **Known bug, not fixed:** the write-up prompt includes the latest draft, and a draft is written beside the hypotheses of its own round. In the step2b teen run the answer said "150 passes", copied from draft A6, where the standing hypothesis H24 of that same round said 200. Where the draft and a standing hypothesis disagree the write-up should follow the hypothesis.
- `−` A draft that does not supersede its predecessor stays live (one did in that run); only the highest version is shown to the write-up.

## Alternatives considered

- **Let `resolves` close a critique by naming it** — rejected: the critiqued hypothesis would go on standing, unchanged, with nothing against it.
- **Reject a reply that names critiques and supersedes nothing** — rejected: rejected replies are what cost 16 of 27 Critic calls; the link is read off the claim instead.
- **Keep model-posted subproblem status** — rejected: no model kept it in three runs.
- **Require `supersedes` whenever no subproblem is open** — rejected for the per-subproblem rule (Hai, 2026-11-16): it is scoped to where an answer already stands, and leaves room for a declared rival.
- **Have the Critic post an explicit "no objection" entry** to record a clean review — rejected: a new kind of entry and output tokens for a fact the controller already has; the targets go on the log instead.
- **Infer reviews from which rounds the Critic ran in**, without recording targets — rejected: wrong when it was forced onto a pair or its targets were capped.
- **Complete on blocking critiques only**, as before — rejected after the fourth rehearsal: a run ended with six major critiques open and none answered.
- **Wait for major critiques but not for a current synthesis** — rejected (Hai, 2026-11-17): the stale draft would end the run one round later, once the Solver had replaced the hypotheses.
- **A switch to turn the write-up's length guard off for scripted runs** — rejected: the scripted answer was made full-length instead.
