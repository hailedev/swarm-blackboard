import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './app';

// Component tests render to static markup in Vitest's Node environment: no DOM package
// (ADR-0011). What needs a click is covered by the Playwright smoke.
describe('App', () => {
  it('renders the shell', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Team — blackboard swarm');
    expect(html).toContain('No run selected.');
  });
});
