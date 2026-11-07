# Architecture decision records

One file per decision. Accepted ADRs are never edited; a change is a new ADR that supersedes the old one. Copy `0000-template.md` to start a new record.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-blackboard-over-orchestrator-workers.md) | Blackboard topology rather than orchestrator–workers | accepted |
| [0002](0002-typescript-monorepo.md) | TypeScript monorepo | accepted |
| [0003](0003-ai-sdk-provider-layer-no-agent-framework.md) | Vercel AI SDK as a thin provider layer; no agent framework | accepted |
| [0004](0004-append-only-board-with-supersede.md) | Append-only board with supersede links | accepted |
| [0005](0005-agents-communicate-only-via-board.md) | Agents communicate only through the board | accepted |
| [0006](0006-hybrid-model-assignment-by-role.md) | Hybrid model assignment by role (Claude + local Ollama) | accepted |
| [0007](0007-sqlite-local-first.md) | SQLite, local-first, Postgres-portable schema | accepted |

Expected next: ADR-0008 recording the local model chosen for the worker roles after the Phase 2 trial.
