# ADR-0001: Use a blackboard topology rather than orchestrator–workers

- **Status:** accepted
- **Date:** 2026-11-07

## Context

The app exists to let several LLM agents collaborate on open-ended problems — research, analysis, design decisions, planning — where the decomposition is not known in advance and the best next step depends on what has been discovered so far. A topology had to be chosen before anything else, because it dictates the data model, the control loop and the UI.

## Decision

Use a **blackboard**: a shared, typed board of entries; agents as *knowledge sources* that read the board and contribute to it when their trigger conditions are met; and a *controller* that each round decides which eligible agents act, commits their contributions, checks for conflicts and decides whether to stop.

Agents are specialists by role (Planner, Researcher, Solver, Critic, Synthesizer in v1), not by subproblem. The board, not a plan, is the coordination mechanism.

## Consequences

- `+` Handles problems whose structure emerges during solving; no planner has to be right up front.
- `+` Full provenance: every contribution is an entry with links to what it was based on.
- `+` Agents are independently testable — each is a function of a board view.
- `+` Adding or removing an agent changes configuration, not the control flow.
- `−` The controller is custom code: eligibility, selection, conflict handling and termination all have to be designed and tested (see `docs/PLAN.md` §2.3).
- `−` Without strong eligibility rules and budgets a blackboard degenerates into noise; stall detection and hard caps are mandatory, not optional.
- `−` Orchestrator–workers is more predictable for well-structured tasks. It may return later as a *sub-pattern* (a Planner spawning a bounded worker fan-out for one subproblem) without changing this decision.

## Alternatives considered

- **Orchestrator–workers** — a planner decomposes, workers execute, planner synthesises. Rejected for v1: the planner becomes a single point of failure on open-ended problems, and reframing mid-run is awkward. Likely to be adopted as a sub-pattern in Phase 6.
- **Group chat / free-form swarm** — agents converse in a shared transcript. Rejected: token cost grows with transcript length, agents converge on each other's views, and there is no natural termination.
- **Fixed pipeline / graph** — predetermined stages with conditional routing. Rejected: cannot adapt to what is discovered; fine for repeatable workflows, wrong for open-ended reasoning.
