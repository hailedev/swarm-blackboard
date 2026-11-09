import { useEffect, useRef } from 'react';

import { clockTime } from '../lib/format';
import type { FeedLine, FeedTone } from '../state/selectors';
import { cx, TONE_MARK } from './ui';

// Events as they happen, oldest first. A failed agent's reason and detail are here: this
// is where a refused call (for instance one that would not fit a local model's context)
// shows up.

const TONE_ICON: Record<FeedTone, string> = {
  neutral: '·',
  accent: '▸',
  good: '✓',
  warning: '▲',
  critical: '✕',
};

export interface LiveFeedProps {
  lines: readonly FeedLine[];
  /** Keep the newest line in view; off while replaying an earlier round. */
  follow: boolean;
  onSelect: (entryId: string) => void;
}

export const LiveFeed = ({ lines, follow, onSelect }: LiveFeedProps) => {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (follow && list.current !== null) list.current.scrollTop = list.current.scrollHeight;
  }, [follow, lines.length]);

  if (lines.length === 0)
    return <p className="p-3 text-sm text-ink-2">Nothing has happened yet.</p>;
  return (
    <ol ref={list} data-testid="live-feed" className="max-h-96 overflow-y-auto px-3 py-2">
      {lines.map((line) => (
        <li key={line.seq} data-seq={line.seq} className="flex gap-2 py-1 text-sm">
          <span aria-hidden="true" className={cx('w-3 shrink-0 text-center', TONE_MARK[line.tone])}>
            {TONE_ICON[line.tone]}
          </span>
          <span className="min-w-0 flex-1">
            {line.entryId === null ? (
              <span className="font-medium">{line.title}</span>
            ) : (
              <button
                type="button"
                className="cursor-pointer text-left font-medium underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                onClick={() => {
                  if (line.entryId !== null) onSelect(line.entryId);
                }}
              >
                {line.title}
              </button>
            )}
            {line.detail === null ? null : (
              <span className="block text-xs break-words text-ink-2">{line.detail}</span>
            )}
          </span>
          <time dateTime={line.at} className="shrink-0 text-xs text-ink-2 tabular-nums">
            {clockTime(line.at)}
          </time>
        </li>
      ))}
    </ol>
  );
};
