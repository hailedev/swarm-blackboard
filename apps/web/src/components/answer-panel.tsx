import { latestSynthesis, type BoardView } from '@team/core';

import { HandleChip } from './ui';

// The answer: the latest live synthesis, with the entries it cites one click away. The
// content is shown as written (agents write markdown; it is not rendered, ADR-0011).

export interface AnswerPanelProps {
  view: BoardView;
  /** Confidence at or above which a synthesis can complete the run. */
  threshold: number;
  onSelect: (entryId: string) => void;
}

export const AnswerPanel = ({ view, threshold, onSelect }: AnswerPanelProps) => {
  const synthesis = latestSynthesis(view);
  if (synthesis === undefined) {
    return (
      <p data-testid="answer-empty" className="p-3 text-sm text-ink-2">
        No synthesis yet. The Synthesizer writes one when a hypothesis has no blocking critique, or
        when you ask for it with “Force synthesis”.
      </p>
    );
  }
  const handle = view.handleOf(synthesis.id) ?? '?';
  const versions = view.chain(synthesis.id).length;
  const blocking = view.openBlockingCritiques().length;
  return (
    <article data-testid="answer" data-handle={handle} className="p-3">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <HandleChip
          handle={handle}
          onSelect={() => {
            onSelect(synthesis.id);
          }}
        />
        <span className="font-semibold">Version {String(synthesis.payload.version)}</span>
        <span className="text-ink-2">
          confidence {synthesis.payload.confidence.toFixed(2)} (the run completes at{' '}
          {threshold.toFixed(2)}
          {blocking === 0
            ? ''
            : `, and ${String(blocking)} blocking ${blocking === 1 ? 'critique is' : 'critiques are'} open`}
          ) · round {String(synthesis.round)}
          {versions > 1 ? ` · ${String(versions)} versions` : ''}
        </span>
      </header>
      <p className="mt-3 max-w-prose text-sm leading-6 whitespace-pre-wrap">{synthesis.content}</p>
      <footer className="mt-4 border-t border-line pt-3">
        <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-ink-2 uppercase">
          Rests on
        </h4>
        {synthesis.payload.cites.length === 0 ? (
          <p className="text-sm text-ink-2">This synthesis cites no entry.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {synthesis.payload.cites.map((id) => (
              <HandleChip
                key={id}
                handle={view.handleOf(id) ?? '?'}
                live={view.isLive(id)}
                title={view.byId(id)?.content}
                onSelect={() => {
                  onSelect(id);
                }}
              />
            ))}
          </div>
        )}
      </footer>
    </article>
  );
};
