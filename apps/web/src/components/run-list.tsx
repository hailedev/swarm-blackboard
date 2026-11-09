import type { RunRecord } from '@team/server/api';

import { dateTime, usd } from '../lib/format';
import { RunStatus } from './run-status';
import { cx } from './ui';

// Every run in the database, newest first. A run that is not running always says why.

export interface RunListProps {
  runs: readonly RunRecord[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

export const RunList = ({ runs, selectedId, onSelect }: RunListProps) => {
  if (runs.length === 0) {
    return <p className="px-3 py-4 text-sm text-ink-2">No runs yet. Start one to see it here.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {runs.map((run) => {
        const selected = run.id === selectedId;
        return (
          <li key={run.id}>
            <button
              type="button"
              data-testid="run-row"
              data-run-id={run.id}
              aria-current={selected ? 'true' : undefined}
              onClick={() => {
                onSelect(run.id);
              }}
              className={cx(
                'block w-full cursor-pointer px-3 py-2.5 text-left hover:bg-sunken',
                selected && 'bg-sunken',
              )}
            >
              <span className="line-clamp-2 text-sm font-medium">{run.problem}</span>
              <span className="mt-1 block">
                <RunStatus status={run.status} reason={run.reason} />
              </span>
              <span className="mt-1 block text-xs text-ink-2">
                {run.profileName ?? 'no profile'} · {plural(run.totals.rounds, 'round', 'rounds')} ·{' '}
                {plural(run.totals.entries, 'entry', 'entries')} · {usd(run.totals.usage.costUsd)}
              </span>
              <span className="block text-xs text-ink-2">{dateTime(run.startedAt)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};
