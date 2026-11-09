import { useState } from 'react';

import { failureMessage } from './api/client';
import { useRuns } from './api/queries';
import { RunList } from './components/run-list';
import { StartRunDialog } from './components/start-run-dialog';
import { Button, ErrorNote } from './components/ui';
import { useSelectedRun } from './lib/use-hash-route';
import { RunPage } from './run-page';

// The dashboard (docs/PLAN.md §3): every run on the left, the selected one on the right.

export const App = () => {
  const runs = useRuns();
  const [selectedId, selectRun] = useSelectedRun();
  const [starting, setStarting] = useState(false);
  const known = runs.data?.some((run) => run.id === selectedId) ?? false;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5">
        <h1 className="text-base font-semibold">Team — blackboard swarm</h1>
        <Button
          variant="primary"
          onClick={() => {
            setStarting(true);
          }}
        >
          New run
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Runs"
          className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface"
        >
          {runs.error === null ? null : (
            <div className="p-3">
              <ErrorNote>{failureMessage(runs.error)}</ErrorNote>
            </div>
          )}
          {runs.data === undefined ? (
            runs.error === null ? (
              <p className="px-3 py-4 text-sm text-ink-2">Loading runs…</p>
            ) : null
          ) : (
            <RunList runs={runs.data} selectedId={selectedId} onSelect={selectRun} />
          )}
        </nav>
        <main className="min-w-0 flex-1 p-4">
          {selectedId === null ? (
            <p className="text-sm text-ink-2">
              No run selected. Pick one from the list, or start a new run.
            </p>
          ) : runs.data === undefined ? (
            <p className="text-sm text-ink-2">Loading…</p>
          ) : known ? (
            // Keyed by run: tabs, selection and the open call belong to one run.
            <RunPage key={selectedId} runId={selectedId} />
          ) : (
            <ErrorNote>
              This run is not in the database. It may belong to another machine.
            </ErrorNote>
          )}
        </main>
      </div>
      {starting ? (
        <StartRunDialog
          onClose={() => {
            setStarting(false);
          }}
          onStarted={(runId) => {
            setStarting(false);
            selectRun(runId);
          }}
        />
      ) : null}
    </div>
  );
};
