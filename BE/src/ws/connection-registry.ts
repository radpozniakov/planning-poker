import { randomUUID } from "node:crypto";
import { ENVELOPE_KIND, S2C, type ErrorEventPayload, type ServerEnvelope } from "@pp/shared";
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

  private sendEnvelope(connectionId: string, env: ServerEnvelope): void {
    const ws = this.sockets.get(connectionId);
    if (!ws) return;
    if (ws.readyState !== undefined && ws.readyState !== OPEN) return;
    ws.send(JSON.stringify(env));
  }

  /** Push an S2C event to a single connection. */
  sendEvent(connectionId: string, event: S2CEvent, payload: unknown): void {
    this.sendEnvelope(connectionId, { kind: ENVELOPE_KIND.event, event, payload });
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
    for (const ws of this.sockets.values()) {
      ws.close?.(code, reason);
    }
    this.sockets.clear();
  }
}
