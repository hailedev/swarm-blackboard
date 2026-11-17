# ADR-0016: The final write-up is shown no draft, and is asked for once more when it says where it came from

- **Status:** accepted
- **Date:** 2026-11-17

## Context

Two faults of the final write-up (ADR-0014) were noted on the passes of 2026-11-17 and left alone until the next change to the controller, so that those passes measured one thing at a time.

- **It copied from a stale draft.** The write-up was shown the latest draft "for structure". A draft is written in a round, beside the hypotheses of that same round, so it can be behind them. In the step2b teen run the answer said "150 passes", from draft A6, where the standing hypothesis H24 of the same round said 200 (ADR-0015, Consequences).
- **It stated its own confidence.** `prompts/write-up.md` forbids any mention of the board, the agents or the writer's confidence. On the control pass two answers of three ended "Confidence is moderate: …" and "Confidence is held below 0.8 because …"; on the step2a pass one said "which the board does not establish". The judge noticed. The prompt alone does not hold.

ADR-0014 rejected filtering the text for words like "board", because "board games", "Q3" and "a confidence survey" are honest words in these very problems. That objection stands, and this decision is shaped by it.

Decided by Hai on 2026-11-17, before the closing measurement of Phase 5.

## Decision

- **No synthesis is shown to the write-up.** The "Latest draft of the answer" section is gone from the prompt (`renderWriteUpPrompt`), and `prompts/write-up.md` no longer speaks of a draft. The writer is given what the drafts were made of: decisions, hypotheses with their evidence and standing critiques, other evidence, open questions, subproblems. A critique whose target is a draft is left out with it and counted among those not shown. The write-up still supersedes the latest draft and takes the next version.
- **A write-up that mentions the board, the agents or its writer's confidence is asked for once more.** `findLeaks` (`packages/core/src/agents/write-up-leaks.ts`) returns the offending sentences. It looks for phrases, not words: the board or the notes as something that knows or holds things ("the board does not establish", "the working notes"), agents as the ones who did the work ("the agents disagreed", "one agent proposed", "swarm"), and confidence as the writer's own (a clause that opens "Confidence is moderate" or "Confidence: 0.7", "our confidence", "confidence in this plan", "high confidence"). A family of phrases whose word the problem statement itself uses is not looked for at all.
- **It never edits an answer.** What it finds goes back to the model: the second request quotes the sentences, gives the first answer to build on, and asks for the whole answer again.
- **One retry covers both guards.** The length guard of ADR-0015 and this one share a single second attempt that names everything that was wrong. Of the two answers the controller keeps the one that is not short before one that is, then the one with fewer such sentences, then the longer. A second attempt that fails, or that the run cannot pay for, leaves the first.
- **The log says what happened.** `write_up_completed` gains `retriedFor` (`short`, `leak`) and `leaks` (the sentences the answer kept still contains), both with defaults, so older logs read as before.

Checked before use against every answer already in `evals/results` (54 distinct answers): it finds all three write-ups known to have leaked and nine of the eleven pre-write-up drafts, and nothing in any of the 16 single-call baseline answers.

## Consequences

- `+` The write-up cannot copy a figure from a draft that the hypotheses have moved on from.
- `+` A leak that the prompt did not prevent gets one more chance, and one that survives is on the log and in the eval report instead of being found by the judge.
- `+` No answer is altered by code: what the reader gets is what a model wrote.
- `−` The writer loses the draft's structure. A draft was the only place the Synthesizer's own ordering of the answer was visible; the write-up now orders it from the success criteria alone.
- `−` A critique of a draft is no longer shown. If the Critic said something of a draft that it did not also say of a hypothesis, the write-up does not see it.
- `−` The check is a list of English phrases. It will miss a leak worded another way ("the analysis so far leaves this open"), and it can take an honest sentence for one where a problem's answer speaks of a board or of confidence and its statement does not. A false alarm costs one more call (about a fifth of a cent on Haiku, a minute or two locally) and leaves a flag on the log; it does not change which answer is better.
- `−` One more call on some runs, on what the run has left after the first; nothing is held back for it.

## Alternatives considered

- **Keep the draft and tell the model to prefer the hypotheses where they disagree** — rejected: the prompt already told it to use the draft for structure only, and it copied a figure.
- **Show the draft's headings only** — rejected: more machinery for what the success criteria already give.
- **Strip or rewrite the offending sentences in code** — rejected, as in ADR-0014: code would be writing part of the answer, and a sentence cut from the middle of a paragraph leaves a hole.
- **Match the bare words** ("board", "agent", "confidence") — rejected for the reason ADR-0014 gave; the phrases and the problem-statement exemption are what answer it.
- **A retry for each guard** (up to three calls) — rejected: one request can say everything that was wrong, and a third call has no money held for it.
- **Make a leaking answer void** — rejected: it is still the run's answer, and a reader is better served by it than by a draft; it is flagged instead.
- **Ask a model whether the answer leaks** — rejected: a paid call per run to check three kinds of sentence.
