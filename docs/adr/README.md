# Architecture decision records

One file per decision. Accepted ADRs are never edited; a change is a new ADR that supersedes the old one. Copy `0000-template.md` to start a new record.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-blackboard-over-orchestrator-workers.md) | Blackboard topology rather than orchestrator–workers | accepted |
| [0002](0002-typescript-monorepo.md) | TypeScript monorepo | accepted |
| [0003](0003-ai-sdk-provider-layer-no-agent-framework.md) | Vercel AI SDK as a thin provider layer; no agent framework | accepted |
| [0004](0004-append-only-board-with-supersede.md) | Append-only board with supersede links | accepted |
| [0005](0005-agents-communicate-only-via-board.md) | Agents communicate only through the board | accepted |
| [0006](0006-hybrid-model-assignment-by-role.md) | Hybrid model assignment by role (Claude + local Ollama) | superseded by ADR-0009 |
| [0007](0007-sqlite-local-first.md) | SQLite, local-first, Postgres-portable schema | accepted |
| [0008](0008-local-worker-model-qwen3-6-35b-a3b-q8.md) | `qwen3.6:35b-a3b-q8_0`, thinking off, as the local worker model; `dev` runs on `local-fast` (`qwen3.6:35b-mlx`); the synthesis is an array of paragraphs core joins (2026-11-10 amendments) | accepted |
| [0009](0009-profiles-with-profile-level-fallback.md) | Model profiles in `agents.yaml`; fallback is a profile property | accepted |
| [0010](0010-host-package-one-ledger-and-phase-3-dependencies.md) | `packages/host` shares the Node adapters and the SQLite store; one spend ledger per machine; Phase 3 dependencies | accepted |
| [0011](0011-web-ui-stack-and-phase-4-dependencies.md) | Web UI on Vite and React; the browser folds the event log; force synthesis as a recorded request; Phase 4 dependencies | accepted |
| [0012](0012-eval-harness-equal-cost-baseline-blind-judge.md) | Eval harness: swarm vs a single-call baseline at equal cost, judged blind in both orders; eval models in `agents.yaml`; pass cap; cached baselines | accepted |
| [0013](0013-claude-thinking-off-by-default-and-one-cap-for-both-eval-arms.md) | Claude aliases run without thinking by default (`think: false`), reasoning tokens recorded everywhere; the eval arms share one cap ($0.03); the judge argues before it grades | accepted |
| [0014](0014-final-write-up-at-run-end.md) | Every run ends with a final write-up from the whole board, written for a reader who never saw it and asked for the baseline's word budget; its worst-case cost is held back from the cap from the first round (Phase 5, Step 2a, adopted on the step2a pass) | accepted |
| [0015](0015-close-the-loop-on-the-board.md) | Closing the loop on the board: critiques get answered and closed only by replacing their target, a subproblem takes one answer (new version or declared rival), no reply is rejected for its length, contradictions get decided, and a run completes only on a synthesis that has read everything (Phase 5, Step 2b). Adopted on its mechanics on the step2b pass; it did not improve answer quality (67.9 % against 69.2 %) | accepted |

