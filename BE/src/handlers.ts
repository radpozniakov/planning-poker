import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  C2S,
  S2C,
  castVoteSchema,
  createRoomSchema,
  joinRoomSchema,
  resetSchema,
  revealSchema,
  setTaskSchema,
  type ErrorCode,
} from "@pp/shared";
import { RoomRegistry } from "./rooms";
import { validate } from "./validation";

type AckFn = (response: unknown) => void;

/**
 * The ONE place socket.io lives on the server (ADR-001). Everything below speaks the
 * `@pp/shared` contract; the registry never sees a socket. A future native-`ws` swap is
 * a change to this file alone.
 */
export function createSocketServer(httpServer: HttpServer, registry: RoomRegistry): Server {
  const io = new Server(httpServer, {
    // Behind Caddy the FE and BE are same-origin, so production needs no cross-origin
    // grant; in dev the FE is served from vite on another port, so reflect there only.
    cors: { origin: process.env.NODE_ENV !== "production" },
    // Cheap abuse guard (spec line 41): reject oversized frames.
    maxHttpBufferSize: 100_000,
  });

  io.on("connection", (socket: Socket) => {
    socket.on(C2S.createRoom, (raw: unknown, ack?: AckFn) => {
      const parsed = validate(createRoomSchema, raw);
      if (!parsed.ok) return replyError(ack, socket, "VALIDATION", parsed.message);

      const result = registry.createRoom(socket.id, parsed.data.displayName);
      if (!result.ok) return replyError(ack, socket, result.code, result.message);

      const { room, participant } = result;
      socket.join(room.code);
      ack?.({ ok: true, roomCode: room.code, participantId: participant.id, isHost: true });
      io.to(room.code).emit(S2C.presence, { participants: registry.toPublic(room) });
    });

    socket.on(C2S.joinRoom, (raw: unknown, ack?: AckFn) => {
      const parsed = validate(joinRoomSchema, raw);
      if (!parsed.ok) return replyError(ack, socket, "VALIDATION", parsed.message);

      const { roomCode, displayName, participantId } = parsed.data;
      const result = registry.joinRoom(socket.id, roomCode, displayName, participantId);
      if (!result.ok) return replyError(ack, socket, result.code, result.message);

      const { room, participant } = result;
      socket.join(room.code);
      ack?.({ ok: true, participantId: participant.id, state: registry.buildRoomState(room) });
      io.to(room.code).emit(S2C.presence, { participants: registry.toPublic(room) });
    });

    socket.on(C2S.setTask, (raw: unknown) => {
      const parsed = validate(setTaskSchema, raw);
      if (!parsed.ok) return emitError(socket, "VALIDATION", parsed.message);

      const ctx = registry.contextFor(socket.id);
      if (!ctx) return emitError(socket, "NOT_IN_ROOM", "join a room first");

      const result = registry.setTask(ctx.roomCode, ctx.participantId, parsed.data.description);
      if (!result.ok) return emitError(socket, result.code, result.message);

      const { room } = result;
      io.to(room.code).emit(S2C.taskUpdated, { task: room.currentTask });
      io.to(room.code).emit(S2C.presence, { participants: registry.toPublic(room) });
    });

    socket.on(C2S.castVote, (raw: unknown) => {
      const parsed = validate(castVoteSchema, raw);
      if (!parsed.ok) return emitError(socket, "VALIDATION", parsed.message);

      const ctx = registry.contextFor(socket.id);
      if (!ctx) return emitError(socket, "NOT_IN_ROOM", "join a room first");

      const result = registry.castVote(ctx.roomCode, ctx.participantId, parsed.data.cardValue);
      if (!result.ok) return emitError(socket, result.code, result.message);

      // Broadcast presence only — the "voted" dot, never the value.
      io.to(result.room.code).emit(S2C.presence, { participants: registry.toPublic(result.room) });
    });

    socket.on(C2S.reveal, (raw: unknown) => {
      const parsed = validate(revealSchema, raw);
      if (!parsed.ok) return emitError(socket, "VALIDATION", parsed.message);

      const ctx = registry.contextFor(socket.id);
      if (!ctx) return emitError(socket, "NOT_IN_ROOM", "join a room first");

      const result = registry.reveal(ctx.roomCode, ctx.participantId);
      if (!result.ok) return emitError(socket, result.code, result.message);

      io.to(result.room.code).emit(S2C.revealed, { votes: result.votes, stats: result.stats });
    });

    socket.on(C2S.reset, (raw: unknown) => {
      const parsed = validate(resetSchema, raw);
      if (!parsed.ok) return emitError(socket, "VALIDATION", parsed.message);

      const ctx = registry.contextFor(socket.id);
      if (!ctx) return emitError(socket, "NOT_IN_ROOM", "join a room first");

      const result = registry.reset(ctx.roomCode, ctx.participantId);
      if (!result.ok) return emitError(socket, result.code, result.message);

      const { room } = result;
      io.to(room.code).emit(S2C.roundReset, {});
      io.to(room.code).emit(S2C.presence, { participants: registry.toPublic(room) });
    });

    socket.on("disconnect", () => {
      const result = registry.leave(socket.id);
      if (!result || result.roomDeleted) return;

      const room = registry.getRoom(result.roomCode);
      if (!room) return;
      if (result.hostChanged && result.hostParticipantId) {
        io.to(room.code).emit(S2C.hostChanged, { hostParticipantId: result.hostParticipantId });
      }
      io.to(room.code).emit(S2C.presence, { participants: registry.toPublic(room) });
    });
  });

  return io;
}

function emitError(socket: Socket, code: ErrorCode, message: string): void {
  socket.emit(S2C.errorEvent, { code, message });
}

/** Prefer the ack channel (create/join); fall back to an errorEvent if there is none. */
function replyError(ack: AckFn | undefined, socket: Socket, code: ErrorCode, message: string): void {
  if (ack) {
    ack({ ok: false, error: { code, message } });
    return;
  }
  emitError(socket, code, message);
}
