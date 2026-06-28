# E2E tests (Playwright)

Experimental Playwright setup for the Planning Poker SPA. Lives on the
`test/playwright` worktree.

## Running

```bash
npm run e2e          # headless, boots BE + FE automatically
npm run e2e:ui       # interactive UI mode
npm run e2e:report   # open the last HTML report
```

`playwright.config.ts` (repo root) declares a `webServer` that starts both the
BE (`npm run dev:be`, port 3000) and FE (`npm run dev:fe`, port 5173) and waits
on `/health` + the FE URL before the suite runs.

Server reuse:

- **BE is never reused** (`reuseExistingServer: false`). `/health` returns only a
  200 with no version identity, so a stray BE on `:3000` would be silently adopted
  and the suite would test code that doesn't match your working tree. The config
  always boots a fresh BE; a port clash fails loudly. **Kill any stray `:3000`
  first** (`lsof -ti:3000 | xargs kill`) or the run errors instead of going green.
- **FE is reused locally** (fresh in CI). Drift is safe here: the port is pinned
  via `strictPort` in `FE/vite.config.ts`, so a conflict fails instead of silently
  moving to 5174 and mismatching `baseURL`.

The app is real-time, so e2e drives the live WebSocket stack: the FE opens a
relative `/ws` that Vite proxies to `ws://localhost:3000`.

## Tests

- `landing.spec.ts` — SPA smoke test (no WS): hero, both panels, button enabling.
- `room-flow.spec.ts` — full flow over the WS: host creates a room, a second
  browser context joins, both vote, host reveals, stats broadcast to all.

## Conventions

- Prefer role/label/placeholder locators over CSS classes (CSS Modules hash names).
  Cards expose `aria-label="Pick <value>"`; the deck values are `0 1 2 3 5 8 13 21 ? ☕`.
- Model multiple clients with separate `browser.newContext()` (isolated storage).
