import {
  C2S,
  S2C,
  castVoteSchema,
  createRoomSchema,
  joinRoomSchema,
  resetSchema,
  revealSchema,
  setTaskSchema,
  type CreateRoomResult,
  type ErrorCode,
  type JoinRoomResult,
  type ParsedClientEnvelope,
} from "@pp/shared";
import type { RoomRegistry } from "../domain/rooms";
import { validate } from "../lib/validation";
import type { ConnectionRegistry } from "./connection-registry";

/**
 * Decoded client event -> domain call -> ack/broadcast. This is the body of the former
 * `handlers.ts`, with socket.io replaced by the connection registry. Identity is trusted:
 * the `connectionId` is the server-minted handle, never client-supplied.
 */
export function dispatch(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  switch (env.event) {
    case C2S.createRoom:
      return handleCreateRoom(connectionId, env, registry, connections);
    case C2S.joinRoom:
      return handleJoinRoom(connectionId, env, registry, connections);
    case C2S.setTask:
      return handleSetTask(connectionId, env, registry, connections);
    case C2S.castVote:
      return handleCastVote(connectionId, env, registry, connections);
    case C2S.reveal:
      return handleReveal(connectionId, env, registry, connections);
    case C2S.reset:
      return handleReset(connectionId, env, registry, connections);
  }
}

/** Mirror of socket.io `disconnect`: remove the leaver, broadcast host change + presence. */
export function handleDisconnect(
  connectionId: string,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const result = registry.leave(connectionId);
  if (!result || result.roomDeleted) {
    connections.unregister(connectionId);
    return;
  }
  const room = registry.getRoom(result.roomCode);
  if (room) {
    if (result.hostChanged && result.hostParticipantId) {
      connections.broadcastToRoom(room.code, S2C.hostChanged, {
        hostParticipantId: result.hostParticipantId,
      });
    }
    connections.broadcastToRoom(room.code, S2C.presence, {
      participants: registry.toPublic(room),
    });
  }
  connections.unregister(connectionId);
}

// ---------------------------------------------------------------------------
// Per-event handlers
// ---------------------------------------------------------------------------

function handleCreateRoom(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(createRoomSchema, env.payload);
  if (!parsed.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      "VALIDATION",
      parsed.message,
    );

  const result = registry.createRoom(connectionId, parsed.data.displayName);
  if (!result.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      result.code,
      result.message,
    );

  const { room, participant } = result;
  const ack: CreateRoomResult = {
    ok: true,
    roomCode: room.code,
    participantId: participant.id,
    isHost: true,
  };
  if (env.id)
    connections.sendAck(connectionId, env.id, { ok: true, payload: ack });
  connections.broadcastToRoom(room.code, S2C.presence, {
    participants: registry.toPublic(room),
  });
}

function handleJoinRoom(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(joinRoomSchema, env.payload);
  if (!parsed.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      "VALIDATION",
      parsed.message,
    );

  const { roomCode, displayName, participantId } = parsed.data;
  const result = registry.joinRoom(
    connectionId,
    roomCode,
    displayName,
    participantId,
  );
  if (!result.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      result.code,
      result.message,
    );

  const { room, participant } = result;
  const ack: JoinRoomResult = {
    ok: true,
    participantId: participant.id,
    state: registry.buildRoomState(room),
  };
  if (env.id)
    connections.sendAck(connectionId, env.id, { ok: true, payload: ack });
  connections.broadcastToRoom(room.code, S2C.presence, {
    participants: registry.toPublic(room),
  });
}

function handleSetTask(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(setTaskSchema, env.payload);
  if (!parsed.ok)
    return emitError(connections, connectionId, "VALIDATION", parsed.message);

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
    );

  const result = registry.setTask(
    ctx.roomCode,
    ctx.participantId,
    parsed.data.description,
  );
  if (!result.ok)
    return emitError(connections, connectionId, result.code, result.message);

  const { room } = result;
  connections.broadcastToRoom(room.code, S2C.taskUpdated, {
    task: room.currentTask,
  });
  connections.broadcastToRoom(room.code, S2C.presence, {
    participants: registry.toPublic(room),
  });
}

function handleCastVote(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(castVoteSchema, env.payload);
  if (!parsed.ok)
    return emitError(connections, connectionId, "VALIDATION", parsed.message);

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
    );

  const result = registry.castVote(
    ctx.roomCode,
    ctx.participantId,
    parsed.data.cardValue,
  );
  if (!result.ok)
    return emitError(connections, connectionId, result.code, result.message);

  // Broadcast presence only — the "voted" dot, never the value.
  connections.broadcastToRoom(result.room.code, S2C.presence, {
    participants: registry.toPublic(result.room),
  });
}

function handleReveal(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(revealSchema, env.payload);
  if (!parsed.ok)
    return emitError(connections, connectionId, "VALIDATION", parsed.message);

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
    );

  const result = registry.reveal(ctx.roomCode, ctx.participantId);
  if (!result.ok)
    return emitError(connections, connectionId, result.code, result.message);

  connections.broadcastToRoom(result.room.code, S2C.revealed, {
    votes: result.votes,
    stats: result.stats,
  });
}

function handleReset(
  connectionId: string,
  env: ParsedClientEnvelope,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): void {
  const parsed = validate(resetSchema, env.payload);
  if (!parsed.ok)
    return emitError(connections, connectionId, "VALIDATION", parsed.message);

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
    );

  const result = registry.reset(ctx.roomCode, ctx.participantId);
  if (!result.ok)
    return emitError(connections, connectionId, result.code, result.message);

  const { room } = result;
  connections.broadcastToRoom(room.code, S2C.roundReset, {});
  connections.broadcastToRoom(room.code, S2C.presence, {
    participants: registry.toPublic(room),
  });
}

// ---------------------------------------------------------------------------
// Error replies (port of handlers.ts replyError/emitError)
// ---------------------------------------------------------------------------

/** Push an error as an S2C event (fire-and-forget commands have no ack channel). */
function emitError(
  connections: ConnectionRegistry,
  connectionId: string,
  code: ErrorCode,
  message: string,
): void {
  connections.sendEvent(connectionId, S2C.errorEvent, { code, message });
}

/** Prefer the ack channel (create/join carry an id); fall back to an errorEvent if none. */
function replyError(
  connections: ConnectionRegistry,
  connectionId: string,
  id: string | undefined,
  code: ErrorCode,
  message: string,
): void {
  if (id) {
    connections.sendAck(connectionId, id, {
      ok: false,
      error: { code, message },
    });
    return;
  }
  emitError(connections, connectionId, code, message);
}
