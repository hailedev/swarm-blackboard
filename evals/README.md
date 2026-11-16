# Evals

The swarm against a single strong model at equal cost, on ten open-ended problems, judged blind (docs/PLAN.md §6 Phase 5, ADR-0012). Evals measure quality, not correctness: they are not part of `pnpm test` and never gate a commit.

## Running a pass

```
pnpm eval --fake                                  # scripted swarm, baseline and judge; nothing billed
pnpm eval --profile dev --limit 2                 # real local models, zero API spend
pnpm eval --profile cheap --yes --label pass1     # a paid pass: Haiku-led swarm, Sonnet baseline and judge
```

- The swarm runs on the profile (`agents.yaml`); the baseline and the judge are the profile's `evals` entry there. A free profile evaluates with free models.
- Every call is traced into `model_calls` in the usual database, tagged `eval-baseline` or `eval-judge` with `runId` `eval:<pass id>`; API-billed calls count in the month's ledger like any other.
- A paid pass prints the banner and needs `--yes` (or a yes at the prompt). It is refused when the month cannot absorb its cap.
- Caps: `--max-cost` on the pass (default $1.00) and `--run-cap` on each swarm run and each baseline call (default $0.03; $0.10 under `--fake`, whose scripted prices are far higher): equal budget means the same cap for both arms (ADR-0013). See docs/budget-guardrails.md §9.
- Per problem the baseline comes first, then the swarm run, then the judge. The swarm's answer is its **final write-up**: when the run ends, the Synthesizer's model writes the answer once more from the whole board (docs/PLAN.md §2.3 step 9), with the output allowance the baseline got and so the same word budget. Its cost is part of the run's cap, held back from the first round.
- `--judge-orders 2` (the default) judges each pair in both orders; `--seed` fixes the first order.

## Development set and held-out problems

While Phase 5's Step 2 changes the controller, three problems are the development set: `api-rate-limiting`, `oidc-migration` and `teen-reading-programme`. Every pilot, rehearsal and per-change pass runs on those three (`--problems api-rate-limiting,oidc-migration,teen-reading-programme`), on `dev` as well as on a paid profile. The other seven are held out: nothing runs on them until one full pass at the end of Step 2, so that pass measures the swarm on problems no change was tuned against.

## Output

`evals/results/<date>-<label>/`:

- `report.md` — header (commit, profile, models, caps, spend), the result table, per-problem rows, then:
  - **Answers**: per problem, the words each arm wrote against the words it was asked for, whether the swarm's answer is its final write-up or a draft (and why), whether the write-up needed a second attempt and whether it is still under half its word budget, what the write-up cost, and whether the baseline was truncated;
  - **Closing the loop**: per swarm run, beside its rounds and how it ended, the critiques resolved of those raised (resolved = a hypothesis names the critique in `resolves`), those replaced without being named and those still open by severity; model calls rejected of made; replies trimmed to a role's limit; rivals declared, decisions and the hypotheses they rejected; drafts; live subproblems done / claimed / open; and two counts that should read 0, hypotheses that name critiques yet supersede nothing and subproblems left with a second answer nobody declared a rival. These are counts from the run's board, event log and traced calls, not judgements;
  - honesty notes, including a draft judged in place of a write-up and arms asked for different lengths;
  - **Where the swarm scored 0 or 1**: every criterion on which a judgement gave the swarm 0 or 1 of 3, with the judge's reason and the baseline's score on the same criterion;
  - which pairs were written out.
- `report.json` — everything the report was rendered from.
- `pairs/<problem>.md` — three pairs in full for the human spot-check: the swarm's widest win, the baseline's, and the closest call.

Baseline answers are cached in `evals/results/baselines/<problem>--<model>.json`, committed, so a later pass compares a new swarm with the same baseline instead of paying for it again. The report notes when a cached baseline's cap has drifted from the swarm's current cost; `--refresh-baselines` redoes them. `pnpm eval --fake` writes under `evals/results/fake/`, which is ignored by git.

## Adding a problem

One markdown file in `evals/problems/`, `NN-slug.md`, with a YAML front matter:

```yaml
---
id: slug                      # lower-case letters, digits and hyphens; unique
title: …
domain: …
constraints:
  - "…"                       # quote items: a colon in an unquoted item is a YAML mapping
successCriteria:
  - "…"
rubric:                       # 3–6 criteria
  - id: coverage
    weight: 3                 # 1–3
    criterion: What a good answer does.
    scale: "0 = …; 1 = …; 2 = …; 3 = …"
---
The statement both arms receive, verbatim.
```

The statement, constraints and success criteria go to the swarm as its `problem` entry and to the baseline as its prompt. The baseline answers as an array of paragraphs that the harness joins with a blank line, the shape the Synthesizer uses, because a local model under a JSON `format` may not be able to emit a line break inside a string (ADR-0008). Its prompt ends with the length it has, as a word count derived from the output allowance that fits the cap (0.4 words per output token less 15 % for the JSON, `wordBudgetFor` in `packages/core/src/agents/word-budget.ts`: Sonnet spends about two output tokens on each word of a structured answer, so a $0.03 cap asks for about 900 words); an answer that still uses its whole allowance is reported as truncated. Before judging, every board handle (H16, E24, …) is removed from both answers so the judge cannot tell the arms apart; the report and the pair files keep the original text. The judge sees the statement, the constraints, the success criteria, each criterion with its scale (not its weight) and the two answers as "Answer A" and "Answer B". A problem should be answerable from general knowledge in text, since v1 agents have no tools.

## Reading a report

Ten pairs is a small sample. The report prints the judge's own consistency (how far the two orders' scores differed) and how often it preferred whichever answer it saw first; a difference between arms smaller than the consistency figure is noise. Adopt or reject a controller change on the targeted metric and on the score moving the right way across passes (the ADRs 0013 onward record each decision), not on one pass alone.
