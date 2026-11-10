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
- Caps: `--max-cost` on the pass (default $1.00) and `--run-cap` on each swarm run (default $0.08). The baseline is capped at what that problem's swarm run cost. See docs/budget-guardrails.md §9.
- `--judge-orders 2` (the default) judges each pair in both orders; `--seed` fixes the first order.

## Output

`evals/results/<date>-<label>/`:

- `report.md` — header (commit, profile, models, caps, spend), the result table, per-problem rows, honesty notes, and which pairs were written out.
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

The statement, constraints and success criteria go to the swarm as its `problem` entry and to the baseline as its prompt. The judge sees the statement, the constraints, the success criteria, each criterion with its scale (not its weight) and the two answers as "Answer A" and "Answer B". A problem should be answerable from general knowledge in text, since v1 agents have no tools.

## Reading a report

Ten pairs is a small sample. The report prints the judge's own consistency (how far the two orders' scores differed) and how often it preferred whichever answer it saw first; a difference between arms smaller than the consistency figure is noise. Adopt or reject a controller change on the targeted metric and on the score moving the right way across passes (the ADRs 0013 onward record each decision), not on one pass alone.
