import { randomUUID } from "node:crypto";
import {
  ENVELOPE_KIND,
  S2C,
  type ErrorEventPayload,
  type ServerEnvelope,
} from "@pp/shared";
import type { RoomRegistry } from "../domain/rooms";

type S2CEvent = (typeof S2C)[keyof typeof S2C];

/**
 * The minimal surface this registry needs from a live socket. Satisfied by hono's
 * `WSContext` (its `send` accepts a string and `readyState` is a 0..3 getter) and by a
 * trivial fake in tests — so the registry never imports a transport type.
 */
export interface Sendable {
  send(data: string): void;
  readonly readyState?: number;
  close?(code?: number, reason?: string): void;
}

/** WebSocket OPEN readyState. */
const OPEN = 1;

export type AckResult =
  | { ok: true; payload: unknown }
  | { ok: false; error: ErrorEventPayload };

/**
 * Transport-aware sibling of `RoomRegistry`: owns the `connectionId -> live socket` map
 * and turns domain calls into wire envelopes. `RoomRegistry` stays socket-free (ADR-001);
 * room fan-out is resolved via its opaque `connectionIdsIn` accessor.
 */
export class ConnectionRegistry {
  private readonly sockets = new Map<string, Sendable>();

  constructor(private readonly rooms: RoomRegistry) {}

  /** On WS open: mint the opaque connectionId handed to `RoomRegistry`. */
  register(ws: Sendable): string {
    const id = randomUUID();
    this.sockets.set(id, ws);
    return id;
  }

  unregister(connectionId: string): void {
    this.sockets.delete(connectionId);
  }

  get size(): number {
    return this.sockets.size;
  }

  /**
   * Is this connection still backed by an open socket? Used by the idle reaper to spare
   * rooms whose participants are present-but-silent (connected, just not mutating state).
   * Mirrors the OPEN check in `sendEnvelope`: a socket whose `readyState` reports anything
   * other than OPEN (closing/closed) is not live. An unknown id is not live.
   */
  isLive(connectionId: string): boolean {
    const ws = this.sockets.get(connectionId);
    if (!ws) return false;
    return ws.readyState === undefined || ws.readyState === OPEN;
  }

  private sendEnvelope(connectionId: string, env: ServerEnvelope): void {
    const ws = this.sockets.get(connectionId);
    if (!ws) return;
    if (ws.readyState !== undefined && ws.readyState !== OPEN) return;
    ws.send(JSON.stringify(env));
  }

  /** Push an S2C event to a single connection. */
  sendEvent(connectionId: string, event: S2CEvent, payload: unknown): void {
    this.sendEnvelope(connectionId, {
      kind: ENVELOPE_KIND.event,
      event,
      payload,
    });
  }

  /** Reply to a correlated request (createRoom/joinRoom), matched by `id` on the FE. */
  sendAck(connectionId: string, id: string, result: AckResult): void {
    this.sendEnvelope(
      connectionId,
      result.ok
        ? { kind: ENVELOPE_KIND.ack, id, ok: true, payload: result.payload }
        : { kind: ENVELOPE_KIND.ack, id, ok: false, error: result.error },
    );
  }

  /** Replaces `io.to(code).emit(event, payload)` — fan out to current room membership. */
  broadcastToRoom(roomCode: string, event: S2CEvent, payload: unknown): void {
    for (const cid of this.rooms.connectionIdsIn(roomCode)) {
      this.sendEvent(cid, event, payload);
    }
  }

  /** Close every live socket (graceful shutdown). 1001 = "Going Away". */
  closeAll(code = 1001, reason = "server shutting down"): void {
    this.closeAndDrop(this.sockets.keys(), code, reason);
  }

  /**
   * Close + unregister the given orphaned connections (e.g. those of a reaped room, whose
   * domain entry is already gone). The caller supplies the ids because the room no longer
   * resolves via `connectionIdsIn`. 1001 = "Going Away".
   *
   * **Idempotency note:** calling `ws.close()` will trigger the gateway `onClose` callback,
   * which calls `handleDisconnect` → `registry.leave()`. By that point `reapExpired` has
   * already deleted the room and purged `bySocket`, so `leave()` finds no entry and returns
   * null — its documented stale-socket no-op path. The subsequent `connections.unregister`
   * inside `handleDisconnect` calls `sockets.delete` on an id we deleted just below, which
   * is also a no-op. The double-cleanup is therefore intentionally idempotent and safe.
   */
  closeConnections(
    connectionIds: Iterable<string>,
    code = 1001,
    reason = "room expired",
  ): void {
    this.closeAndDrop(connectionIds, code, reason);
  }

  /**
   * The single socket-teardown path: close each socket (if it exposes `close`) and drop it
   * from the map. `closeAll` feeds it every id (`this.sockets.keys()`); `closeConnections`
   * feeds a subset. Deleting the just-visited key mid-iteration is safe for a Map iterator —
   * it only ever drops the current key, never one not yet reached.
   */
  private closeAndDrop(
    connectionIds: Iterable<string>,
    code: number,
    reason: string,
  ): void {
    for (const cid of connectionIds) {
      this.sockets.get(cid)?.close?.(code, reason);
      this.sockets.delete(cid);
    }
  }
}
