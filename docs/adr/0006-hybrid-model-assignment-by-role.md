# ADR-0006: Assign models to roles, hybrid Claude + local Ollama

- **Status:** superseded by ADR-0009 (fallback moved from role to profile; per-role model assignment stands)
- **Date:** 2026-11-07

## Context

A swarm makes many model calls per run. Frontier-model quality matters most in the roles that steer the run (planning, critique, synthesis); the worker roles (research, solving) are called most often. A Mac mini (M4 Pro, 64 GB unified memory) running Ollama is available on the local network.

## Decision

Model assignment is **per role, in `agents.yaml`**, never in code. v1 defaults:

| Role | Provider | Notes |
|---|---|---|
| Planner, Critic, Synthesizer | Claude Sonnet | Control-quality roles |
| Researcher, Solver | Local Ollama model | `fallback: anthropic` on schema failure |
| Bidder (Phase 5) | Claude Haiku | Reassess against a local model on measured reliability |

Every local role declares a fallback. The repair path is: validate → one repair prompt → fallback provider for that call → discard and log. The specific local model is an open question to be settled by a Phase 2 trial, ranking structured-output reliability first and reasoning quality second, and recorded as a new ADR.

## Consequences

- `+` Near-zero marginal cost for worker-heavy rounds; frontier quality where it steers the run.
- `+` Any role can be flipped to any provider for an A/B in the eval harness, including an all-Claude configuration as a baseline.
- `−` Two failure modes to diagnose (API and local). Per-role failure rates are tracked in the trace so a role that fails often can be flipped on evidence.
- `−` Local models are weaker at schema-conformant output; the repair/fallback path is mandatory, not optional.
- `−` The Ollama host must be reachable from wherever the server runs; `OLLAMA_BASE_URL` is configuration.

## Alternatives considered

- **Claude only** — simplest and highest quality; rejected as the default on cost, but retained as a one-line configuration for baselines and for any role that local models can't handle.
- **Local only** — zero API cost; rejected: weak agents make coordination failures indistinguishable from model failures, which defeats the purpose of v1.
