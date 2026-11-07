# ADR-0005: Agents communicate only through the board

- **Status:** accepted
- **Date:** 2026-11-07

## Context

Multi-agent systems drift toward direct agent-to-agent messaging, hand-offs and shared scratch state because it feels faster. Each such channel is invisible to the board, the UI and the tests, and is where debugging a swarm becomes miserable.

## Decision

An agent is a function of `(boardView, config) → contributions`. It has no reference to any other agent, no channel to one, and no state that outlives a round. All coordination is mediated by the controller through board entries. If one agent needs something from another, it posts a `question` entry; another agent answers it in a later round.

## Consequences

- `+` Every interaction is a board entry, so every interaction is visible in the UI, persisted in the log and replayable.
- `+` Agents can be tested in isolation with `FakeModel` and a hand-built board view.
- `+` Agents can be added, removed or re-pointed at different models without touching other agents.
- `+` The Critic's independence is structural, not a matter of prompt discipline.
- `−` A clarifying exchange between two agents costs at least one round boundary. Accepted: the latency is small next to a model call, and the exchange becomes inspectable.
- `−` Patterns such as "hand this thread to a specialist" must be expressed as entries (a `subproblem` claimed by a role), not calls.

## Alternatives considered

- **Direct hand-offs between agents** (as in several frameworks) — rejected: invisible to the board and the tests; breaks provenance.
- **Shared scratchpad outside the board** — rejected: a second, unstructured source of truth.
