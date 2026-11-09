import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './app';

// Component tests render to static markup in Vitest's Node environment: no DOM package
// (ADR-0011). What needs a click is covered by the Playwright smoke.
describe('App', () => {
  it('renders the shell before anything has loaded: no run selected, the list loading', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    expect(html).toContain('Team — blackboard swarm');
    expect(html).toContain('New run');
    expect(html).toContain('Loading runs…');
    expect(html).toContain('No run selected.');
  });
});
