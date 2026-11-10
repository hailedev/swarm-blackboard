import { buildBoardView, type BoardEvent } from '@team/core';
import type { ModelCallDetail, ModelCallSummary } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { agentSpendOf, agentStatesOf, boardAt, feedOf, usageOf } from '../state/selectors';
import { elements, render, slices, text } from '../testing/markup';
import { recordedEvents, recordedRunId } from '../testing/recorded-run';
import { nextEnvelope, scriptedRun } from '../testing/scripted-run';
import { AgentPanel } from './agent-panel';
import { AnswerPanel } from './answer-panel';
import { LiveFeed } from './live-feed';
import { CallDetail, TraceTable } from './trace-viewer';

const events = recordedEvents();
const runId = recordedRunId();
const view = buildBoardView(runId, events);

describe('AnswerPanel', () => {
  it('shows the latest synthesis with its confidence and what it rests on', () => {
    const html = render(<AnswerPanel view={view} threshold={0.8} onSelect={() => undefined} />);
    expect(elements(html, 'answer')[0]?.['data-handle']).toBe('A4');
    const seen = text(html);
    expect(seen).toMatch(
      /^A4 Version 4 confidence 0\.60 \(the run completes at 0\.80(, and \d+ blocking critiques? (is|are) open)?\) · round 12 · 4 versions /,
    );
    expect(seen).toContain('Recommendation:');
    const a4 = view.byHandle('A4');
    if (a4?.type !== 'synthesis') throw new Error('A4 is not a synthesis');
    const rests = seen.slice(seen.indexOf('Rests on'));
    for (const cited of a4.payload.cites)
      expect(rests).toContain(view.handleOf(cited) ?? 'missing');
  });

  it('says there is no answer yet, and how one comes about', () => {
    const html = render(
      <AnswerPanel view={boardAt(runId, events, 2)} threshold={0.8} onSelect={() => undefined} />,
    );
    expect(elements(html, 'answer')).toEqual([]);
    expect(text(html)).toContain('No synthesis yet.');
    expect(text(html)).toContain('Force synthesis');
  });
});

describe('LiveFeed', () => {
  it('lists the events oldest first, linking each entry line to its entry', () => {
    const prefix = events.slice(0, 8);
    const html = render(
      <LiveFeed
        lines={feedOf(prefix, buildBoardView(runId, prefix))}
        follow
        onSelect={() => undefined}
      />,
    );
    const lines = slices(html, 'live-feed')[0] ?? '';
    expect([...lines.matchAll(/data-seq="(\d+)"/g)].map(([, seq]) => Number(seq))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(text(html)).toContain('Run started profile cheap · up to 12 rounds · cap $0.2500');
    expect(text(html)).toContain('Selected: planner planner: board is new');
    // Entry lines are buttons that open the entry; the rest are plain text.
    expect(
      [...lines.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label),
    ).toEqual(
      feedOf(prefix, buildBoardView(runId, prefix))
        .filter((line) => line.entryId !== null)
        .map((line) => line.title),
    );
    expect(text(render(<LiveFeed lines={[]} follow onSelect={() => undefined} />))).toBe(
      'Nothing has happened yet.',
    );
  });

  it('shows a refused call with the controller’s own explanation', async () => {
    const run = await scriptedRun();
    const detail =
      'invalid_request: prompt (~30000 tokens) plus output allowance (4096) and thinking allowance (8192) exceeds the 32768-token context of qwen3.6:35b-mlx';
    const failed: BoardEvent[] = [
      ...run.events,
      {
        ...nextEnvelope(run.events),
        type: 'agent_failed',
        round: 1,
        agentId: 'solver',
        reason: 'invalid_request',
        detail,
      },
    ];
    const html = render(
      <LiveFeed
        lines={feedOf(failed, buildBoardView(run.controller.runId, failed))}
        follow
        onSelect={() => undefined}
      />,
    );
    expect(text(html)).toContain(`✕ solver failed: request refused ${detail}`);
  });
});

describe('AgentPanel', () => {
  const call = (role: string, round: number, costUsd: number): ModelCallSummary => ({
    id: `${role}-${String(round)}`,
    runId,
    round,
    role,
    modelId: 'm',
    billing: 'api',
    at: '2026-11-09T06:49:40.000Z',
    outcome: 'ok',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd,
    estimateChars: 3_000,
    estimateCharsPerToken: 3,
    estimateTokens: 1_000,
    actualInputTokens: 1_000,
    latencyMs: 2_000,
    maxOutputTokens: 4_096,
    error: null,
    warningsJson: '[]',
    source: 'trace',
  });
  const profile = events[0]?.type === 'run_started' ? events[0].profile : null;

  it('shows each agent with the model the run resolved for it and what it has cost', () => {
    const html = render(
      <AgentPanel
        agents={agentStatesOf(events)}
        models={profile?.roles ?? null}
        spend={agentSpendOf(
          [call('planner', 1, 0.001), call('critic', 3, 0.002), call('critic', 5, 0.002)],
          null,
        )}
      />,
    );
    const rows = slices(html, 'agent-panel')[0] ?? '';
    expect(
      [...rows.matchAll(/data-agent="([a-z]+)" data-activity="([a-z]+)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    ).toEqual([
      ['planner', 'idle'],
      ['researcher', 'idle'],
      ['solver', 'idle'],
      ['critic', 'idle'],
      ['synthesizer', 'idle'],
    ]);
    const seen = text(html);
    expect(seen).toContain(
      'planner ○ idle haiku · anthropic/claude-haiku-5-5 · paid 1 call · 1.2K tokens · $0.0010 · 2.0s per call',
    );
    expect(seen).toContain(
      'researcher ○ idle local · ollama/qwen3.6:35b-a3b-q8_0 · free no calls yet',
    );
    expect(seen).toContain(
      'critic ○ idle haiku · anthropic/claude-haiku-5-5 · paid 2 calls · 2.4K tokens · $0.0040 · 2.0s per call',
    );
  });

  it('shows who is running in the round in flight, and why an agent failed', async () => {
    const run = await scriptedRun();
    await run.controller.runRound();
    await run.controller.runRound();
    const selected = run.events.findIndex((e) => e.type === 'agents_selected' && e.round === 2);
    const inFlight = run.events.slice(0, selected + 1);
    const running = render(
      <AgentPanel agents={agentStatesOf(inFlight)} models={null} spend={new Map()} />,
    );
    expect(text(running)).toContain('solver ● running model not recorded');
    expect(text(running)).toContain('planner ○ idle');

    const failedLog: BoardEvent[] = [
      ...inFlight,
      {
        ...nextEnvelope(inFlight),
        type: 'agent_failed',
        round: 2,
        agentId: 'solver',
        reason: 'network',
        detail: 'network: Ollama is unreachable',
      },
    ];
    const completed: BoardEvent[] = [
      ...failedLog,
      {
        ...nextEnvelope(failedLog),
        type: 'round_completed',
        round: 2,
        newEntries: 0,
        usage: usageOf([]),
      },
    ];
    const failed = render(
      <AgentPanel agents={agentStatesOf(completed)} models={null} spend={new Map()} />,
    );
    expect(text(failed)).toContain('solver ✕ failed');
    expect(text(failed)).toContain('Round 2: model unreachable — network: Ollama is unreachable');
    expect(text(failed)).toContain('researcher ○ idle');
  });
});

describe('the trace viewer', () => {
  const summary: ModelCallSummary = {
    id: 'call-1',
    runId,
    round: 2,
    role: 'solver',
    modelId: 'qwen3.6:35b-a3b-q8_0',
    billing: 'local',
    at: '2026-11-09T06:50:00.000Z',
    outcome: 'ok',
    inputTokens: 2_000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    estimateChars: 9_000,
    estimateCharsPerToken: 3,
    estimateTokens: 3_000,
    actualInputTokens: 2_100,
    latencyMs: 13_100,
    maxOutputTokens: 4_096,
    error: null,
    warningsJson: '[]',
    source: 'trace',
  };
  const refused: ModelCallSummary = {
    ...summary,
    id: 'call-2',
    role: 'critic',
    modelId: 'claude-haiku-5-5',
    billing: 'api',
    outcome: 'invalid_request',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    reasoningTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    actualInputTokens: null,
    latencyMs: 0,
    error: 'the prompt does not fit',
  };

  it('lists every call with its tokens against the estimate, its cost and its latency', () => {
    const html = render(
      <TraceTable calls={[summary, refused]} selectedId="call-2" onSelect={() => undefined} />,
    );
    const rows = [...html.matchAll(/<tr data-call-id="([^"]+)" aria-selected="(true|false)"/g)];
    expect(rows.map((row) => [row[1], row[2]])).toEqual([
      ['call-1', 'false'],
      ['call-2', 'true'],
    ]);
    const cells = (id: string): string =>
      text(
        html.slice(
          html.indexOf(`data-call-id="${id}"`),
          html.indexOf('</tr>', html.indexOf(`data-call-id="${id}"`)),
        ),
      );
    // Prompt tokens are what the model read (cache reads included), beside the estimate.
    expect(cells('call-1')).toMatch(
      /2 solver qwen3\.6:35b-a3b-q8_0 local ✓ ok 2\.1K \(3\.0K\) 500 \(0\) \$0\.0000 13\.1s /,
    );
    // A refused call has no usage: dashes, not zeros.
    expect(cells('call-2')).toMatch(
      /2 critic claude-haiku-5-5 paid ✕ invalid_request — \(3\.0K\) — \(—\) — 0\.0s /,
    );
    expect(
      text(render(<TraceTable calls={[]} selectedId={null} onSelect={() => undefined} />)),
    ).toBe('No model calls have been traced for this run.');
  });

  it('shows one call in full: what was sent, what came back, and what went wrong', () => {
    const detail: ModelCallDetail = {
      ...summary,
      system: '# Solver\nYou are the Solver.',
      prompt: 'Round 2 of 12.',
      responseJson: '{"contributions":[{"type":"hypothesis"}]}',
      warningsJson: '["unsupported setting: seed"]',
    };
    const html = render(<CallDetail call={detail} error={null} onClose={() => undefined} />);
    const seen = text(html);
    expect(seen).toContain('solver · round 2 · qwen3.6:35b-a3b-q8_0');
    expect(seen).toContain(
      'output 500 of 4.1K allowed, thinking 0 · estimate 9.0K chars at 3.00 per token',
    );
    expect(seen).toContain('Warnings unsupported setting: seed');
    expect(seen).toContain('System prompt # Solver You are the Solver.');
    expect(seen).toContain('Prompt Round 2 of 12.');
    // The response is pretty-printed JSON.
    expect(html).toContain('{\n  &quot;contributions&quot;: [');

    const broken = render(
      <CallDetail
        call={{ ...detail, ...refused, system: null, prompt: null, responseJson: null }}
        error={null}
        onClose={() => undefined}
      />,
    );
    expect(text(broken)).toContain('Error the prompt does not fit');
    expect(text(broken)).toContain('Response (empty)');
    expect(
      text(render(<CallDetail call={undefined} error={null} onClose={() => undefined} />)),
    ).toContain('Loading the call…');
    expect(
      text(
        render(
          <CallDetail call={undefined} error="no such model call" onClose={() => undefined} />,
        ),
      ),
    ).toContain('no such model call');
  });
});
