import { defaultRunConfig } from '@team/core';
import { useEffect, useRef, useState } from 'react';

import { failureMessage } from '../api/client';
import { useBudget, useProfiles, useStartRun } from '../api/queries';
import { checkStartRun, toStartRunBody, type StartRunDraft } from '../lib/start-run';
import { StartRunForm } from './start-run-form';
import { ErrorNote } from './ui';

// The start-run dialog: reads the profiles and the month's spend, holds the draft, and
// sends the run. The rules are in ../lib/start-run; the form is ./start-run-form.

export interface StartRunDialogProps {
  onClose: () => void;
  onStarted: (runId: string) => void;
}

export const StartRunDialog = ({ onClose, onStarted }: StartRunDialogProps) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const profiles = useProfiles();
  const budget = useBudget();
  const start = useStartRun();
  // What the user has changed; everything else follows the server's defaults as they load.
  const [edits, setEdits] = useState<Partial<StartRunDraft>>({});

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const defaults = defaultRunConfig();
  const draft: StartRunDraft = {
    problem: '',
    constraints: '',
    successCriteria: '',
    profile: profiles.data?.defaultProfile ?? '',
    maxCostUsd: String(defaults.maxCostUsd),
    maxRounds: String(defaults.maxRounds),
    confirmed: false,
    ...edits,
  };
  const profile = profiles.data?.profiles.find((p) => p.name === draft.profile);
  const check = checkStartRun(draft, profile, budget.data);

  return (
    <dialog
      ref={dialog}
      data-testid="start-run-dialog"
      aria-labelledby="start-run-title"
      onCancel={(event) => {
        // Esc closes it, unless a run is on its way.
        if (start.isPending) event.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-5 text-ink"
    >
      <h2 id="start-run-title" className="mb-4 text-base font-semibold">
        Start a run
      </h2>
      {profiles.error === null ? null : (
        <div className="mb-3">
          <ErrorNote>{failureMessage(profiles.error)}</ErrorNote>
        </div>
      )}
      <StartRunForm
        draft={draft}
        profiles={profiles.data?.profiles ?? []}
        budget={budget.data}
        check={check}
        starting={start.isPending}
        serverError={start.error === null ? null : failureMessage(start.error)}
        onChange={(patch) => {
          setEdits((current) => ({ ...current, ...patch }));
        }}
        onCancel={() => {
          dialog.current?.close();
        }}
        onSubmit={() => {
          const body = toStartRunBody(draft);
          if (body === undefined) return;
          start.mutate(body, {
            onSuccess: (record) => {
              onStarted(record.id);
            },
          });
        }}
      />
    </dialog>
  );
};
