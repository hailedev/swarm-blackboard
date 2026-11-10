# ADR-0012: Evaluate the swarm against a single-call baseline at equal cost, judged blind

- **Status:** accepted
- **Date:** 2026-11-10

## Context

Phase 5's definition of done (docs/PLAN.md §6) is an eval report and at least one controller change adopted or rejected on eval evidence, and §1 is explicit that the swarm beating one strong model is the goal, not an assumption. Nothing measured answer quality before this: the Phase 2 trial ranked local models on schema validity and speed, and the recorded runs were read by eye. Three questions were open in §10: the judge model, the rubric format, and where the harness lives (PLAN.md §5 names `evals/run.ts`, but the trial harness went into `apps/cli` to avoid a dependency in `evals/`). Hai's kick-off fixed the arms: the `cheap` profile against one Sonnet call capped at the dollar cost of that problem's swarm run, judged by Sonnet blind to the arm with the order randomised, with a paid pass behind `--yes`, a cap of its own, and cached baselines.

## Decision

- **Ten problems with scored rubrics** in `evals/problems/`, markdown with a YAML front matter: statement, constraints, success criteria, and three to six criteria each with a weight (1–3) and anchors for scores 0–3. The weighted total is normalised to a percentage. The problems span engineering process, architecture, system design, planning, management, technology choice, policy, community planning, product analysis and tooling, so no one shape of answer is favoured.
- **Two arms at equal cost.** The swarm runs on the chosen profile with `ProblemInput` carrying the constraints and criteria. The baseline is one call of the profile's `evals.baseline` model on the same text with a neutral system prompt, sized with core's own reservation arithmetic (`estimateInput`, `fitCall`) to fit the swarm run's measured cost: the output allowance shrinks to fit, and below the 256-token floor the baseline is skipped and the report says so. The baseline answers as an array of paragraphs joined with a blank line, the shape the Synthesizer uses (ADR-0008, third amendment): the first `dev` rehearsal asked `local-fast` for one string and got 31 tokens back, the model closing the string where a markdown heading wanted a line break it could not emit under the JSON grammar.
- **One blind judge call per pair per order.** The `evals.judge` model sees the problem, the rubric (criteria and scales, not weights) and the two answers as "Answer A" and "Answer B", scores every criterion for both with a one-sentence reason, and states a preference. The first order comes from a seeded generator (`mulberry32`); by default the pair is judged again in the other order. Both orders are averaged, so position bias cancels, and the spread between them is reported as the judge's consistency: the noise band any difference between arms has to clear.
- **Eval models are configuration**: an `evals` block in `agents.yaml`, keyed by profile (`dev` → `local-fast` for both; `cheap` and `quality` → `sonnet`). The loader rejects a paid eval model on a profile whose every role is free, as it rejects a paid fallback (ADR-0009).
- **A pass cap, enforced in code** (docs/budget-guardrails.md §9): default $1.00 on the whole pass and $0.08 on each swarm run, the smaller of the run cap and what the pass has left. A baseline or judge call that cannot fit what is left is skipped with a reason; the pass stops cleanly with a partial report when nothing is left or the month is spent. Every call is traced with `runId` `eval:<pass id>` and counts in the month's ledger when API-billed.
- **Cached baselines**, one JSON record per problem and model under `evals/results/baselines/`, committed, holding the answer, its usage, and the cap it was sized for. A later pass reuses a record whose key (problem text, prompt version, model) still matches, and the report flags a cap that has drifted more than 25 % from the swarm's current cost; `--refresh-baselines` redoes them.
- **The report** (`evals/results/<date>-<label>/`) carries the controller commit, profile and models, caps and spend; a result table with means, wins, mean delta, consistency and first-shown preference; a row per problem with its swarm run id (replayable in the web UI); honesty notes; and three pairs in full for the human spot-check (the swarm's widest win, the baseline's, the closest call).
- **The harness lives in `evals/`** as PLAN.md §5 intended, with `pnpm eval` → `evals/src/run.ts`. The pure parts (parsing, judging, scoring, the pass, the report) are unit-tested under `pnpm test`; `--fake` runs the whole pipeline on scripted models and an in-memory database.
- **Reading the numbers.** A controller change is adopted when its targeted metric moves the right way and the swarm's mean does not fall by more than the judge's consistency figure; otherwise rejected. Ten pairs cannot show a small effect, and the ADR for each change says so.

Dependencies added to `evals/` on 2026-11-10, both already pinned elsewhere in the workspace, approved by Hai in the Phase 5 plan: `yaml` 2.9.1 (front matter) and `@types/node` 22.20.5 (dev). `zod` 4.6.7 and the workspace packages `@team/core`, `@team/providers` and `@team/host` join as the code imports them.

## Consequences

- `+` A paid pass costs about a dollar at most, and the report says what it spent and why anything was skipped. The month's ledger sees every call.
- `+` The same harness runs for free on `dev`, so a controller change is rehearsed end to end before it is paid for.
- `+` Position bias and judge noise are measured, not assumed away; a human reads three pairs per pass.
- `−` "Equal cost" compares a Sonnet call with a swarm that spent most of its compute on free local tokens; the report states the swarm's dollar cost and the baseline's cap, and the reader weighs it.
- `−` One judge model, one rubric per problem: a systematic blind spot in Sonnet's grading would be invisible. The pairs written out are the check.
- `−` The baseline's cap follows the swarm's cost, which changes with every controller change; cached baselines keep an older cap, and the report says when that matters.
- `−` A pass takes about an hour of wall-clock on the Mac mini's local models, sequentially; nothing in the harness runs problems in parallel.

## Alternatives considered

- **Absolute grading of each answer alone** — rejected: pairwise grading on one rubric is what makes the two arms comparable, and the blind order is what keeps it honest.
- **Preference only, no rubric scores** — rejected: a preference says who won, not on what; the per-criterion scores are what a controller change can be read against.
- **An uncapped baseline** — rejected: the plan's question is equal budget, and an uncapped Sonnet answer would measure Sonnet, not the comparison.
- **No baseline cache** — rejected: the baseline depends only on the problem and the model, and paying for it on every pass would spend a third of each pass on an arm that does not change.
- **The harness in `apps/cli`, like the trial** — rejected: PLAN.md §5 put the harness in `evals/`, and the two dependencies it needs are already in the workspace.
- **JSON rubric sidecars instead of YAML front matter** — rejected: one file per problem is easier to read and review, and `yaml` was already a workspace dependency.
- **A local judge for paid passes** — rejected for now: the judge's quality bounds the whole measurement, and the paid passes exist to measure answers, not to save a few cents on grading. `dev` passes use `local-fast` for both so they cost nothing.

## Amendment, 2026-11-10: before the first paid call

Hai's review of the problems and the `dev` rehearsal asked for three changes, all made before anything was billed.

- **Every rubric scores correctness.** The six problems that had no such criterion (01, 04, 05, 08, 09, 10) gained one at weight 2 with the anchors of 02 and 03: material errors 0, one questionable claim 1, sound 2, sound and precise about limits and guarantees 3.
- **The baseline is told its length.** The call's output allowance already shrank to fit the swarm's cost, but the model was never told, so a shrunk allowance could only cut an answer off. The prompt now ends with the budget as a word count derived from the fitted allowance (`wordBudgetFor`: 0.6 words per token, since a model told it has N words tends to write more and markdown and JSON escapes cost tokens; 15 % headroom for the JSON; rounded down to fifty, never under a hundred), `BASELINE_PROMPT_VERSION` is 4, and an answer that still uses its whole allowance is kept and reported as truncated in the table, the notes and the pair file; when its JSON never closed, the paragraphs that did finish are salvaged and judged under the same flag. The first paid pilot (`evals/results/2026-11-10-pilot-attempt-1`, $0.14) set 0.75 words per token and told the model to use most of its budget; all three Sonnet baselines ran into their allowance and nothing was judged, which is what fixed both figures. The wording matters the other way too: told only to "fit in N words", `local-fast` wrote one 173-word paragraph. The word budget is deliberately not part of the cache key, so a pass reuses a baseline when only the swarm's cost has moved; the drift note states the cap and the words the cached answer was given.
- **The judge sees no handles.** Swarm answers carried board handles ("(H16)", "E24 and E28") that would have told the judge which arm wrote them. Both answers now pass through `blindText`, which removes a parenthesis holding only handles and any bare handle in prose and tidies the punctuation around the gap; the report and the pair files keep the original text. Each change has a test.

- **Amended 2026-11-10 (ADR-0013):** the baseline is capped at the run cap, the same budget as the swarm run, not at what the swarm spent; thinking is off on the Claude aliases and reasoning tokens are reported per arm; the judge answers `{ reason, score }` in that order with a 4,096-token allowance.
