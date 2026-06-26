# BE Topology Glossary

The vocabulary used to describe the Planning Poker backend's structure. Terms are
grounded in the actual files under `BE/src` and the shared contract in `shared/`.
Use these names consistently in code comments, commit messages, and discussion.

---

## Layers & boundaries

### Composition root

The single file that wires concrete dependencies together and touches the OS.
Here that is `server.ts`: it reads `PORT`, starts the node server, attaches the WS
upgrade handler, and owns signal handling / graceful shutdown. It contains **no
business logic** — it only boots what the build seam constructs.

### Build seam (dependency injection)

`app.ts` and its `createApp(deps)` factory. It constructs the registries and wires
routes, accepting injectable dependencies so tests can supply and inspect their own
`RoomRegistry` / `ConnectionRegistry`. `server.ts` calls it with none and gets the
defaults. This seam is what makes the service integration-testable without a real
socket.

### Transport boundary

The line above which code speaks raw WebSocket/HTTP and below which code speaks the
`@pp/shared` contract. Only **two files** cross it: `ws/gateway.ts` and
`ws/connection-registry.ts`. Everything deeper is transport-agnostic.

### Domain boundary (ADR-001)

The rule that the domain (`domain/rooms.ts`) never holds a socket — it stores only an
opaque `connectionId` string. This keeps all transport knowledge out of the business
logic. Fan-out is resolved by handing connection ids back up to the transport layer
rather than letting the domain send anything itself.

### Layered / hexagonal architecture

The overall shape: ingress (transport) → application (router) → domain (registries) →
shared contract, with dependencies pointing inward. The domain has zero imports from
the transport layer; the transport depends on the domain through narrow interfaces.

---

## Transport-layer terms

### Gateway

`ws/gateway.ts`. The one place the WebSocket transport type lives. `createWsHandler`
is a factory that runs **once per connection**, closing over a per-connection
`connectionId`. Its only jobs: mint an id on open, size-guard + decode + dispatch each
frame, and run the disconnect path on close.

### Connection

A single live WebSocket between one client and the server. Identified server-side by a
`connectionId`. A connection is transport state; a participant is domain state — the
two are bound together but distinct (see **Reconnection**).

### connectionId

A server-minted opaque handle (`randomUUID`) for one live socket. It is the **trusted
identity**: the server assigns it on open and the client can never supply or forge it.
Both registries key off it, which is what lets the domain stay socket-free.

### Envelope

The JSON wrapper around every WS frame, defined in `shared/src/protocol.ts`. Replaces
socket.io's implicit event/ack framing. Three kinds (`ENVELOPE_KIND`):

- **`req`** — client → server request; carries an `id` only when it awaits an ack.
- **`evt`** — server → client broadcast/push; no correlation id.
- **`ack`** — server → client reply to a correlated `req`, matched by `id`.

### Frame

One physical WS message (a single `JSON.stringify`'d envelope on the wire). The
**frame-size guard** (`MAX_FRAME_BYTES`, 100 KB) rejects oversized or non-text frames
with close code 1009 _before_ any parse — the parity replacement for socket.io's
`maxHttpBufferSize`.

### Frame vs payload validation

Two-stage validation. `envelope.ts` validates the **frame only** (`kind`/`event`/`id`)
via `clientEnvelopeSchema`; the inner `payload` stays `unknown`. The **payload** is
validated later, per-event, by the matching zod schema in the router (ADR-002).

### Decode

`ws/envelope.ts#decodeClientFrame`. Turns one inbound text frame into a typed
`ParsedClientEnvelope` (or `ok:false`). Never throws — malformed input is dropped
silently because a pre-handshake client has no correlation id or room to report an
error back on.

### Dispatch

`ws/router.ts#dispatch`. The switch over `C2S` event names that routes a decoded
envelope to its per-event handler. The body of the former `handlers.ts`.

### Handler

A per-event function in the router (`handleCreateRoom`, `handleCastVote`, …). Each
follows one shape: `validate(payload)` → resolve identity → call domain → ack or
broadcast.

### Ack channel vs event channel

The two ways the server replies.

- **Ack** (`sendAck`): correlated reply to a `req` that carried an `id`
  (createRoom / joinRoom). The FE matches it back by `id`.
- **Event** (`sendEvent`): an uncorrelated push. Fire-and-forget commands
  (vote/reveal/reset) have no ack channel, so errors come back as an `errorEvent`.
  `replyError` prefers the ack channel and falls back to `emitError` when there's no id.

### Sendable

The minimal interface the `ConnectionRegistry` needs from a live socket
(`send` / `readyState` / `close`). Satisfied by Hono's `WSContext` and by a trivial
fake in tests, so the registry never imports a transport type.

### Broadcast / fan-out

Pushing one event to every connection in a room: `broadcastToRoom(roomCode, event,
payload)`. Replaces socket.io's `io.to(code).emit(...)`. It resolves membership via the
domain's `connectionIdsIn(roomCode)` accessor, then `sendEvent` per id.

---

## Registries (the two-registry split)

### RoomRegistry

`domain/rooms.ts`. In-memory, socket-free domain state and the room lifecycle
(create / join / leave / setTask / castVote / reveal / reset). Holds `rooms:
Map<code, Room>` and a `bySocket` reverse index. The authoritative source of truth.

### ConnectionRegistry

`ws/connection-registry.ts`. The transport-aware sibling. Owns `connectionId → Sendable`
and turns domain results into wire envelopes (`sendEvent` / `sendAck` /
`broadcastToRoom` / `closeAll`). Depends on `RoomRegistry` for room membership but the
domain has no reverse dependency on it.

### Reverse index (`bySocket`)

`Map<connectionId, {roomCode, participantId}>` inside `RoomRegistry`. Resolves which
room/participant a socket belongs to in O(1) on disconnect, without scanning rooms.
Maintained on join, reconnection rebind, and leave.

---

## Domain terms

### Room

A planning-poker session, keyed by a human-readable **room code**. Holds participants,
votes, the current task, reveal state, and the host pointer. Ephemeral by design — no
persistence; a room is deleted when its last participant leaves.

### Room code

A 6-character upper-case id from a reduced alphabet (`0/O`, `1/I` excluded) so it's easy
to read aloud. Normalized (trim + upper-case) on every lookup.

### Participant

A person in a room (domain identity), distinct from their connection. Carries
`id`, `displayName`, `isHost`, `hasVoted`, `joinedAt`, and the current `connectionId`.

### Host

The participant with room authority (set task / reveal / reset). On host departure the
role transfers deterministically to the **oldest survivor** (smallest `joinedAt`),
broadcast via `hostChanged`.

### Reconnection (rebind)

When a client rejoins with a known `participantId`, the existing participant is
**rebound** to the new `connectionId` — preserving `joinedAt` (so host-succession
ordering stays stable) and host status — rather than created anew. The stale socket's
later `disconnect` becomes a safe no-op (guarded by a current-socket check).

### Presence

The roster broadcast (`S2C.presence`): public participant list with the `hasVoted`
**dot** but never vote values. Pushed on join, vote, task change, reset, and departure.

### Reveal / hidden votes

Votes are stored `hidden: true` and only the `hasVoted` dot is broadcast while voting is
open. `reveal` (host-only) flips them visible and emits `revealed` with values + stats.
This no-value-leak guarantee is a core domain invariant.

### Round

One estimation cycle for a task. `reset` clears votes/reveal state but **keeps** the
task (re-estimate the same item); `setTask` clears the round and sets a new task.

### Public DTO boundary

The serialization seam in `RoomRegistry` (`toPublic`, `buildRoomState`) that maps
internal `Participant`/`Room` state to the public payloads on the wire — dropping
`connectionId` and hidden vote values.

---

## Shared contract

### `@pp/shared`

The package both FE and BE import so the wire format can't drift. Contains: event
catalogs (`C2S` / `S2C`), `LIMITS`, the zod payload schemas (`events.ts`), the envelope
definitions (`protocol.ts`), domain types (`types.ts`), and the card deck (`deck.ts`).

### C2S / S2C

The event-name catalogs. **C2S** = client → server (createRoom, joinRoom, setTask,
castVote, reveal, reset). **S2C** = server → client (roomState, presence, taskUpdated,
revealed, roundReset, hostChanged, errorEvent).

### LIMITS

Cheap abuse guards in the shared contract: max display-name/task lengths, room-code
length, and capacity caps (`maxRooms`, `maxParticipantsPerRoom`). Shape/size limits, not
full rate-limiting.

### ADR (architecture decision record)

Referenced in-code as the rationale for boundaries (see [`adr/`](adr/README.md)):

- **[ADR-001](adr/0001-domain-stays-socket-free.md)** — the domain stays socket-free
  (holds only `connectionId`).
- **[ADR-002](adr/0002-validate-every-inbound-message.md)** — every inbound message is
  validated via a thin `safeParse` wrapper (`lib/validation.ts`), replying with an error
  instead of throwing.

---

## Operational terms

### Health endpoint

`GET /health` (`http/health.ts`). Returns `{ status: "ok", rooms: roomCount }` — a
liveness + state signal for container/proxy probes.

### Graceful shutdown

On SIGTERM/SIGINT, `server.ts` closes all live sockets first (`closeAll`, code 1001
"Going Away") because `server.close()` does not drain WebSockets, then closes the HTTP
server, with a 5s `unref()` failsafe so a stuck socket can't hang exit.

### Ephemeral / single-process state

All room state lives in process memory with no persistence. Implication: the service is
currently single-instance — horizontal scaling would require an external shared store or
a sticky-routing + pub/sub layer for cross-instance broadcast.
