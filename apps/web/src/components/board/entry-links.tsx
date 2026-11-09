import { useEffect, useState, type RefObject } from 'react';

import { LINK_STYLE, type Link, type LinkStyle } from '../../lib/provenance';

// The links between entries, drawn over the lanes. Cards are found by their
// `data-entry-id`; positions are measured, so this draws nothing until it is mounted in a
// browser. The overlay sits inside the scrolling board and moves with it.

interface Segment {
  key: string;
  d: string;
  style: LinkStyle;
  strong: boolean;
}

const DASH: Record<LinkStyle, string | undefined> = {
  solid: undefined,
  dashed: '6 4',
  dotted: '1.5 4',
};

const measure = (
  container: HTMLElement,
  links: readonly Link[],
  focusId: string | null,
): { segments: Segment[]; width: number; height: number } => {
  const origin = container.getBoundingClientRect();
  const boxOf = (id: string) => {
    const card = container.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
    if (card === null) return undefined;
    const rect = card.getBoundingClientRect();
    return {
      left: rect.left - origin.left + container.scrollLeft,
      right: rect.right - origin.left + container.scrollLeft,
      middle: rect.top - origin.top + container.scrollTop + rect.height / 2,
    };
  };
  const segments = links.flatMap((link): Segment[] => {
    const from = boxOf(link.from);
    const to = boxOf(link.to);
    if (from === undefined || to === undefined) return [];
    // Leave from the side that faces the other card; same lane loops out to the right.
    const sameLane = Math.abs(from.left - to.left) < 1;
    const forwards = from.left < to.left;
    const x1 = sameLane || forwards ? from.right : from.left;
    const x2 = sameLane || !forwards ? to.right : to.left;
    // Half the distance bends the curve inside the gap between two lanes; a same-lane
    // link has no gap of its own and loops into the one on its right.
    const bend = sameLane ? 18 : Math.max(8, Math.abs(x2 - x1) / 2);
    const c1 = x1 + (sameLane || forwards ? bend : -bend);
    const c2 = x2 + (sameLane || !forwards ? bend : -bend);
    return [
      {
        key: `${link.from}>${link.to}`,
        d: `M ${String(x1)} ${String(from.middle)} C ${String(c1)} ${String(from.middle)}, ${String(c2)} ${String(to.middle)}, ${String(x2)} ${String(to.middle)}`,
        style: LINK_STYLE[link.kind],
        strong: focusId !== null && (link.from === focusId || link.to === focusId),
      },
    ];
  });
  return { segments, width: container.scrollWidth, height: container.scrollHeight };
};

export interface EntryLinksProps {
  /** The scrolling element that holds the cards. */
  container: RefObject<HTMLElement | null>;
  links: readonly Link[];
  /** Links touching this entry are drawn stronger. */
  focusId: string | null;
}

export const EntryLinks = ({ container, links, focusId }: EntryLinksProps) => {
  const [drawn, setDrawn] = useState<ReturnType<typeof measure> | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    // The observer reports once as soon as it starts observing, which is the first
    // measurement, and again whenever a card or the board changes size.
    const observer = new ResizeObserver(() => {
      setDrawn(measure(element, links, focusId));
    });
    observer.observe(element);
    for (const card of element.querySelectorAll('[data-entry-id]')) observer.observe(card);
    return () => {
      observer.disconnect();
    };
  }, [container, links, focusId]);

  if (drawn === null || drawn.segments.length === 0) return null;
  return (
    <svg
      aria-hidden="true"
      data-testid="entry-links"
      width={drawn.width}
      height={drawn.height}
      className="pointer-events-none absolute top-0 left-0 z-0"
    >
      {drawn.segments.map((segment) => (
        <path
          key={segment.key}
          d={segment.d}
          fill="none"
          strokeDasharray={DASH[segment.style]}
          strokeLinecap="round"
          strokeWidth={segment.strong ? 1.75 : 1}
          className={segment.strong ? 'stroke-ink-2' : 'stroke-line-strong'}
        />
      ))}
    </svg>
  );
};
