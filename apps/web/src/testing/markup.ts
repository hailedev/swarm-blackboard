import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Component tests render to static markup in Vitest's Node environment: no DOM package
// (ADR-0011). These helpers read that markup back by `data-testid`, so a test asserts on
// what an element says about itself rather than on a slab of HTML.

export const render = (element: ReactElement): string => renderToStaticMarkup(element);

export type Attributes = Record<string, string>;

const decode = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const attributesOf = (tag: string): Attributes =>
  Object.fromEntries(
    [...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(([, name = '', value = '']) => [
      name,
      decode(value),
    ]),
  );

/** The attributes of every element carrying `data-testid="<testId>"`, in document order. */
export const elements = (html: string, testId: string): Attributes[] =>
  [...html.matchAll(/<[a-z][a-z0-9]*\s[^>]*>/g)]
    .map(([tag]) => attributesOf(tag))
    .filter((attributes) => attributes['data-testid'] === testId);

/** Whether an opening tag carries a boolean attribute such as `disabled`. */
export const hasFlag = (tag: string, name: string): boolean =>
  new RegExp(`\\s${name}(=""|\\s|/?>)`).test(tag);

/** The text a reader would see: tags dropped, entities decoded, whitespace collapsed. */
export const text = (html: string): string =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Elements that never have a closing tag. */
const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta']);

/**
 * The whole markup, opening tag to closing tag, of every element carrying
 * `data-testid="<testId>"`: one row, one card or one lane on its own.
 */
export const slices = (html: string, testId: string): string[] => {
  const tags = [...html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)];
  const out: string[] = [];
  for (const [index, open] of tags.entries()) {
    if (open[1] === '/' || attributesOf(open[0])['data-testid'] !== testId) continue;
    let depth = 0;
    for (const tag of tags.slice(index)) {
      const [whole, closing, name = '', rest = ''] = tag;
      if (closing === '/') depth -= 1;
      else if (!VOID.has(name) && !rest.endsWith('/')) depth += 1;
      if (depth === 0) {
        out.push(html.slice(open.index, tag.index + whole.length));
        break;
      }
    }
  }
  return out;
};
