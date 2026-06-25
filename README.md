# Planning Picker

A deliberately simple, self-hosted, **real-time planning-poker** app for a tiny team.
Create a room, share the link, everyone picks a hidden Fibonacci card, the host reveals,
and you get min / max / average + an "all agree" indicator. One task at a time. No
accounts, no database — rooms live in memory and are gone on restart, by design.

> Built stage by stage. See [`docs/scope.md`](docs/scope.md) for what's in Stage 1 (this
> MVP) and [`docs/open-questions.md`](docs/open-questions.md) for carried decisions.

## Stack

| Layer | Choice |
|-------|--------|
| Frontend | SvelteKit (adapter-static **SPA**, `ssr=false`), Svelte 5 runes, plain CSS, optional Bits UI |
| Realtime | `socket.io` (server) / `socket.io-client` (browser) |
| Backend | Node.js + TypeScript, in-memory room registry, bundled to one file with esbuild |
| Contract | `@pp/shared` — types + zod schemas + event names shared by FE & BE (npm workspaces, no build step) |
| Proxy / TLS | Caddy v2 (automatic HTTPS + transparent WebSocket upgrade) |
| Lint / Test | oxlint · Vitest |

Monorepo via npm workspaces: `shared/`, `BE/`, `FE/`.

## Develop locally

```bash
npm install            # installs all workspaces

# Run the two dev servers (separate terminals):
npm run dev:be         # BE on http://localhost:3000 (socket.io)
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

## Deploy (Docker + Caddy)

Built and run on the droplet — no registry, manual deploy:

```bash
git pull
docker compose up -d --build
```

- **Local / IP (plain HTTP):** leave `SITE_ADDRESS` unset — Caddy serves on `:80`.
- **Production (automatic HTTPS):** point a domain's DNS at the droplet, open ports 80+443,
  then:

  ```bash
  SITE_ADDRESS=planning.example.com docker compose up -d --build
  ```

Caddy routes `/socket.io*` to the Node BE (`be:3000`) and everything else to the static FE
(`fe:80`), upgrading WebSockets transparently.

> Redeploys restart the BE and therefore drop all live rooms (in-memory by design). The
> client auto-reconnects, but an active round is lost.
