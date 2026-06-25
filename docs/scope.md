# Planning Picker — Scope

This project is built **stage by stage**. This document describes what is in (and out of)
the current stage. Older stages stay shipped; later stages append.

## Stage 1 — MVP (current)

The thinnest demoable happy path of a self-hosted, single-task, real-time planning-poker
tool for a tiny team.

**In scope**

- Anonymous join: shareable 6-character room link/code + a display name. No accounts, no
  auth, no user store.
- One room, one task at a time. Host sets a task → participants pick a hidden Fibonacci
  card (`0,1,2,3,5,8,13,21,?,☕`) → host reveals all simultaneously → app shows
  min / max / average (numeric cards only) + an "all agree" indicator → host clears for
  the next task.
- Full real-time over WebSocket (socket.io): live presence, "has voted" indicators,
  simultaneous reveal pushed to all clients.
- Lightweight host = the room creator; controls reveal / set-task / reset. Host transfers
  to the oldest remaining participant if the creator leaves. No kick/moderation.
- In-memory only — rooms live in the BE process and are intentionally lost on
  restart/redeploy. **No database.**
- Reconnection: a refreshed tab silently rejoins the same room with its stored name (an
  in-flight, un-revealed vote may reset — accepted).
- Cheap abuse guards: room cap, participant cap, zod validation + a WS message-size cap.
- Deploy: two app containers (static FE on nginx + Node BE) behind Caddy (auto-HTTPS + WS
  upgrade), one `docker-compose.yml`, manual `git pull` + `docker compose up -d --build`
  on a low-power droplet.

**Explicitly out of scope (Stage 1 non-goals)**

- No backlog / multiple tasks / history / re-vote tracking.
- No persistence or database; no recovery of live rooms across redeploys.
- No accounts, authentication, or roles beyond the lightweight host.
- No moderation (kick/ban), no full rate-limiting, no observability stack.
- No end-to-end (Playwright) tests yet (Vitest unit tests only — ADR-005).

## Operational notes

- **Redeploys end live rooms.** `docker compose up -d --build` restarts the BE, which
  drops all in-memory rooms by design. The FE will attempt to auto-reconnect, but an
  active estimation round is lost. This is an accepted trade-off for Stage 1.

## Next stage candidates (not committed)

- Restore in-flight vote state on reconnect (higher reconnection fidelity).
- Backlog of tasks + simple round history.
- CI-built images + `docker compose pull` to remove build strain from the droplet.
- Real rate-limiting / connection abuse protection.
- Playwright e2e coverage of the real-time happy path.
