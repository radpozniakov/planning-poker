# ADR-001: The domain stays socket-free

- **Status:** Accepted
- **Deciders:** BE team
- **Related:** [ADR-002](0002-validate-every-inbound-message.md), [glossary](../glossary.md)
- **Code:** `domain/rooms.ts`, `ws/connection-registry.ts`, `ws/gateway.ts`

## Context

The backend is a real-time WebSocket service. The naïve approach is to let the
domain (rooms, participants, votes) hold live socket references and emit directly —
which is roughly what the original socket.io implementation did. That couples the
business logic to a specific transport: the domain can no longer be unit-tested
without a real socket, swapping the transport (socket.io → native WS) ripples through
every room method, and broadcast/lifecycle concerns leak into estimation logic.

We later migrated from socket.io to native WebSockets (`@hono/node-ws`). That migration
is only cheap if the domain doesn't know what a socket is.

## Decision

The domain layer **never holds a socket**. `RoomRegistry` stores only an opaque
`connectionId: string` per participant — a server-minted handle, never client-supplied.

Two registries split the responsibility:

- **`RoomRegistry`** (`domain/rooms.ts`) — pure in-memory state and room lifecycle.
  Keyed by `connectionId`; zero transport imports.
- **`ConnectionRegistry`** (`ws/connection-registry.ts`) — the transport-aware sibling
  that owns `connectionId → Sendable` and turns domain results into wire envelopes.

Fan-out crosses the boundary by handing **ids upward**, not sockets downward: the domain
exposes `connectionIdsIn(roomCode)`, and the transport layer resolves each id to a live
socket and sends. The only socket contract the transport layer depends on is the narrow
`Sendable` interface (`send` / `readyState` / `close`), satisfied by Hono's `WSContext`
and by a trivial fake in tests.

The WebSocket transport type is confined to exactly two files: `ws/gateway.ts`
(connection lifecycle) and `ws/connection-registry.ts` (sending).

## Consequences

**Positive**

- The domain is unit-testable with plain values — no socket mocks.
- Transport swaps (socket.io → native WS) touch only the two transport files.
- The no-value-leak and host-transfer invariants live in one socket-free place that's
  easy to reason about and test.

**Negative / costs**

- An indirection: broadcasting requires a round-trip through `connectionIdsIn` rather
  than the domain emitting directly.
- Two registries must be kept consistent (the `bySocket` reverse index in the domain vs
  the `sockets` map in the transport layer).

**Implications**

- Identity is trusted from the server-minted `connectionId`; handlers resolve
  room/participant via `contextFor(connectionId)`, never from client-supplied fields.
