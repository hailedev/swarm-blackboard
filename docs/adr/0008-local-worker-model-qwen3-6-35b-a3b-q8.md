# ADR-0008: Use qwen3.6:35b-a3b-q8_0, thinking off, as the local model for the worker roles

- **Status:** accepted
- **Date:** 2026-11-09
- **Amended:** 2026-11-09, re-run after agents moved to handles (section at the end); the decision stands, the ranking does not
- **Amended:** 2026-11-10, alias `local-fast` (`qwen3.6:35b-mlx`) for the `dev` profile; `local` and the paid profiles are unchanged
- **Amended:** 2026-11-10, line-break probe (last section): the synthesis is written as an array of paragraphs that core joins, because the MLX build never emits a newline inside a JSON string

## Context

ADR-0006 left the local model for the Researcher and Solver to a Phase 2 trial, ranking structured-output reliability first and reasoning quality second (docs/PLAN.md §4). Three candidates were pulled on the Mac mini (Ollama 0.40.15): `qwen3.6:35b-mlx` (safetensors, the MLX runner), `qwen3.6:35b-a3b-q8_0` (GGUF) and `qwen3.8:27b` (GGUF). Hai asked that the JSON-schema `format` be verified on the MLX runner before any `-mlx` tag stays in a worker role.

The trial (`pnpm trial:local --reps 3`, results in `evals/results/local-model-trial-2026-11-09.json`) ran every call through the same Ollama adapter the swarm uses, with the real role prompts, three sample boards (decomposed, mid-run, late) carrying real UUID v7 ids, and the trigger's targets rotated per repetition so Ollama's KV cache could not answer the same prompt twice. Each model was warmed first; latencies exclude model loads. 81 role calls and 18 raw `format` probes, all local, nothing billed.

## Decision

- `agents.yaml` alias `local` is `qwen3.6:35b-a3b-q8_0` with `think: false`, and every profile's Solver uses `local`, not `local-think`. The `local-think` alias (same model, `think: true`) stays defined for experiments but no profile uses it.
- `-mlx` tags are allowed in worker roles: the MLX runner honours a JSON-schema `format`. `qwen3.6:35b-mlx` lost on link validity, not on the runner.
- The adapter's defaults stand: `num_ctx` 32 768, and for thinking models `OLLAMA_THINK_TOKENS` (8 192) on top of the output allowance.

## Evidence

### Is `format` honoured?

Raw `/api/chat` calls with the schema as `format`, three different prompts each.

| Model | Runner | Strict enum/integer/array schema | Researcher schema (uuid patterns) |
|---|---|---|---|
| qwen3.6:35b-mlx | MLX | 3/3 | 3/3 |
| qwen3.6:35b-a3b-q8_0 | GGUF | 3/3 | 3/3 |
| qwen3.8:27b | GGUF | 3/3 | 3/3 |

Enum values, integer bounds and array bounds were respected on every probe on every runner. The uuid `pattern` is not enforced by any runner: ids are copied by the model, and a mangled or invented id is the only schema failure seen anywhere in the trial.

### Role trial

First-attempt outcome through the adapter (schema validation client-side), link validity from the controller's commit check, latency and output tokens per cell; n = 3 boards × 3 repetitions.

| Model | Role | Think | n | Valid % | Truncated % | Schema % | Provider % | Links OK % | Median s | p90 s | Median out tok |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3.6:35b-mlx | researcher | off | 9 | 100 | 0 | 0 | 0 | 77.8 | 14.0 | 18.7 | 1168 |
| qwen3.6:35b-mlx | solver | off | 9 | 100 | 0 | 0 | 0 | 66.7 | 7.6 | 15.4 | 652 |
| qwen3.6:35b-mlx | solver | on | 9 | 88.9 | 0 | 11.1 | 0 | 100 | 53.9 | 91.1 | 5098 |
| qwen3.6:35b-a3b-q8_0 | researcher | off | 9 | 100 | 0 | 0 | 0 | 100 | 20.8 | 24.5 | 1000 |
| qwen3.6:35b-a3b-q8_0 | solver | off | 9 | 100 | 0 | 0 | 0 | 100 | 13.1 | 22.5 | 600 |
| qwen3.6:35b-a3b-q8_0 | solver | on | 9 | 100 | 0 | 0 | 0 | 77.8 | 92.0 | 116.9 | 4230 |
| qwen3.8:27b | researcher | off | 9 | 100 | 0 | 0 | 0 | 88.9 | 32.7 | 41.5 | 607 |
| qwen3.8:27b | solver | off | 9 | 100 | 0 | 0 | 0 | 100 | 19.5 | 54.7 | 394 |
| qwen3.8:27b | solver | on | 9 | 100 | 0 | 0 | 0 | 77.8 | 110.1 | 146.6 | 2239 |

### Ranking (reliability, then links, then speed)

| Rank | Model | Valid % (all cells) | Links OK % | Median s |
|---|---|---|---|---|
| 1 | qwen3.6:35b-a3b-q8_0 | 100 | 92.6 | 22.0 |
| 2 | qwen3.8:27b | 100 | 88.9 | 39.5 |
| 3 | qwen3.6:35b-mlx | 96.3 | 80.8 | 14.0 |

Thinking on the winner: every answer valid, but links fell from 100 % to 77.8 % and the median call went from 13 s to 92 s, with the solver spending some 3 600 tokens reasoning per call. In the earlier contract runs, before the extra thinking room, `qwen3.6:35b-mlx` with thinking on spent the whole 4 096-token allowance reasoning and returned nothing.

Reasoning quality was spot-checked on the samples in the results file rather than measured: the winner's hypotheses addressed the open critique and the human note on the mid-run and late boards, and its evidence named sources rather than URLs. Quality measurement proper is the Phase 5 eval harness.

## Consequences

- `+` Free, schema-valid worker output on the first attempt in this trial, so the repair and fallback paths are for the tail, not the norm; `dev` and `cheap` profiles can lean on the local roles.
- `+` The MLX question is settled empirically, and the probe (`probeOllamaFormat`) and the trial harness stay in the repo to re-run when a new model or Ollama release arrives.
- `−` Ids are the weak point of every local model: a wrong UUID fails the schema or the link check and costs a repair call. Worth considering in Phase 3 or 5: short reference aliases in the view (`#0c`) that core maps back to ids before validation.
- `−` Thinking is off for the Solver, so its reasoning is whatever fits in the answer; if the evals show weak hypotheses, `local-think` is one word away and the trial numbers say what it costs.
- `−` The winner is the slowest to load (38.7 GB, about 10 s warm) and the largest in memory; it still leaves room for one more resident model on 64 GB.

## Alternatives considered

- **`qwen3.8:27b`** — the same reliability, slightly worse link validity, and almost twice the latency.
- **`qwen3.6:35b-mlx`** — the fastest by far and the MLX runner honours `format`, but a schema failure in nine thinking calls and the lowest link validity (78 % researcher, 67 % solver). Revisit once ids are easier to copy.
- **Thinking on for the Solver** — rejected on this data: slower by 7× and less link-valid, with no measured quality gain.
- **`llama3.3:70b`** (present on the Mac mini) — not trialled: 42 GB at Q4 leaves no room for a second resident model and is far slower per token.

## Amendment, 2026-11-09: the same trial with handles

The hardening pass after Phase 2 made models reference entries by short handles (P1, S2, H3, …) instead of UUIDs, with every link field an enum of the handles the agent was shown (docs/PLAN.md §2.2). The trial was re-run unchanged otherwise (`pnpm trial:local --reps 3 --out evals/results/local-model-trial-2026-11-09-handles.json`, 81 role calls and 18 raw `format` probes, Ollama 0.40.15), with the per-call handle schema in place of the uuid-pattern schema. `handles` below is the size of the enum each call carried (5 on the decomposed board, 10 mid-run, 12 late).

### Is `format` honoured?

| Model | Runner | Strict enum/integer/array schema | Researcher schema (handle enums) |
|---|---|---|---|
| qwen3.6:35b-mlx | MLX | 3/3 | 3/3 |
| qwen3.6:35b-a3b-q8_0 | GGUF | 3/3 | 3/3 |
| qwen3.8:27b | GGUF | 3/3 | 3/3 |

### Role trial

| Model | Role | Think | n | Valid % | Truncated % | Schema % | Provider % | Links OK % | Median s | p90 s | Median out tok |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3.6:35b-mlx | researcher | off | 9 | 100 | 0 | 0 | 0 | 100 | 9.9 | 12.8 | 741 |
| qwen3.6:35b-mlx | solver | off | 9 | 100 | 0 | 0 | 0 | 100 | 6.1 | 8.2 | 415 |
| qwen3.6:35b-mlx | solver | on | 9 | 100 | 0 | 0 | 0 | 100 | 44.1 | 152.3 | 3528 |
| qwen3.6:35b-a3b-q8_0 | researcher | off | 9 | 100 | 0 | 0 | 0 | 100 | 15.1 | 21.5 | 656 |
| qwen3.6:35b-a3b-q8_0 | solver | off | 9 | 100 | 0 | 0 | 0 | 100 | 5.5 | 7.8 | 226 |
| qwen3.6:35b-a3b-q8_0 | solver | on | 9 | 100 | 0 | 0 | 0 | 100 | 59.8 | 103.9 | 2844 |
| qwen3.8:27b | researcher | off | 9 | 100 | 0 | 0 | 0 | 100 | 19.4 | 41.4 | 329 |
| qwen3.8:27b | solver | off | 9 | 100 | 0 | 0 | 0 | 100 | 14.5 | 31.9 | 252 |
| qwen3.8:27b | solver | on | 9 | 100 | 0 | 0 | 0 | 100 | 82.6 | 104.7 | 1519 |

### Ranking (reliability, then links, then speed)

| Rank | Model | Valid % (all cells) | Links OK % | Median s |
|---|---|---|---|---|
| 1 | qwen3.6:35b-mlx | 100 | 100 | 9.9 |
| 2 | qwen3.6:35b-a3b-q8_0 | 100 | 100 | 15.1 |
| 3 | qwen3.8:27b | 100 | 100 | 25.0 |

### What changed

- **Links are no longer a differentiator.** Every cell of every model is 100 % schema-valid and 100 % link-valid (previously 92.6 %, 88.9 % and 80.8 %). The handle enum removed the only failure mode the first trial found, on every runner.
- **The ranking is now decided by speed alone**, and there `qwen3.6:35b-mlx` leads: 9.9 s median against 15.1 s for the current `local` alias, with the same validity. The first trial's objection to the MLX build (link validity) no longer holds.
- **Thinking still buys nothing here.** With thinking on, every model stays valid and link-valid but takes 7–10× longer; the Solver stays on `think: false`.
- **The decision recorded above stands until Hai chooses otherwise.** `agents.yaml` keeps `local: qwen3.6:35b-a3b-q8_0`; switching `local` to `qwen3.6:35b-mlx` is a one-line change that this amendment supports but does not make. Reasoning quality was not measured in either trial; the Phase 5 evals are the place to compare the two on that.

## Amendment, 2026-11-10: `local-fast` for the `dev` profile

Hai's choice, on the numbers of the amendment above: the faster build goes where speed is all that is at stake, and nowhere else yet.

- **New alias.** `agents.yaml` gains `local-fast: { provider: ollama, model: qwen3.6:35b-mlx, think: false }`.
- **`dev` runs on it.** Every role of the `dev` profile (planner, researcher, solver, critic, synthesizer, bidder) uses `local-fast`. `dev` is the default profile and the one the web UI is developed against, so its turnaround matters most. In the handle re-run above the MLX build was as valid and as link-valid as `local` (100 % in every cell) and took 9.9 s against 15.1 s for the median researcher call; on the short solver answers the two were level (6.1 s against 5.5 s, with the MLX build writing 415 output tokens to 226).
- **`local` is unchanged.** It stays `qwen3.6:35b-a3b-q8_0`, and the worker roles of `cheap` and `quality` stay on it. Those are the profiles whose answers are kept and paid for, and neither trial measured reasoning quality; the Phase 5 evals compare the two builds on that before a paid profile moves.
- **`local-think` is unchanged** and still used by no profile.

Consequences:

- `+` A `dev` run spends about a third less time on its longer local calls, at no measured cost in validity.
- `−` `dev` and the paid profiles no longer share a worker model, so a `dev` run is not a rehearsal of the local half of a `cheap` run; a prompt change should be checked on the profile it is meant for.
- `−` A machine that runs both `dev` and a paid profile keeps two builds of the model resident. The Q8 build alone is 38.7 GB of the Mac mini's 64 GB; the size of the MLX build was not recorded in either trial, so whether both stay loaded together is something to watch in `ollama ps`, not something this record can promise.

## Amendment, 2026-11-10: line breaks under `format`, and paragraphs as an array

No local entry of either recorded run contained a newline (0 of 56 Q8 entries in the Phase 2 fixture, 0 of 28 MLX entries in a `dev` run), and the MLX build once wrote a literal `$$` where paragraph breaks belonged in its synthesis. Before Phase 5's evals judge answers, the question was whether the local models can put a line break inside a JSON string at all under Ollama's schema `format`, or whether long-form content has to arrive another way.

`pnpm trial:local --probe paragraphs` (`apps/cli/src/trial/paragraph-probe.ts`, results in `evals/results/paragraph-probe-2026-11-10.json`, Ollama at the Mac mini) asked each alias three times for the same two-paragraph explanation, first as one string under a system prompt that demanded a blank line between the paragraphs (`{ text: string }`), then as an array (`{ paragraphs: string[] }` with exactly two elements). The probe definitions live beside `FORMAT_PROBE` in `@team/providers` (`PARAGRAPH_PROBE`).

| Model | Alias | n | `text` valid | with `\n` | with blank line | with `$$` | `paragraphs` valid | Median s (text / array) |
|---|---|---|---|---|---|---|---|---|
| qwen3.6:35b-a3b-q8_0 | `local` | 3 | 3 | 3 | 3 | 0 | 3 | 3.7 / 2.7 |
| qwen3.6:35b-mlx | `local-fast` | 3 | 3 | 0 | 0 | 0 | 3 | 1.7 / 2.1 |

The two builds split. The Q8 build writes real paragraph breaks when asked; the MLX build never emits a newline, even when the system prompt spells out the two newline characters it wants, and runs the paragraphs together in one string. Both produce the array form every time.

### Decision

- **The synthesis is written as an array of paragraphs.** The schema a model answers against (`ModelReferenceSchemas`, `paragraphs: true`) gives the synthesis contribution `content: string[]`, one paragraph per element; `resolveHandles` joins them with a blank line at the moment handles become ids, so the board, the event log and everything after the agent keep `content` as one markdown string (`Contribution`, `paragraphs: false`). The Synthesizer's prompt describes `content` as paragraphs; a list is one paragraph per item. No other entry type changes: every other prompt asks for one to five sentences, which is one paragraph.
- **Why the array and not a prompt fix, when the rule was "neither can → array; both can → prompts":** one build can and one cannot, and the one that cannot is every role of `dev`, the profile the UI is developed against and the eval harness is rehearsed on. A prompt fix would leave `dev` answers as single blocks whatever the prompt says, while the array form worked on both builds in every probe (and costs an API model nothing). Core owning the separator also rules out placeholder tokens like `$$`.
- **`agents.yaml` is unchanged.** `local` stays the Q8 build for the paid profiles and `local-fast` stays `dev`'s; the evals compare the two on quality as planned, with answers that now break into paragraphs on both.

### Consequences

- `+` A `dev` synthesis renders as paragraphs in the answer panel (shown pre-wrapped, ADR-0011); the judge in Phase 5 sees the same shape of answer from every arm.
- `+` One probe, kept in the repo, settles the question for a new model or Ollama release in a dozen local calls.
- `−` The model-facing and stored contribution types differ for one field, so code that builds a synthesis for a model (the scripted scenario, tests) writes an array while the board reads a string. `UUID_MODEL_REFERENCES` exists for contract tests that let a model answer with ids.
- `−` The probe is three prompts per build at one temperature; it says the MLX build did not emit a newline when asked plainly, not that no prompt could make it.
