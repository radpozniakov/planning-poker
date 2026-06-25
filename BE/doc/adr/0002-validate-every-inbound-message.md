# ADR-002: Validate every inbound message, reply instead of throw

- **Status:** Accepted
- **Deciders:** BE team
- **Related:** [ADR-001](0001-domain-stays-socket-free.md), [glossary](../glossary.md)
- **Code:** `lib/validation.ts`, `ws/envelope.ts`, `ws/router.ts`, `shared/src/events.ts`

## Context

Every WebSocket frame from a client is untrusted input. Without a disciplined boundary,
malformed or hostile payloads either crash a handler (an uncaught throw can take down
the connection or process) or silently corrupt room state. We need one predictable
contract for *where* validation happens and *what* happens on failure.

The data also arrives in two distinct trust shapes: the **frame** (the envelope:
`kind`/`event`/`id`) and the **payload** (the per-event body), which differ per event.

## Decision

**Validate at the boundary, in two stages, and never throw on bad input.**

1. **Frame validation** — `ws/envelope.ts#decodeClientFrame` runs a raw byte-size guard
   (`MAX_FRAME_BYTES`), then `JSON.parse`, then `clientEnvelopeSchema` (zod). It
   validates the frame only; the inner `payload` stays `unknown`. Malformed frames return
   `ok:false` and are dropped silently — a pre-handshake client has no correlation id or
   room to report an error back on.

2. **Payload validation** — each handler in `ws/router.ts` validates its payload with the
   matching per-event zod schema (`shared/src/events.ts`) through the thin
   `lib/validation.ts#validate` wrapper, which uses `safeParse` and returns a
   `{ ok, data } | { ok, message }` result. The shared schemas (and `LIMITS`) are the
   single source of truth for both FE and BE.

On failure the handler **replies**, it does not throw:
- correlated requests (carry an `id`) get an error **ack** (`replyError`);
- fire-and-forget commands get an `errorEvent` push (`emitError`).

## Consequences

**Positive**
- One uniform failure mode: a bad message yields a typed error reply, never a crash.
- `unknown` payloads are narrowed to typed data exactly once, at the boundary; the domain
  receives only validated values.
- FE and BE cannot drift, because both import the same zod schemas and `LIMITS`.

**Negative / costs**
- Every event needs a schema and an explicit validate step — boilerplate that must be
  kept in sync as events are added.
- Silent-drop on malformed frames means a buggy client gets no feedback pre-handshake;
  acceptable here, but worth noting for debugging.

**Implications**
- These are shape/size guards, not rate-limiting or auth. Abuse limits beyond `LIMITS`
  (per-connection throttling, etc.) remain out of scope for this ADR.
