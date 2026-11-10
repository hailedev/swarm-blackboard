# ADR-0013: Claude roles run without thinking by default, and the eval's two arms share one cap

- **Status:** accepted
- **Date:** 2026-11-10

## Context

The first two paid pilot passes of the eval harness (ADR-0012; `evals/results/2026-11-10-pilot-attempt-1` and `-attempt-2`, $0.34 together) produced no clean comparison: every Sonnet baseline call used its whole output allowance and returned little or no text, and one of the two Sonnet judge calls ran out of its allowance too. The traces showed why. Claude Sonnet 5.5 and Claude Haiku 5.5 run adaptive thinking when a request says nothing about it, the thinking tokens are billed as output and count against `max_tokens`, and the Anthropic adapter (`packages/providers/src/anthropic.ts`) never set the parameter. A Sonnet baseline spent 1,814 output tokens and wrote nothing; the swarm's own Haiku calls returned 0.7 to 1.5 characters of JSON per output token where plain JSON runs about 3.5, so roughly half to three quarters of every Haiku call's output tokens, and dollars, since Phase 2 had been hidden thinking; two Haiku synthesizer calls in the pilot were truncated at the 4,096-token allowance by it.

Two eval design points were exposed at the same time. Capping the baseline at what the swarm *spent* (ADR-0012) ties the baseline's room to a figure that changes with every controller change and, once thinking is off, shrinks to a few hundred tokens. And the judge's schema asked for a score before its reason, so the model graded before it argued.

## Decision

- **`think` on an alias governs Claude models too.** `think: false` turns thinking off the way each model allows: `thinking: { type: "between_tools" }` on Claude Sonnet 5.5, which rejects `disabled` and offers that as its lowest setting (with no tools in play it is off), and `thinking: { type: "disabled" }` on every other model; `think: true` asks for adaptive thinking explicitly; an alias that says nothing leaves the model's own default. The `sonnet` and `haiku` aliases in `agents.yaml` carry `think: false`, so every swarm role on them, the eval baseline and the judge run without thinking. `sonnet-think` and `haiku-think` keep it on for experiments; Phase 5's Step 2 measures thinking on for the Critic and the Synthesizer as one of its controller changes.
- **Reasoning tokens are recorded everywhere.** `Usage` gains `reasoningTokens`, the part of `outputTokens` a model spent thinking, read from the SDK's `outputTokenDetails.reasoningTokens`; it rides in every trace, event total and entry, in a new `reasoning_tokens` column of `runs`, `entries` and `model_calls` (migration `0001`), in the API's call summaries, in the web cost meter ("N of them thinking"), the trace viewer and the CLI summary, and in the eval report per arm. Old logs and rows read as zero or null. Cost is unchanged: those tokens were always billed as output.
- **Equal budget means the same cap for both arms.** `pnpm eval` caps each swarm run and each baseline call at the run cap, default **$0.03** (`--run-cap`), the smaller of that and what the pass has left. The baseline's prompt still states the words its fitted allowance buys (ADR-0012, amendment), and a cached baseline is flagged when its cap drifts more than 25 % from the pass's run cap.
- **The judge argues before it grades.** Each criterion's object is `{ reason, score }` in that order in the schema, with a 4,096-token allowance. Whether the provider keeps that order is checked empirically on each pass's judge responses, not assumed.

## Consequences

- `+` A paid swarm run costs a fraction of what it did and no longer truncates its synthesizer on thinking; the eval baseline fits its cap; the judge finishes.
- `+` Thinking is a visible, configurable cost: the cost meter and the report say how many tokens went to it, and a role can be given thinking back by changing one alias.
- `+` Both eval arms are sized by the same number, so a controller change that makes the swarm cheaper does not shrink its opponent.
- `−` Every paid measurement before this ADR, the recorded `cheap` run of Phase 2 included, was taken with thinking on and the allowance partly eaten; costs and truncations in those traces are not comparable with runs after it.
- `−` The Claude roles may answer worse without thinking; that is what Step 2's measurement is for, with the `-think` aliases.
- `−` A $0.03 baseline buys Sonnet about 2,500 output tokens; longer problems may still be judged on a short answer, and the report says when one was truncated.
- `−` The schema order is a request, not a guarantee; if a provider reorders keys, the check on the judge responses will say so and the prompt will have to carry the instruction alone.

## Alternatives considered

- **Lower effort instead of thinking off** — rejected for the swarm: effort still thinks and still spends the allowance, only less; it is the right lever once thinking is deliberately on, and the `-think` aliases can carry an effort setting later.
- **Keep thinking and raise the allowances** — rejected: the eval cap is a dollar figure, and raising the swarm's 4,096 allowance would only move the truncation and the spend.
- **Baseline capped at the swarm's spend (ADR-0012)** — rejected: it makes the baseline's room a function of the controller under test, and it collapses once the swarm is cheap.
- **Score before reason** — rejected: a grade written first is justified afterwards; the reason first is the cheaper way to get a considered score.
- **Reasoning tokens in the trace only** — rejected: the cost meter and the eval report are where a reader looks for where the money went.
