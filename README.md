# Planning Picker

A deliberately simple, self-hosted, **real-time planning-poker** app for a tiny team.
Create a room, share the link, everyone picks a hidden Fibonacci card, the host reveals,
and you get min / max / average + an "all agree" indicator. One task at a time. No
accounts, no database — rooms live in memory and are gone on restart, by design.

## Stack

| Layer       | Choice                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend    | SvelteKit (adapter-static **SPA**, `ssr=false`), Svelte 5 runes, plain CSS, optional Bits UI                                                                                                                                                                                                              |
| Realtime    | Native **WebSocket** over a JSON envelope contract (no socket.io); BE uses Hono's WS helper, FE uses the browser `WebSocket` API                                                                                                                                                                          |
| Backend     | **Hono** (HTTP + WebSocket) on `@hono/node-server`, layered (entry → controllers/ws/domain), in-memory room registry, bundled to one file with esbuild — see [`BE/doc/glossary.md`](BE/doc/glossary.md) for the topology vocabulary and [`BE/doc/adr/`](BE/doc/adr/README.md) for the decisions behind it |
| Contract    | `@pp/shared` — types + zod schemas + event names shared by FE & BE (npm workspaces, no build step)                                                                                                                                                                                                        |
| Serving     | FE container's nginx serves the static SPA and reverse-proxies `/ws` (+ `/health`) to the BE; two containers, no separate proxy. TLS, if needed, is terminated by a front proxy on the host                                                                                                               |
| Lint / Test | oxlint · Vitest                                                                                                                                                                                                                                                                                           |

Monorepo via npm workspaces: `shared/`, `BE/`, `FE/`.

## Develop locally

```bash
npm install            # installs all workspaces

# Run the two dev servers (separate terminals):
npm run dev:be         # BE on http://localhost:3000 (WebSocket at /ws)
npm run dev:fe         # FE on http://localhost:5173 (Vite, proxies to the BE in dev)
```

Open two browser tabs on the Vite URL to simulate two participants.

### Checks

```bash
npm run typecheck      # tsc (shared + BE) and svelte-check (FE)
npm run lint           # oxlint, zero errors
npm test               # Vitest unit tests (stats + registry/host-transfer/wire boundary)
npm run build          # bundle BE (esbuild) + build the static FE (vite)
```

### TypeScript versions

`shared` and `BE` type-check with the **native TypeScript 7** compiler (`typescript@rc`,
nested in each workspace so `npm run typecheck` resolves it). `FE` stays on **TypeScript 6**
because `svelte-check` embeds the JavaScript-based TS compiler API, which the native TS 7
package no longer exports. The root `typescript` dependency is therefore pinned to TS 6 (so
the hoisted copy `svelte-check` resolves stays compatible), and TS 7 is also available at the
root under the `typescript-7` alias (`npm:typescript@rc`). Once `svelte-check` supports the
native compiler, `FE` and the root can move to TS 7 too.

## Deploy (Docker)

Two containers, built and run in place — no registry, manual deploy:

```bash
git pull
docker compose up -d --build      # serves on http://<host>:8080
```

- **`be`** — the Node backend, internal only (`expose: 3000`); never published directly.
- **`fe`** — nginx serving the static SPA, the only published service. Its `nginx.conf`
  reverse-proxies `/ws` (WebSocket upgrade) and `/health` to `be:3000` over the compose
  network.

Override the published port with `HTTP_PORT` (default `8080`) when `:8080` is taken or you
want a different entry point:

```bash
HTTP_PORT=9000 docker compose up -d --build   # -> http://<host>:9000
```

**TLS / public hostname:** there's no built-in HTTPS. For a public deployment, terminate
TLS at a front proxy on the host (e.g. an nginx/Caddy server block that proxies your domain
to `127.0.0.1:8080`, forwarding the `/ws` upgrade). On a LAN box, access it by IP and port
directly.

> Redeploys restart the BE and therefore drop all live rooms (in-memory by design). The
> client auto-reconnects, but an active round is lost.
