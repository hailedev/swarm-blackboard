# ADR-0003: Use the Vercel AI SDK as a thin provider layer and no agent framework

- **Status:** accepted
- **Date:** 2026-11-07

## Context

Agents need structured output (validated contributions), tool calling (later), streaming, and the ability to run on either the Anthropic API or a local Ollama server, selectable per role. Several agent frameworks exist (LangGraph, CrewAI, Microsoft Agent Framework, Claude Agent SDK); each ships its own control loop.

## Decision

Use the **Vercel AI SDK** (`ai`) as the only model-access layer:

- `@ai-sdk/anthropic` for Claude
- `ollama-ai-provider-v2` for local models (native tool calls and thinking mode)
- `@ai-sdk/openai-compatible` against Ollama's OpenAI-compatible endpoint as the fallback if the community provider misbehaves

`packages/core` never imports the SDK. It depends on a small `Model` interface of our own (`generateObject`, `generateText`, token accounting); `packages/providers` implements it with the SDK and a `FakeModel`. Pin all SDK versions exactly.

**No agent framework.** The controller loop, eligibility, selection and termination are our code in `packages/core`.

## Consequences

- `+` One interface for structured output, tools and streaming across providers; swapping a role's provider is a line in `agents.yaml`.
- `+` The SDK is replaceable: only `packages/providers` would change.
- `+` The control loop is exactly as complex as the blackboard needs — a few hundred lines — and fully testable with `FakeModel`.
- `−` AI SDK major versions move quickly; pinning and the `Model` interface are the mitigation.
- `−` The Ollama provider is community-maintained; the OpenAI-compatible fallback is the mitigation.
- `−` We forgo framework features such as built-in checkpointing and tracing UIs. Checkpointing is covered by the append-only event log (ADR-0004); tracing is a first-class table and UI in this app.

## Alternatives considered

- **Raw vendor SDKs** (`@anthropic-ai/sdk`, `ollama`) — rejected: structured-output and tool plumbing would be duplicated per provider.
- **LangGraph / CrewAI / Microsoft Agent Framework** — rejected: they model fixed graphs or manager-led chats. Blackboard control is dynamic and board-driven; a framework would fight the design and obscure the loop we most need to understand.
- **Claude Agent SDK** — rejected for v1: it brings a full tool-using harness (files, shell, subagents) that text-only reasoning agents don't need. Revisit when coding tasks and a sandbox arrive in Phase 6.
