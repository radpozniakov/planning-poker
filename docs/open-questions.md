# Open Questions

Carried from the deep-interview spec. Items marked **ratification checkpoint** record a
decision already made in the plan's ADRs — they only ask for confirmation, they are not
blockers. Items marked **open** still need a real answer.

1. **Product name.** The spec calls it "Planning Picker"; the repo is `planning-poker`.
   Which is the canonical display name? (The repo directory can stay `planning-poker`.)
   The UI currently shows "Planning Picker".

2. **WebSocket library — ratification checkpoint.** ADR-001 chose `socket.io` over native
   `ws` (built-in rooms, reconnection, heartbeat; ~10–20 KB client). Confirm acceptable.

3. **Build strain — open-ish.** Building two images + installing deps on a low-power
   droplet is slow. Revisit moving to CI-built images + `docker compose pull` in a later
   stage (see scope "Next stage candidates").

4. **Domain / TLS — OPEN.** Does the droplet have a domain name for Caddy automatic HTTPS,
   or do we run on IP / plain HTTP for now? Caddy auto-HTTPS needs a real domain pointed at
   the droplet with ports 80+443 open. The compose file defaults `SITE_ADDRESS` to `:80`
   (plain HTTP); set `SITE_ADDRESS=your.domain.example` to enable HTTPS. **Affects the
   Caddy site address.**

5. **Reconnection fidelity — ratification checkpoint.** ADR-004 chose "an in-flight
   (un-revealed) vote may reset on refresh" as acceptable for Stage 1. Restoring vote state
   on rejoin is a deliberately deferred enhancement, not a gap.

6. **Card semantics — ratification checkpoint.** Stats exclude `?`/`☕` from min/max/avg and
   return nulls when there are no numeric votes. Confirm this is the desired behavior.

7. **Reconnect identity — deferred, accepted (from security review).** Reconnection trusts the
   `participantId` (a 122-bit `randomUUID`) as proof of identity. Because that id is also each
   participant's public `id` (broadcast in `presence`/`roomState`), any member of a room could in
   principle rebind to — and inherit host from — another member of the **same** room. Accepted at
   the co-located-team trust level (ADR-004: "room codes are not secrets"). Next-stage fix if the
   trust model widens: issue a separate, never-broadcast reconnect token, returned only on the
   create/join ack and required on the reconnect branch. (Backend socket.io CORS is already
   same-origin-only in production; revisit only if a session/cookie is ever introduced.)
