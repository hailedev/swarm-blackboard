import type { RunEndReason } from '@team/core';
import type { RunRecordStatus } from '@team/server/api';

import { REASON_TEXT, STATUS_LABEL } from '../lib/reasons';
import { cx, TONE_MARK, type Tone } from './ui';

// A run's status and, whenever it is not running, why. Used by the run list and the run
// header, so the same words appear in both.

const STATUS_ICON: Record<RunRecordStatus, string> = {
  running: '●',
  paused: '❚❚',
  completed: '✓',
  failed: '✕',
  stopped: '■',
};

const toneOf = (status: RunRecordStatus, reason: RunEndReason | null): Tone => {
  switch (status) {
    case 'running':
      return 'accent';
    case 'paused':
      return 'warning';
    case 'failed':
      return 'critical';
    case 'stopped':
      return 'neutral';
    case 'completed':
      // Completed on a budget is an ending, not a success: only an answer reads as good.
      return reason === 'completed' ? 'good' : 'neutral';
  }
};

export interface RunStatusProps {
  status: RunRecordStatus;
  reason: RunEndReason | null;
  /** Also spell out what the reason means and what to do about it. */
  withDetail?: boolean;
}

export const RunStatus = ({ status, reason, withDetail = false }: RunStatusProps) => (
  <span
    data-testid="run-status"
    data-status={status}
    data-reason={reason ?? undefined}
    title={reason === null ? undefined : REASON_TEXT[reason].detail}
    className="inline-flex flex-wrap items-baseline gap-x-1.5 text-sm"
  >
    {/* The spaces are real text: the flex gap spaces the pieces on screen, and these keep
        the words apart for a screen reader, a copy and paste, and a test. */}
    <span aria-hidden="true" className={cx('text-xs', TONE_MARK[toneOf(status, reason)])}>
      {STATUS_ICON[status]}
    </span>{' '}
    <span className="font-medium">{STATUS_LABEL[status]}</span>
    {reason === null ? null : (
      <>
        {' '}
        <span className="text-ink-2">
          — <span data-testid="run-reason">{REASON_TEXT[reason].label}</span>
        </span>
      </>
    )}
    {withDetail && reason !== null ? (
      <>
        {' '}
        <span className="basis-full text-xs text-ink-2">{REASON_TEXT[reason].detail}</span>
      </>
    ) : null}
  </span>
);
