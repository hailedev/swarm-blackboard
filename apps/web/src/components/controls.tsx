import type { HumanNotePriority } from '@team/core';
import type { RunRecordStatus } from '@team/server/api';
import { useState } from 'react';

import { Button, ErrorNote } from './ui';

// Steering a run (docs/PLAN.md §2.3, human-in-the-loop): pause, resume, stop, add a note,
// force a synthesis. What each button does is the controller's business; this only says
// which make sense for the run's state.

export type ControlAction = 'pause' | 'resume' | 'stop' | 'synthesize';

export interface ControlsProps {
  status: RunRecordStatus;
  /** An earlier round is on screen: the controls would act on a run the user is not looking at. */
  replaying: boolean;
  /** A synthesis was asked for and no round has served it yet. */
  synthesisPending: boolean;
  /** The action being sent, if any. */
  busy: ControlAction | 'note' | null;
  error: string | null;
  onAction: (action: ControlAction) => void;
  onNote: (note: { content: string; priority: HumanNotePriority }) => void;
}

const PRIORITIES: readonly HumanNotePriority[] = ['high', 'normal', 'low'];

const isPriority = (value: string): value is HumanNotePriority =>
  (PRIORITIES as readonly string[]).includes(value);

export const Controls = ({
  status,
  replaying,
  synthesisPending,
  busy,
  error,
  onAction,
  onNote,
}: ControlsProps) => {
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<HumanNotePriority>('normal');
  const live = status === 'running' || status === 'paused';
  const locked = replaying || busy !== null;

  if (!live) {
    return (
      <p data-testid="controls" className="text-sm text-ink-2">
        This run has ended; it can be replayed but not steered.
      </p>
    );
  }
  return (
    <div data-testid="controls" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {status === 'running' ? (
          <Button
            disabled={locked}
            onClick={() => {
              onAction('pause');
            }}
          >
            {busy === 'pause' ? 'Pausing after this round…' : 'Pause'}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={locked}
            onClick={() => {
              onAction('resume');
            }}
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        <Button
          disabled={locked || synthesisPending}
          title="Run the Synthesizer in the next round to start, whatever the board holds"
          onClick={() => {
            onAction('synthesize');
          }}
        >
          {synthesisPending ? 'Synthesis requested' : 'Force synthesis'}
        </Button>
        <Button
          variant="danger"
          disabled={locked}
          onClick={() => {
            onAction('stop');
          }}
        >
          {busy === 'stop' ? 'Stopping after this round…' : 'Stop'}
        </Button>
        {replaying ? (
          <span className="text-xs text-ink-2">Return to the latest round to steer the run.</span>
        ) : null}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim() === '') return;
          onNote({ content: note.trim(), priority });
          setNote('');
        }}
      >
        <input
          aria-label="Note to the agents"
          placeholder="Add a note the agents will read next round"
          value={note}
          disabled={locked}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-2 py-1.5 text-sm"
        />
        <select
          aria-label="Note priority"
          value={priority}
          disabled={locked}
          onChange={(event) => {
            if (isPriority(event.target.value)) setPriority(event.target.value);
          }}
          className="rounded border border-line-strong bg-surface px-2 py-1.5 text-sm"
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value} priority
            </option>
          ))}
        </select>
        <Button type="submit" disabled={locked || note.trim() === ''}>
          {busy === 'note' ? 'Adding…' : 'Add note'}
        </Button>
      </form>
      {error === null ? null : <ErrorNote>{error}</ErrorNote>}
    </div>
  );
};
