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
import { logger, type Logger } from "../lib/logger";
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
  rootLog: Logger = logger,
): void {
  // Build a child logger enriched with connection + room/participant context where available.
  const ctx = registry.contextFor(connectionId);
  const log = rootLog.child({
    connectionId,
    ...(ctx
      ? { roomCode: ctx.roomCode, participantId: ctx.participantId }
      : {}),
  });

  switch (env.event) {
    case C2S.createRoom:
      return handleCreateRoom(connectionId, env, registry, connections, log);
    case C2S.joinRoom:
      return handleJoinRoom(connectionId, env, registry, connections, log);
    case C2S.setTask:
      return handleSetTask(connectionId, env, registry, connections, log);
    case C2S.castVote:
      return handleCastVote(connectionId, env, registry, connections, log);
    case C2S.reveal:
      return handleReveal(connectionId, env, registry, connections, log);
    case C2S.reset:
      return handleReset(connectionId, env, registry, connections, log);
    default:
      log.warn({ event: (env as { event: string }).event }, "unknown event");
  }
}

/** Mirror of socket.io `disconnect`: remove the leaver, broadcast host change + presence. */
export function handleDisconnect(
  connectionId: string,
  registry: RoomRegistry,
  connections: ConnectionRegistry,
  rootLog: Logger = logger,
): void {
  const result = registry.leave(connectionId);
  if (!result || result.roomGone) {
    connections.unregister(connectionId);
    return;
  }
  const log = rootLog.child({ connectionId, roomCode: result.roomCode });
  log.info(
    { parked: result.roomGone, hostChanged: result.hostChanged },
    "participant left",
  );
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
  log: Logger,
): void {
  const parsed = validate(createRoomSchema, env.payload);
  if (!parsed.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      "VALIDATION",
      parsed.message,
      log,
    );

  const result = registry.createRoom(connectionId, parsed.data.displayName);
  if (!result.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      result.code,
      result.message,
      log,
    );

  const { room, participant } = result;
  log.info(
    { roomCode: room.code, participantId: participant.id },
    "room created",
  );
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
  log: Logger,
): void {
  const parsed = validate(joinRoomSchema, env.payload);
  if (!parsed.ok)
    return replyError(
      connections,
      connectionId,
      env.id,
      "VALIDATION",
      parsed.message,
      log,
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
      log,
    );

  const { room, participant, reconnected } = result;
  log.info(
    { roomCode: room.code, participantId: participant.id, reconnected },
    "room joined",
  );
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
  log: Logger,
): void {
  const parsed = validate(setTaskSchema, env.payload);
  if (!parsed.ok)
    return emitError(
      connections,
      connectionId,
      "VALIDATION",
      parsed.message,
      log,
    );

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
      log,
    );

  const result = registry.setTask(
    ctx.roomCode,
    ctx.participantId,
    parsed.data.description,
  );
  if (!result.ok)
    return emitError(
      connections,
      connectionId,
      result.code,
      result.message,
      log,
    );

  const { room } = result;
  log.info({ roomCode: room.code }, "task set");
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
  log: Logger,
): void {
  const parsed = validate(castVoteSchema, env.payload);
  if (!parsed.ok)
    return emitError(
      connections,
      connectionId,
      "VALIDATION",
      parsed.message,
      log,
    );

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
      log,
    );

  const result = registry.castVote(
    ctx.roomCode,
    ctx.participantId,
    parsed.data.cardValue,
  );
  if (!result.ok)
    return emitError(
      connections,
      connectionId,
      result.code,
      result.message,
      log,
    );

  // CRITICAL: log only participantId — never cardValue (vote privacy invariant, AC-6).
  log.info({ participantId: ctx.participantId }, "vote recorded");
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
  log: Logger,
): void {
  const parsed = validate(revealSchema, env.payload);
  if (!parsed.ok)
    return emitError(
      connections,
      connectionId,
      "VALIDATION",
      parsed.message,
      log,
    );

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
      log,
    );

  const result = registry.reveal(ctx.roomCode, ctx.participantId);
  if (!result.ok)
    return emitError(
      connections,
      connectionId,
      result.code,
      result.message,
      log,
    );

  log.info(
    { roomCode: result.room.code, stats: result.stats },
    "votes revealed",
  );
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
  log: Logger,
): void {
  const parsed = validate(resetSchema, env.payload);
  if (!parsed.ok)
    return emitError(
      connections,
      connectionId,
      "VALIDATION",
      parsed.message,
      log,
    );

  const ctx = registry.contextFor(connectionId);
  if (!ctx)
    return emitError(
      connections,
      connectionId,
      "NOT_IN_ROOM",
      "join a room first",
      log,
    );

  const result = registry.reset(ctx.roomCode, ctx.participantId);
  if (!result.ok)
    return emitError(
      connections,
      connectionId,
      result.code,
      result.message,
      log,
    );

  const { room } = result;
  log.info({ roomCode: room.code }, "round reset");
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
  log: Logger,
): void {
  log.warn({ code, message }, "emitError");
  connections.sendEvent(connectionId, S2C.errorEvent, { code, message });
}

/** Prefer the ack channel (create/join carry an id); fall back to an errorEvent if none. */
function replyError(
  connections: ConnectionRegistry,
  connectionId: string,
  id: string | undefined,
  code: ErrorCode,
  message: string,
  log: Logger,
): void {
  log.warn({ code, message }, "replyError");
  if (id) {
    connections.sendAck(connectionId, id, {
      ok: false,
      error: { code, message },
    });
    return;
  }
  connections.sendEvent(connectionId, S2C.errorEvent, { code, message });
}
