import { totalTokens, type BoardView, type Entry } from '@team/core';
import type { ModelCallSummary } from '@team/server/api';

import { TYPE_LABEL } from '../../lib/entry-types';
import { clockTime, compact, excerpt, usd } from '../../lib/format';
import { ancestorsOf, referrersOf } from '../../lib/provenance';
import { Badge, Button, HandleChip } from '../ui';
import { EntryFacts } from './entry-card';

// One entry in full, with its provenance: what it rests on back to the problem, the
// versions it replaced, what was built on it, and the model calls that produced it.

const EntryLine = ({
  entry,
  view,
  onSelect,
  indent = 0,
}: {
  entry: Entry;
  view: BoardView;
  onSelect: (entryId: string) => void;
  indent?: number;
}) => (
  <li className="flex items-baseline gap-2 text-sm" style={{ paddingLeft: `${String(indent)}rem` }}>
    <HandleChip
      handle={view.handleOf(entry.id) ?? '?'}
      live={view.isLive(entry.id)}
      onSelect={() => {
        onSelect(entry.id);
      }}
    />
    <span className="min-w-0 text-ink-2">
      <span className="text-ink">{TYPE_LABEL[entry.type]}</span> · {excerpt(entry.content, 90)}
    </span>
  </li>
);

const Heading = ({ children }: { children: string }) => (
  <h4 className="mt-4 mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">{children}</h4>
);

export interface EntryDetailProps {
  view: BoardView;
  entryId: string;
  /** The run's traced calls, to list the ones behind this entry. */
  calls: readonly ModelCallSummary[];
  onSelect: (entryId: string | null) => void;
  onOpenCall: (callId: string) => void;
}

export const EntryDetail = ({ view, entryId, calls, onSelect, onOpenCall }: EntryDetailProps) => {
  const entry = view.byId(entryId);
  if (entry === undefined) {
    return (
      <p className="p-3 text-sm text-ink-2">
        This entry is not on the board at the round being shown.
      </p>
    );
  }
  const handle = view.handleOf(entry.id) ?? '?';
  const live = view.isLive(entry.id);
  const successor = view.supersededBy(entry.id);
  const chain = view.chain(entry.id);
  const ancestors = ancestorsOf(view, entry.id);
  const referrers = referrersOf(view, entry.id);
  const behind = calls.filter((call) => call.role === entry.author && call.round === entry.round);
  const select = (id: string): void => {
    onSelect(id);
  };

  return (
    <div data-testid="entry-detail" data-handle={handle} className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <HandleChip handle={handle} />
          <span className="text-sm font-semibold">{TYPE_LABEL[entry.type]}</span>
          {live ? null : (
            <Badge icon="○">
              {successor === undefined
                ? 'dismissed'
                : `superseded by ${view.handleOf(successor.id) ?? '?'}`}
            </Badge>
          )}
          {entry.status === 'pinned' ? <Badge icon="★">pinned</Badge> : null}
        </div>
        <Button
          variant="ghost"
          aria-label="Close entry"
          onClick={() => {
            onSelect(null);
          }}
        >
          ✕
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-2">
        by {entry.author === 'human' ? 'you' : entry.author} · round {String(entry.round)} ·{' '}
        {clockTime(entry.createdAt)}
        {totalTokens(entry.usage) === 0
          ? ''
          : ` · ${compact(totalTokens(entry.usage))} tokens · ${usd(entry.usage.costUsd)}`}
      </p>

      <p className="mt-3 text-sm whitespace-pre-wrap">{entry.content}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <EntryFacts entry={entry} view={view} onSelect={select} />
      </div>

      {entry.type === 'problem' ? (
        <>
          {entry.payload.constraints.length === 0 ? null : (
            <>
              <Heading>Constraints</Heading>
              <ul className="list-disc pl-5 text-sm">
                {entry.payload.constraints.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          {entry.payload.successCriteria.length === 0 ? null : (
            <>
              <Heading>Success criteria</Heading>
              <ul className="list-disc pl-5 text-sm">
                {entry.payload.successCriteria.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
      {entry.type === 'decision' ? (
        <>
          <Heading>Rationale</Heading>
          <p className="text-sm whitespace-pre-wrap">{entry.payload.rationale}</p>
        </>
      ) : null}

      {chain.length < 2 ? null : (
        <>
          <Heading>Versions</Heading>
          <ol className="flex flex-col gap-1">
            {chain.map((version) => (
              <EntryLine key={version.id} entry={version} view={view} onSelect={select} />
            ))}
          </ol>
        </>
      )}

      <Heading>Rests on</Heading>
      {ancestors.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing: this is where the board starts.</p>
      ) : (
        <ol data-testid="provenance" className="flex flex-col gap-1">
          {ancestors.map(({ entry: ancestor, depth }) => (
            <EntryLine
              key={ancestor.id}
              entry={ancestor}
              view={view}
              onSelect={select}
              indent={(depth - 1) * 0.75}
            />
          ))}
        </ol>
      )}

      {referrers.length === 0 ? null : (
        <>
          <Heading>Built on by</Heading>
          <ul className="flex flex-col gap-1">
            {referrers.map((referrer) => (
              <EntryLine key={referrer.id} entry={referrer} view={view} onSelect={select} />
            ))}
          </ul>
        </>
      )}

      {behind.length === 0 ? null : (
        <>
          <Heading>Model calls</Heading>
          <ul className="flex flex-col gap-1">
            {behind.map((call) => (
              <li key={call.id}>
                <button
                  type="button"
                  className="cursor-pointer text-left text-sm underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                  onClick={() => {
                    onOpenCall(call.id);
                  }}
                >
                  {call.modelId} · {call.outcome} · {(call.latencyMs / 1_000).toFixed(1)}s ·{' '}
                  {usd(call.costUsd ?? 0)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
