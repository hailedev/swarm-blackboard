import type { BoardView, Entry } from '@team/core';

import { percent } from '../../lib/format';
import { Badge, cx, HandleChip } from '../ui';

// One entry on the board. The handle (H3, E7…) is the entry's name everywhere: in the
// agents' prompts, in the trace and here.

const handleOf = (view: BoardView, id: string): string => view.handleOf(id) ?? '?';

/** A row of handles for the entries a payload field names. */
const Refs = ({
  label,
  ids,
  view,
  onSelect,
}: {
  label: string;
  ids: readonly string[];
  view: BoardView;
  onSelect: (entryId: string) => void;
}) =>
  ids.length === 0 ? null : (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-ink-2">
      {label}
      {ids.map((id) => (
        <HandleChip
          key={id}
          handle={handleOf(view, id)}
          live={view.isLive(id)}
          onSelect={() => {
            onSelect(id);
          }}
        />
      ))}
    </span>
  );

/** Confidence as a small meter with its figure: 0.85 reads faster as a bar and a number. */
const Confidence = ({ value }: { value: number }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-ink-2" title="confidence">
    <span
      role="meter"
      aria-label="confidence"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      className="h-1.5 w-12 overflow-hidden rounded-full bg-accent/20"
    >
      <span className="block h-1.5 rounded-full bg-accent" style={{ width: percent(value) }} />
    </span>
    <span className="tabular-nums">{value.toFixed(2)}</span>
  </span>
);

const SEVERITY_BADGE = {
  blocking: { tone: 'critical', icon: '■' },
  major: { tone: 'serious', icon: '▲' },
  minor: { tone: 'neutral', icon: '●' },
} as const;

/** The type-specific facts of an entry, in the order a reader needs them. */
export const EntryFacts = ({
  entry,
  view,
  onSelect,
}: {
  entry: Entry;
  view: BoardView;
  onSelect: (entryId: string) => void;
}) => {
  switch (entry.type) {
    case 'problem':
      return entry.payload.constraints.length + entry.payload.successCriteria.length ===
        0 ? null : (
        <span className="text-xs text-ink-2">
          {String(entry.payload.constraints.length)} constraints ·{' '}
          {String(entry.payload.successCriteria.length)} success criteria
        </span>
      );
    case 'subproblem':
      return (
        <Badge
          tone={entry.payload.status === 'done' ? 'good' : 'neutral'}
          icon={entry.payload.status === 'done' ? '✓' : '○'}
        >
          {entry.payload.status}
        </Badge>
      );
    case 'hypothesis': {
      const critiques = view.critiquesOf(entry.id);
      const blocking = critiques.filter(
        (c) => c.payload.severity === 'blocking' && c.payload.resolvedBy === undefined,
      );
      return (
        <>
          <Confidence value={entry.payload.confidence} />
          {blocking.length === 0 ? null : (
            <Badge tone="critical" icon="■">
              {String(blocking.length)} blocking
            </Badge>
          )}
          <Refs
            label="supported by"
            ids={view.evidenceSupporting(entry.id).map((e) => e.id)}
            view={view}
            onSelect={onSelect}
          />
          <Refs
            label="contradicted by"
            ids={view.evidenceContradicting(entry.id).map((e) => e.id)}
            view={view}
            onSelect={onSelect}
          />
          <Refs
            label="critiqued by"
            ids={critiques.map((c) => c.id)}
            view={view}
            onSelect={onSelect}
          />
        </>
      );
    }
    case 'evidence':
      return (
        <>
          <span className="text-xs text-ink-2">source: {entry.payload.source}</span>
          <Refs label="supports" ids={entry.payload.supports} view={view} onSelect={onSelect} />
          <Refs
            label="contradicts"
            ids={entry.payload.contradicts}
            view={view}
            onSelect={onSelect}
          />
        </>
      );
    case 'critique': {
      const badge = SEVERITY_BADGE[entry.payload.severity];
      return (
        <>
          <Badge tone={badge.tone} icon={badge.icon}>
            {entry.payload.severity}
          </Badge>
          <Refs label="of" ids={[entry.payload.target]} view={view} onSelect={onSelect} />
          <Refs
            label="resolved by"
            ids={entry.payload.resolvedBy === undefined ? [] : [entry.payload.resolvedBy]}
            view={view}
            onSelect={onSelect}
          />
        </>
      );
    }
    case 'question':
      return entry.payload.answeredBy === undefined ? (
        <Badge icon="?">open</Badge>
      ) : (
        <Refs
          label="answered by"
          ids={[entry.payload.answeredBy]}
          view={view}
          onSelect={onSelect}
        />
      );
    case 'decision':
      return (
        <>
          <Refs label="chose" ids={[entry.payload.chosen]} view={view} onSelect={onSelect} />
          <Refs label="rejected" ids={entry.payload.rejected} view={view} onSelect={onSelect} />
        </>
      );
    case 'synthesis':
      return (
        <>
          <Badge>v{String(entry.payload.version)}</Badge>
          <Confidence value={entry.payload.confidence} />
          <Refs label="cites" ids={entry.payload.cites} view={view} onSelect={onSelect} />
        </>
      );
    case 'human_note':
      return (
        <Badge tone={entry.payload.priority === 'high' ? 'accent' : 'neutral'}>
          {entry.payload.priority} priority
        </Badge>
      );
  }
};

export interface EntryCardProps {
  entry: Entry;
  view: BoardView;
  selected: boolean;
  /** Linked to the selected entry: outlined, so the relation shows without the lines. */
  related: boolean;
  onSelect: (entryId: string | null) => void;
}

export const EntryCard = ({ entry, view, selected, related, onSelect }: EntryCardProps) => {
  const handle = handleOf(view, entry.id);
  const live = view.isLive(entry.id);
  const successor = view.supersededBy(entry.id);
  return (
    // A div with a button's role: the card holds handle buttons of its own, and a button
    // may not contain buttons.
    <div
      role="button"
      tabIndex={0}
      data-testid="entry-card"
      data-entry-id={entry.id}
      data-handle={handle}
      data-live={live ? 'true' : 'false'}
      aria-pressed={selected}
      aria-label={`${handle}, ${entry.type.replace('_', ' ')} by ${entry.author}, round ${String(entry.round)}`}
      onClick={() => {
        onSelect(selected ? null : entry.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(selected ? null : entry.id);
      }}
      className={cx(
        'cursor-pointer rounded-md border bg-surface p-2 text-left',
        selected
          ? 'border-accent ring-2 ring-accent'
          : related
            ? 'border-accent'
            : 'border-line hover:border-line-strong',
        !live && 'opacity-55',
      )}
    >
      <div className="flex items-center gap-2">
        <HandleChip handle={handle} />
        <span className="text-xs text-ink-2">
          {entry.author === 'human' ? 'you' : entry.author} · round {String(entry.round)}
        </span>
        {entry.status === 'pinned' ? <Badge icon="★">pinned</Badge> : null}
      </div>
      <p className="mt-1.5 line-clamp-4 text-sm whitespace-pre-wrap">{entry.content}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <EntryFacts
          entry={entry}
          view={view}
          onSelect={(id) => {
            onSelect(id);
          }}
        />
      </div>
      {live ? null : (
        <p className="mt-1.5 text-xs text-ink-2">
          {successor === undefined ? 'dismissed' : `superseded by ${handleOf(view, successor.id)}`}
        </p>
      )}
    </div>
  );
};
