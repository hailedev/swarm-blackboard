# ADR-0011: Build the web UI on Vite and React, folding the event log in the browser; Phase 4 dependencies

- **Status:** accepted
- **Date:** 2026-11-10

## Context

Phase 4 puts a browser on the server Phase 3 built: board, live feed, agent panel, controls, run list with replay, trace viewer, cost meter and the start-run dialog (docs/PLAN.md §3, §6; docs/budget-guardrails.md §5). PLAN.md §4 names the stack (Vite, React, TanStack Query, Zustand, Tailwind, Playwright) but not the packages those tools need around them, and Hai asks before any dependency the plan does not name. Four things were open:

- **Where the board is computed.** The server exposes a folded board (`GET /runs/:id/board`, with handles) and the raw log (SSE, `GET /runs/:id/log`). Events on the stream carry no handles.
- **How the browser reaches the API.** The server has no CORS and serves no static files.
- **How components are tested.** Vitest runs in Node with no DOM.
- **How the Playwright smoke runs without models.** Only the CLI has `--fake`.

PLAN.md §3 also lists "force synthesis" among the controls, which neither core nor the API supported.

## Decision

- **Stack as planned.** `apps/web` is a Vite + React single-page app with TanStack Query for request/response data, a Zustand store for the open run's event log and view state, and Tailwind for styling.
- **The browser folds the event log.** The UI subscribes to `GET /runs/:id/events`, which replays the whole log and then follows the run, and derives everything it shows with core's own pure functions: `buildBoardView` for the board and the handles, `latestSynthesis` for the answer, `synthesisPending` for a forced synthesis not yet served. A live run and a past run take the same path, and replay is the same fold over a prefix of the log. Core has no I/O (architecture rule 1), which is what makes it loadable in a browser.
- **The API contract is Zod, exported by the server.** `apps/server/src/api/schemas.ts` holds the request and response schemas and is exported as `@team/server/api`; it imports core and Zod only. The web app parses every response with them. Lint forbids `apps/web/src` from importing `@team/host`, `@team/providers`, the server's entry point or any Node built-in.
- **Vite's dev proxy, not CORS.** The dev server proxies `/api` to the API server, so the browser sees one origin. `pnpm dev` starts both.
- **Component tests without a DOM package.** Components are rendered with `react-dom/server` (`renderToStaticMarkup`) in Vitest's Node environment and asserted on as markup; state logic is pure functions tested directly against the recorded run in `fixtures/runs/`; anything that needs a click is in the Playwright smoke.
- **`--fake` on the server.** `tsx apps/server/src/index.ts --fake` runs the scripted swarm (`createScriptedModels`, as `pnpm solve --fake` does) with a delay per call, on an in-memory database: a fake server never touches `data/team.db`. The Playwright smoke and `pnpm dev:fake` use it.
- **Force synthesis is a recorded request.** A new event, `synthesis_requested`, is appended when the user asks. The first round that starts after it runs the Synthesizer whatever its trigger says, exempt from the selection diversity rule, and the request is then spent. The termination rules do not change: the run ends on that synthesis only if it clears the usual threshold. Because the request is an event, a paused or restarted run still honours it. Pinning and dismissing entries (PLAN.md §2.3) are not part of Phase 4.

Dependencies added, all pinned. Approved by Hai on 2026-11-10: the first six tools in the Phase 4 kick-off, the rest on request the same day.

| Package | Version | Where | Why |
|---|---|---|---|
| `react`, `react-dom` | 19.3.1 | web | Named in PLAN.md §4 |
| `@tanstack/react-query` | 5.107.1 | web | Named in PLAN.md §4 |
| `zustand` | 5.1.0 | web | Named in PLAN.md §4 |
| `tailwindcss` | 4.3.5 | web, dev | Named in PLAN.md §4 |
| `@tailwindcss/vite` | 4.3.5 | web, dev | Tailwind 4 has no built-in Vite integration; it is this or `@tailwindcss/postcss` |
| `@vitejs/plugin-react` | 6.2.1 | web, dev | Fast Refresh; without it every edit reloads the page and drops the open run. 6.3.0 was under a day old when installed and pnpm's release-age rule holds such versions back |
| `@types/react`, `@types/react-dom` | 19.3.0 | web, dev | Strict TypeScript cannot compile components without them |
| `@playwright/test` | 1.65.0 | web, dev | Named in PLAN.md §4 (smoke test). The browser itself is a one-off `pnpm exec playwright install chromium`, downloaded outside the repository |
| `eslint-plugin-react-hooks` | 7.1.1 | root, dev | The rules of hooks and effect dependencies, which nothing else checks |
| `vite` | 8.3.6 | web, dev | Already pinned at the root for Vitest; the web package now uses it directly |

`zod` 4.6.7 and the workspace packages `@team/core` and `@team/server` join the web app's dependencies as its code starts to import them.

## Consequences

- `+` One fold. The board the user sees, the board the agents were shown and the board the server replays are computed by the same function from the same events, so a handle on screen is the handle in the prompt and in the trace.
- `+` Replay costs nothing extra: scrubbing is a fold over fewer events, with no server round trip.
- `+` The contract cannot drift silently: a response the server changes fails to parse in the browser, and the server's handlers are checked against the same schemas at compile time.
- `+` No test dependency beyond Playwright, and the smoke run exercises the real server, stream and store.
- `−` The whole event log of the open run is held in the browser and re-folded as events arrive. The recorded twelve-round run is 134 events and 157 KB; a run an order of magnitude longer would want an incremental fold.
- `−` Static-markup tests cannot exercise effects or clicks, so interaction regressions are caught only by the smoke test, which is slower and coarser.
- `−` The web app depends on the server package for one file. If the contract grows, it earns a package of its own.
- `−` Entry content and the synthesised answer are shown as plain pre-wrapped text. Agents write markdown; rendering it would take a dependency nobody has asked for yet.
- `−` There is no production build path: the UI is served by Vite's dev server. That fits a local, single-user tool and would have to change for a hosted mode.

## Alternatives considered

- **Poll `GET /runs/:id/board`** — rejected: no live feed, no replay without new routes, and a second place where the board is computed for the user.
- **Add handles to the SSE payloads** — rejected: a handle is derived from the log, not stored on an entry (ADR-0004), and the client needs the fold anyway for liveness, links and replay.
- **CORS on the API instead of a proxy** — rejected: one more thing to configure and get wrong for no benefit in a single-origin local tool.
- **jsdom with Testing Library** — offered and declined: three more packages for click-level component tests the smoke test already covers end to end.
- **Hono's typed RPC client** — rejected: it types requests from the route definitions but validates nothing at runtime, and the project's rule is Zod at every boundary.
- **A graph library for the links between entries, a component library, a markdown renderer** — not added: an SVG overlay, Tailwind classes and pre-wrapped text do the job at this size (CLAUDE.md: no dependency where about fifty lines will do).
- **Force synthesis as an in-memory flag** — rejected: it would be lost on a pause and resume across processes, and replay could not explain why the Synthesizer ran.
