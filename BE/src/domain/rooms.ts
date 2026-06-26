import { randomInt, randomUUID } from "node:crypto";
import {
  LIMITS,
  type CardValue,
  type ErrorCode,
  type Participant,
  type PublicParticipant,
  type Room,
  type RoomStatePayload,
  type Vote,
} from "@pp/shared";
import { computeVoteStats } from "./stats";

/** Ambiguous-looking characters (0/O, 1/I) are excluded so codes are easy to read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; code: ErrorCode; message: string };
type Result<T> = Ok<T> | Err;

function ok<T>(data: T): Ok<T> {
  return { ok: true, ...data };
}
function err(code: ErrorCode, message: string): Err {
  return { ok: false, code, message };
}

export interface LeaveResult {
  roomCode: string;
  removedParticipantId: string;
  roomDeleted: boolean;
  hostChanged: boolean;
  hostParticipantId: string | null;
}

/**
 * In-memory room registry (no persistence — ephemeral by design, spec line 38).
 * Knows nothing about socket.io: the only handle it stores is an opaque `connectionId`
 * string, so the entire transport is confined to `handlers.ts`.
 *
 * A reverse index `Map<connectionId, {roomCode, participantId}>` resolves the leaver on
 * `disconnect` in O(1) without scanning rooms. It is maintained on join, reconnection
 * rebind, and leave.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly bySocket = new Map<
    string,
    { roomCode: string; participantId: string }
  >();

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(normalizeCode(roomCode));
  }

  /** Resolve which room/participant a live socket belongs to (trusted caller identity). */
  contextFor(
    connectionId: string,
  ): { roomCode: string; participantId: string } | undefined {
    return this.bySocket.get(connectionId);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Opaque connectionIds of every participant currently in a room (empty if the room is
   * gone). Lets the transport layer fan a broadcast out to the room without the registry
   * ever holding a socket — preserves the connectionId boundary (ADR-001).
   */
  connectionIdsIn(roomCode: string): string[] {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return [];
    return [...room.participants.values()].map((p) => p.connectionId);
  }

  // -------------------------------------------------------------------------
  // Wire serialization (public DTO boundary)
  // -------------------------------------------------------------------------

  /** Map internal Participants -> PublicParticipant[] (drops connectionId; never a value). */
  toPublic(room: Room): PublicParticipant[] {
    return [...room.participants.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      isHost: p.isHost,
      hasVoted: p.hasVoted,
    }));
  }

  /** Build the join/reconnect snapshot. `stats` is included only once revealed. */
  buildRoomState(room: Room): RoomStatePayload {
    return {
      roomCode: room.code,
      participants: this.toPublic(room),
      task: room.currentTask,
      revealed: room.revealed,
      stats: room.revealed ? computeVoteStats(room.votes.values()) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  createRoom(
    connectionId: string,
    displayName: string,
    now: number = Date.now(),
  ): Result<{ room: Room; participant: Participant }> {
    if (this.rooms.size >= LIMITS.maxRooms) {
      return err(
        "TOO_MANY_ROOMS",
        "the server is at capacity, try again later",
      );
    }
    const code = this.generateUniqueCode();
    const participant: Participant = {
      id: randomUUID(),
      displayName,
      isHost: true,
      connectionId,
      hasVoted: false,
      joinedAt: now,
    };
    const room: Room = {
      code,
      hostParticipantId: participant.id,
      currentTask: null,
      revealed: false,
      participants: new Map([[participant.id, participant]]),
      votes: new Map(),
      createdAt: now,
    };
    this.rooms.set(code, room);
    this.bySocket.set(connectionId, {
      roomCode: code,
      participantId: participant.id,
    });
    return ok({ room, participant });
  }

  joinRoom(
    connectionId: string,
    roomCode: string,
    displayName: string,
    participantId?: string,
    now: number = Date.now(),
  ): Result<{ room: Room; participant: Participant; reconnected: boolean }> {
    const code = normalizeCode(roomCode);
    const room = this.rooms.get(code);
    if (!room) {
      return err(
        "ROOM_NOT_FOUND",
        "that room does not exist (it may have expired)",
      );
    }

    // Reconnection: rebind the existing participant to the new socket, preserving
    // joinedAt (so host-transfer ordering stays stable) and host status.
    if (participantId) {
      const existing = room.participants.get(participantId);
      if (existing) {
        this.bySocket.delete(existing.connectionId);
        existing.connectionId = connectionId;
        existing.displayName = displayName;
        this.bySocket.set(connectionId, { roomCode: code, participantId });
        return ok({ room, participant: existing, reconnected: true });
      }
    }

    // Fresh join.
    if (room.participants.size >= LIMITS.maxParticipantsPerRoom) {
      return err("ROOM_FULL", "this room is full");
    }
    const participant: Participant = {
      id: randomUUID(),
      displayName,
      isHost: false,
      connectionId,
      hasVoted: false,
      joinedAt: now,
    };
    room.participants.set(participant.id, participant);
    this.bySocket.set(connectionId, {
      roomCode: code,
      participantId: participant.id,
    });
    return ok({ room, participant, reconnected: false });
  }

  /**
   * Remove the participant owning `connectionId`. Returns null when the socket is
   * unknown (e.g. its participant was already rebound to a newer socket on reconnect —
   * the stale `disconnect` is then a safe no-op).
   */
  leave(connectionId: string): LeaveResult | null {
    const entry = this.bySocket.get(connectionId);
    if (!entry) return null;
    this.bySocket.delete(connectionId);

    const room = this.rooms.get(entry.roomCode);
    if (!room) return null;

    const participant = room.participants.get(entry.participantId);
    // Guard: only the participant's CURRENT socket may remove it.
    if (!participant || participant.connectionId !== connectionId) return null;

    room.participants.delete(entry.participantId);
    room.votes.delete(entry.participantId);
    const wasHost = room.hostParticipantId === entry.participantId;

    if (room.participants.size === 0) {
      this.rooms.delete(room.code);
      return {
        roomCode: room.code,
        removedParticipantId: entry.participantId,
        roomDeleted: true,
        hostChanged: false,
        hostParticipantId: null,
      };
    }

    let hostChanged = false;
    if (wasHost) {
      const successor = this.oldestSurvivor(room);
      successor.isHost = true;
      room.hostParticipantId = successor.id;
      hostChanged = true;
    }

    return {
      roomCode: room.code,
      removedParticipantId: entry.participantId,
      roomDeleted: false,
      hostChanged,
      hostParticipantId: room.hostParticipantId,
    };
  }

  setTask(
    roomCode: string,
    participantId: string,
    description: string,
  ): Result<{ room: Room }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    if (room.hostParticipantId !== participantId) {
      return err("NOT_HOST", "only the host can set the task");
    }
    room.currentTask = { description };
    this.clearRound(room);
    return ok({ room });
  }

  castVote(
    roomCode: string,
    participantId: string,
    cardValue: CardValue,
  ): Result<{ room: Room }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    const participant = room.participants.get(participantId);
    if (!participant) return err("NOT_IN_ROOM", "you are not in this room");
    if (room.revealed) {
      return err(
        "ALREADY_REVEALED",
        "voting is closed — the round was already revealed",
      );
    }
    // Overwrite any prior vote (re-pick allowed).
    const vote: Vote = { participantId, cardValue, hidden: true };
    room.votes.set(participantId, vote);
    participant.hasVoted = true;
    return ok({ room });
  }

  reveal(
    roomCode: string,
    participantId: string,
  ): Result<{
    room: Room;
    votes: Vote[];
    stats: ReturnType<typeof computeVoteStats>;
  }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    if (room.hostParticipantId !== participantId) {
      return err("NOT_HOST", "only the host can reveal");
    }
    room.revealed = true;
    const votes: Vote[] = [];
    for (const vote of room.votes.values()) {
      vote.hidden = false;
      votes.push(vote);
    }
    return ok({ room, votes, stats: computeVoteStats(votes) });
  }

  reset(roomCode: string, participantId: string): Result<{ room: Room }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    if (room.hostParticipantId !== participantId) {
      return err("NOT_HOST", "only the host can reset the round");
    }
    this.clearRound(room); // KEEPS currentTask (re-estimate the same task).
    return ok({ room });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Clear all votes + reveal state and reset every participant's hasVoted flag. */
  private clearRound(room: Room): void {
    room.votes.clear();
    room.revealed = false;
    for (const participant of room.participants.values()) {
      participant.hasVoted = false;
    }
  }

  /** Deterministic host successor: the participant with the smallest joinedAt. */
  private oldestSurvivor(room: Room): Participant {
    let oldest: Participant | undefined;
    for (const participant of room.participants.values()) {
      if (!oldest || participant.joinedAt < oldest.joinedAt) {
        oldest = participant;
      }
    }
    // Safe: callers only invoke this when at least one participant remains.
    return oldest as Participant;
  }

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = this.randomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("could not allocate a unique room code");
  }

  private randomCode(): string {
    let code = "";
    for (let i = 0; i < LIMITS.roomCodeLength; i += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
  }
}

function normalizeCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}
