import type { BoardView } from '@team/core';
import { useEffect, useMemo, useRef } from 'react';

import { LANE_LABEL, LANES } from '../../lib/entry-types';
import { boardLinks, linksTouching, neighbourIds } from '../../lib/provenance';
import { cx } from '../ui';
import { EntryCard } from './entry-card';
import { EntryLinks } from './entry-links';

// The board: one lane per entry type, entries in commit order, links drawn between them.
// With an entry selected only its links are drawn; "all links" draws the whole graph.

export interface BoardProps {
  view: BoardView;
  selectedId: string | null;
  showAllLinks: boolean;
  onSelect: (entryId: string | null) => void;
}

export const Board = ({ view, selectedId, showAllLinks, onSelect }: BoardProps) => {
  const container = useRef<HTMLDivElement>(null);
  const all = useMemo(() => boardLinks(view), [view]);
  const drawn = useMemo(
    () => (showAllLinks ? all : selectedId === null ? [] : linksTouching(all, selectedId)),
    [all, selectedId, showAllLinks],
  );
  const related = useMemo(
    () => (selectedId === null ? new Set<string>() : neighbourIds(all, selectedId)),
    [all, selectedId],
  );

  // Selecting an entry elsewhere (a handle in the detail view, a line of the feed) brings
  // its card into view: nine lanes rarely fit the window.
  useEffect(() => {
    if (selectedId === null) return;
    container.current
      ?.querySelector(`[data-entry-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  return (
    <div
      ref={container}
      data-testid="board"
      // The board scrolls inside itself, both ways, so the run's status, budgets and
      // controls stay on screen however long a lane grows.
      className="relative flex max-h-[calc(100vh-7rem)] items-start gap-6 overflow-auto pb-2"
    >
      {LANES.map((type) => {
        const entries = view.entries.filter((entry) => entry.type === type);
        const live = entries.filter((entry) => view.isLive(entry.id)).length;
        return (
          <section
            key={type}
            data-testid="lane"
            data-lane={type}
            aria-label={LANE_LABEL[type]}
            // Above the link overlay: links run in the gaps and behind the cards, not over them.
            className={cx('relative z-10 shrink-0', entries.length === 0 ? 'w-28' : 'w-64')}
          >
            <h3 className="sticky top-0 z-20 mb-2 flex items-baseline justify-between gap-2 border-b border-line-strong bg-surface pb-1 text-xs font-semibold tracking-wide uppercase">
              <span>{LANE_LABEL[type]}</span>
              <span className="font-normal text-ink-2 normal-case">
                {entries.length === 0
                  ? ''
                  : live === entries.length
                    ? String(live)
                    : `${String(live)} live of ${String(entries.length)}`}
              </span>
            </h3>
            {entries.length === 0 ? (
              <p className="text-xs text-ink-2">Nothing yet</p>
            ) : (
              <div className="flex flex-col gap-2">
                {entries.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    view={view}
                    selected={entry.id === selectedId}
                    related={related.has(entry.id)}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      <EntryLinks container={container} links={drawn} focusId={selectedId} />
    </div>
  );
};
