# ADR-0014: End every run with a final write-up from the whole board, its cost held back from the cap

- **Status:** accepted
- **Date:** 2026-11-16

## Context

The third pilot of the eval harness (`evals/results/2026-11-15-pilot-3`) put the swarm at 55.9 % against the single-call baseline's 85.4 %. The judge's reasons for the swarm's low scores were about the answer, not the work behind it: it referred to a "board" the reader had never seen, it "repeatedly says things are 'not settled'", it gave "no weeks, no effort estimates", and it ran to a third or a half of the baseline's length. The answer was whatever the Synthesizer had last drafted in a round, from a view bounded to twenty entries, under a prompt that asked it to be concise and to say what was open. All three runs ended on the round limit, so that draft was never meant as a last word. A final call at the end of a run has to be paid for when the run is over, which for a budget end is exactly when nothing is left.

## Decision

- **Every run that ends for good ends with a final write-up.** Before `run_terminated`, for every terminal reason except `billing` and `auth`, the Synthesizer's model writes the answer once more from the **whole live board** (every live entry in full by handle, up to `writeUp.maxBoardChars`, default 48,000; critiques of entries that have since been replaced left out). A pause is not an end. A board that holds nothing but the problem gets none.
- **It writes for a reader who has never seen the board** (`prompts/write-up.md`): no board, agents or handles in the text; every success criterion answered in order with the specifics the board holds; every point the board left open decided and marked "Assumption:" instead of listed as unresolved; a standing critique built into the answer rather than repeated as a caveat. Where the board holds nothing on a success criterion, the model gives its most defensible answer and marks it as an assumption too (kept on Hai's decision of 2026-11-16).
- **It is asked for the words its output allowance buys**, by the function and the sentence the eval baseline is given (`wordBudgetFor`, `lengthInstruction` in `packages/core/src/agents/word-budget.ts`): `writeUp.maxOutputTokens`, default 2,700 tokens, about 900 words. In an eval pass the baseline is made first and the swarm's write-up gets the baseline's own allowance.
- **The controller, not the model, makes it the run's answer.** The model returns paragraphs, a confidence and the handles it cites; the controller commits a `synthesis` one version past the latest draft, superseding it, with `stage: final`. Syntheses posted in the rounds stay short drafts (`stage: draft`), and `prompts/synthesizer.md` is unchanged. It is not a round: `write_up_started` and `write_up_completed` bracket it on the log, and the run's reason and status are what they would have been.
- **Its worst-case cost is held back from `maxCostUsd` from the first round** (`BudgetTracker`'s hold, `docs/budget-guardrails.md` §2): one call on the Synthesizer's model at the largest board and the full allowance, about $0.005 on `cheap`. The rounds cannot spend it; a cap that cannot cover it is refused at start with both figures; at the end the hold is released and the call is fitted, reserved, settled and traced (role `write-up`) like any other. A paid write-up is skipped when the month's budget is already spent. When the call fails, the last draft stays the answer and the reason is on the log.
- **A host that dies during the call** leaves `write_up_started` on the log; the resumed run finishes that same end instead of running more rounds, and does not pay twice.

Adopted on the step2a pass (`evals/results/2026-11-16-step2a`, `cheap` profile, the three development problems, $0.27):

| | Swarm, pilot 3 → step2a | Baseline, pilot 3 → step2a |
|---|---|---|
| api-rate-limiting | 65.3 → 79.2 % | 94.4 → 100.0 % |
| oidc-migration | 50.0 → 57.1 % | 73.8 → 90.5 % |
| teen-reading-programme | 52.4 → 71.4 % | 88.1 → 92.9 % |
| Mean | 55.9 → 69.2 % | 85.4 → 94.4 % |

The swarm rose on every problem and the complaints about hedging and unresolved lists are gone from the judge's reasons; the judge's spread between orders was 3.0 points. The baseline rose too, because the same pass fixed its truncation (0.4 words per output token instead of 0.6), so the gap narrowed only from 29.6 to 25.2 points. Three pairs are a small sample; the direction on all three, well outside the judge's spread, is what the adoption rests on.

## Consequences

- `+` A run always leaves an answer written from everything on the board, however it ended, a user's stop included, and that answer is what every reader of "the run's answer" finds.
- `+` The answer's money cannot be spent by the rounds, and a run that could not afford its answer does not start.
- `+` Both eval arms are asked for the same length in the same words.
- `−` The rounds have less to spend: about a sixth of a $0.03 cap on `cheap`, a third of the default $0.25 on `quality` (Sonnet, about $0.085). In the step2a pass no run was cut short by it.
- `−` One more call per run, and a stop now waits for it (seconds on Haiku, up to a few minutes on a local model).
- `−` Known gaps after the pass: Haiku wrote 531 to 591 of the 900 words it was asked for, about half the baseline's length; one answer still said "which the board does not establish" and stated its own confidence. Both are taken up with Step 2b (the prompt no longer calls its material "the board", and asks for the length to go to concrete figures).
- `−` Tokens and wall-clock may overshoot their limits by this one call, as they may by one round.

## Alternatives considered

- **A longer, stricter Synthesizer prompt for every draft** — rejected: drafts are written mid-run from a bounded view, several times a run; making each one long multiplies the cost and still writes from part of the board.
- **Pay for the write-up from whatever the run has left** — rejected: a run that ends on its cost cap, the commonest paid ending, would have nothing left to write its answer with.
- **Raise the cap by the write-up's cost instead of holding it back** — rejected: the cap is the user's number, and in the eval both arms share it; the write-up comes out of it, not on top of it.
- **Let the model state version, `supersedes` and stage** — rejected: models got version bookkeeping wrong in the dev rehearsals (several live syntheses), and a stage a model can set is a stage an agent can claim in a round.
- **Treat the write-up as a thirteenth round** — rejected: it would break the round cap's meaning and every count of rounds; two events of its own keep the log honest.
- **Filter the text for words like "board" or for handle-like tokens** — rejected: "board games", "Q3" and "a confidence survey" are honest words in these very problems; the instruction is the prompt's to carry.
