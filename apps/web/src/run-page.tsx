import { buildBoardView, synthesisPending, totalTokens, type BoardEvent } from '@team/core';
import { useMemo, useState } from 'react';

import { failureMessage } from './api/client';
import { useBudget, useCall, useInjectNote, useRunAction, useTrace } from './api/queries';
import { AgentPanel } from './components/agent-panel';
import { AnswerPanel } from './components/answer-panel';
import { Board } from './components/board/board';
import { EntryDetail } from './components/board/entry-detail';
import { Controls } from './components/controls';
import { BudgetStrip } from './components/cost-meter';
import { LiveFeed } from './components/live-feed';
import { ReplayScrubber } from './components/replay-scrubber';
import { RunStatus } from './components/run-status';
import { CallDetail, TraceTable } from './components/trace-viewer';
import { Badge, cx, ErrorNote, Panel } from './components/ui';
import { useNow } from './lib/use-now';
import { useRunStore } from './state/run-store';
import {
  agentSpendOf,
  agentStatesOf,
  elapsedMsOf,
  eventsAt,
  feedOf,
  lastEventMs,
  runStateOf,
  usageOf,
} from './state/selectors';
import { useRunStream } from './state/use-run-stream';

// One run: its stream feeds the store, and everything on the page is derived from the log
// (ADR-0011). The header and the controls always speak of the run as it is now; the board,
// the answer, the feed, the agents and the meters follow the replay cursor.

type Tab = 'board' | 'answer' | 'trace';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'answer', label: 'Answer' },
  { id: 'trace', label: 'Trace' },
];

const NO_EVENTS: readonly BoardEvent[] = [];

export const RunPage = ({ runId }: { runId: string }) => {
  useRunStream(runId);
  const storeRunId = useRunStore((state) => state.runId);
  const allEvents = useRunStore((state) => state.events);
  const stream = useRunStore((state) => state.stream);
  const cursor = useRunStore((state) => state.cursor);
  const selectedEntryId = useRunStore((state) => state.selectedEntryId);
  const setCursor = useRunStore((state) => state.setCursor);
  const selectEntry = useRunStore((state) => state.selectEntry);

  const [tab, setTab] = useState<Tab>('board');
  const [showAllLinks, setShowAllLinks] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);

  const trace = useTrace(runId);
  const budget = useBudget();
  const call = useCall(runId, callId);
  const action = useRunAction(runId);
  const note = useInjectNote(runId);

  // Until the store has switched to this run it still holds the previous one's log.
  const events = storeRunId === runId ? allEvents : NO_EVENTS;
  const shown = useMemo(() => eventsAt(events, cursor), [events, cursor]);
  const now = useMemo(() => runStateOf(events), [events]);
  const view = useMemo(() => buildBoardView(runId, shown), [runId, shown]);
  const feed = useMemo(() => feedOf(shown, view), [shown, view]);
  const agents = useMemo(() => agentStatesOf(shown), [shown]);
  const usage = useMemo(() => usageOf(shown), [shown]);
  const calls = useMemo(() => trace.data?.calls ?? [], [trace.data]);
  const spend = useMemo(() => agentSpendOf(calls, cursor), [calls, cursor]);
  const owed = useMemo(() => synthesisPending(events), [events]);

  const ticking = now?.status === 'running' && cursor === null;
  const clock = useNow(ticking);
  const elapsedMs =
    cursor === null ? elapsedMsOf(events, clock) : elapsedMsOf(shown, lastEventMs(shown));

  if (now === undefined) {
    return (
      <div className="flex flex-col gap-3">
        {stream.kind === 'failed' ? (
          <ErrorNote>{stream.message}</ErrorNote>
        ) : (
          <p className="text-sm text-ink-2">Reading the run’s event log…</p>
        )}
      </div>
    );
  }

  const shownRound = cursor ?? now.completedRounds;
  const replaying = cursor !== null;
  const busy = action.isPending ? action.variables : note.isPending ? 'note' : null;
  const failure = action.error ?? note.error;

  return (
    <div className="flex flex-col gap-3" data-testid="run-page" data-run-id={runId}>
      <section className="rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-3 text-base font-semibold" title={now.problem}>
              {now.problem}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <RunStatus status={now.status} reason={now.reason} withDetail />
            </div>
            <p className="mt-1 text-xs text-ink-2">
              profile {now.profile?.name ?? 'not recorded'}
              {now.roundInFlight ? ` · round ${String(now.round)} in flight` : ''}
              {' · '}
              <span data-testid="stream-state" data-stream={stream.kind}>
                {stream.kind === 'open'
                  ? 'live'
                  : stream.kind === 'ended'
                    ? 'log complete'
                    : stream.kind === 'failed'
                      ? 'stream lost'
                      : 'connecting…'}
              </span>
            </p>
          </div>
        </div>
        {stream.kind === 'failed' ? (
          <div className="mt-2">
            <ErrorNote>{stream.message}</ErrorNote>
          </div>
        ) : null}
        <div className="mt-3 border-t border-line pt-3">
          <Controls
            status={now.status}
            replaying={replaying}
            synthesisPending={owed}
            busy={busy}
            error={failure === null ? null : failureMessage(failure)}
            onAction={(kind) => {
              note.reset();
              action.mutate(kind);
            }}
            onNote={(body) => {
              action.reset();
              note.mutate(body);
            }}
          />
        </div>
      </section>

      <section aria-label="Budgets" className="rounded-lg border border-line bg-surface p-3">
        <BudgetStrip
          run={{ spentUsd: usage.costUsd, capUsd: now.config.maxCostUsd }}
          month={budget.data}
          rounds={{ done: shownRound, max: now.config.maxRounds }}
          tokens={{ used: totalTokens(usage), max: now.config.maxTokens }}
          time={{ elapsedMs, maxMs: now.config.maxWallClockMs }}
        />
      </section>

      <section aria-label="Replay" className="rounded-lg border border-line bg-surface p-3">
        <ReplayScrubber
          rounds={now.completedRounds}
          cursor={cursor}
          live={now.status === 'running' || now.status === 'paused'}
          onChange={setCursor}
        />
        {replaying ? (
          <p data-testid="replay-banner" className="mt-2 text-xs text-ink-2">
            Showing the board as it stood after round {String(cursor)}. The status above is the
            run’s current one.
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="min-w-0 rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div role="tablist" aria-label="Run views" className="flex gap-1">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                  }}
                  className={cx(
                    'cursor-pointer rounded px-3 py-1 text-sm font-medium',
                    tab === id ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken',
                  )}
                >
                  {label}
                  {id === 'trace' ? ` (${String(calls.length)})` : ''}
                </button>
              ))}
            </div>
            {tab === 'board' ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
                <span>
                  {String(view.live.length)} live of {String(view.entries.length)} entries
                </span>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showAllLinks}
                    onChange={(event) => {
                      setShowAllLinks(event.target.checked);
                    }}
                  />
                  all links
                </label>
                <span title="How links are drawn">
                  ── builds on, supports, cites · ╌╌ critiques, contradicts, rejects · ···
                  supersedes
                </span>
              </div>
            ) : null}
          </div>
          {tab === 'board' ? (
            <div className="p-3">
              <Board
                view={view}
                selectedId={selectedEntryId}
                showAllLinks={showAllLinks}
                onSelect={selectEntry}
              />
            </div>
          ) : null}
          {tab === 'answer' ? (
            <AnswerPanel
              view={view}
              threshold={now.config.synthesisThreshold}
              onSelect={(id) => {
                selectEntry(id);
                setTab('board');
              }}
            />
          ) : null}
          {tab === 'trace' ? (
            <>
              {trace.error === null ? null : (
                <div className="p-3">
                  <ErrorNote>{failureMessage(trace.error)}</ErrorNote>
                </div>
              )}
              <TraceTable calls={calls} selectedId={callId} onSelect={setCallId} />
            </>
          ) : null}
        </section>

        {/* Stays in view beside the board: the entry, the agents and the feed follow the eye. */}
        <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-3 xl:max-h-[calc(100vh-1.5rem)] xl:overflow-y-auto">
          {selectedEntryId === null ? null : (
            <Panel title="Entry">
              <EntryDetail
                view={view}
                entryId={selectedEntryId}
                calls={calls}
                onSelect={selectEntry}
                onOpenCall={(id) => {
                  setCallId(id);
                  setTab('trace');
                }}
              />
            </Panel>
          )}
          {callId === null ? null : (
            <Panel title="Model call">
              <CallDetail
                call={call.data}
                error={call.error === null ? null : failureMessage(call.error)}
                onClose={() => {
                  setCallId(null);
                }}
              />
            </Panel>
          )}
          <Panel
            title="Agents"
            aside={
              owed ? (
                <Badge tone="accent" icon="▸">
                  synthesis requested
                </Badge>
              ) : undefined
            }
          >
            <AgentPanel agents={agents} models={now.profile?.roles ?? null} spend={spend} />
          </Panel>
          <Panel title="Live feed">
            <LiveFeed lines={feed} follow={!replaying} onSelect={selectEntry} />
          </Panel>
        </aside>
      </div>
    </div>
  );
};
