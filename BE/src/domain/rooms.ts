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
  /**
   * No one is left to notify: the room is either truly empty (its deletion scheduled for the
   * end of the grace window — the room object still exists for `roomGraceMs` so a refreshing
   * solo host can rejoin) or already gone. Either way the transport layer skips broadcasting.
   * Named for the broadcast contract, not literal object lifetime (the room may still exist).
   */
  roomGone: boolean;
  hostChanged: boolean;
  hostParticipantId: string | null;
}

/**
 * Timer surface the registry needs to defer empty-room deletion. Injected so tests can
 * drive it with fake timers and the domain never imports node globals. Matches the shape
 * of `setTimeout`/`clearTimeout` (the returned handle is opaque to the domain).
 */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Called when a grace timer actually fires and an empty room is deleted asynchronously, so
 * the transport layer can close any sockets the room left behind. Mirrors what `reapExpired`
 * returns synchronously — the domain hands back opaque connectionIds, never a socket
 * (ADR-001). For a solo-host refresh the survivor rejoined and cancelled the timer, so this
 * never fires; it only fires for rooms that were genuinely abandoned.
 */
export type OnRoomDeleted = (roomCode: string, connectionIds: string[]) => void;

const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
  /** Pending grace-deletion timers, keyed by room code. Present only while a room is empty. */
  private readonly pendingDeletes = new Map<string, unknown>();

  /**
   * @param scheduler   Timer surface for deferred empty-room deletion (default: node timers).
   * @param onRoomDeleted Notified when a grace timer fires and deletes an abandoned room, so
   *                      the transport can close its orphaned sockets. No-op by default.
   */
  constructor(
    private readonly scheduler: Scheduler = defaultScheduler,
    private readonly onRoomDeleted: OnRoomDeleted = () => {},
  ) {}

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
      lastActivityAt: now,
      parkedParticipantId: null,
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

    // Any (re)join rescues a room from a pending grace-deletion — the timer must not fire now
    // that someone is arriving. This is the solo-host refresh case and the brand-new-joiner
    // race. Whether the parked participant SURVIVES depends on who is arriving (below).
    this.cancelGraceDeletion(code);

    // Reconnection: rebind the existing participant to the new socket, preserving
    // joinedAt (so host-transfer ordering stays stable) and host status.
    if (participantId) {
      const existing = room.participants.get(participantId);
      if (existing) {
        // Rebinding the parked participant un-parks the room (the refresh round-trip).
        if (room.parkedParticipantId === participantId) {
          room.parkedParticipantId = null;
        }
        this.bySocket.delete(existing.connectionId);
        existing.connectionId = connectionId;
        existing.displayName = displayName;
        this.bySocket.set(connectionId, { roomCode: code, participantId });
        this.touch(room, now);
        return ok({ room, participant: existing, reconnected: true });
      }
    }

    // Fresh join (or a reconnect whose participantId no longer exists). If the room was
    // parked, the parked record is a ghost to THIS arriver — its owner didn't come back, a
    // different person did. Evict it (and its vote) so it never serializes into the roster,
    // and drop the dangling host pointer so the fresh joiner can be promoted below.
    this.evictParkedGhost(room);

    if (room.participants.size >= LIMITS.maxParticipantsPerRoom) {
      return err("ROOM_FULL", "this room is full");
    }
    const participant: Participant = {
      id: randomUUID(),
      displayName,
      // First real member of an otherwise-empty room inherits the host role — covers a
      // stranger arriving after the host abandoned a solo room within the grace window.
      isHost: room.participants.size === 0,
      connectionId,
      hasVoted: false,
      joinedAt: now,
    };
    room.participants.set(participant.id, participant);
    if (participant.isHost) room.hostParticipantId = participant.id;
    this.bySocket.set(connectionId, {
      roomCode: code,
      participantId: participant.id,
    });
    this.touch(room, now);
    return ok({ room, participant, reconnected: false });
  }

  /**
   * Remove the participant owning `connectionId`. Returns null when the socket is
   * unknown (e.g. its participant was already rebound to a newer socket on reconnect —
   * the stale `disconnect` is then a safe no-op).
   */
  leave(connectionId: string, now: number = Date.now()): LeaveResult | null {
    const entry = this.bySocket.get(connectionId);
    if (!entry) return null;
    this.bySocket.delete(connectionId);

    const room = this.rooms.get(entry.roomCode);
    if (!room) return null;

    const participant = room.participants.get(entry.participantId);
    // Guard: only the participant's CURRENT socket may remove it.
    if (!participant || participant.connectionId !== connectionId) return null;

    const wasHost = room.hostParticipantId === entry.participantId;

    // Last participant leaving: enter the grace window instead of tearing down. We KEEP the
    // participant record (and their votes) so a refresh's reconnect rebinds the same identity
    // — preserving host status, joinedAt, and any cast vote. Only `bySocket` was dropped above
    // (the dead socket), so the participant is parked: present in the room, but unreachable
    // until a new socket rebinds it. If no one rejoins, the grace timer deletes the whole room.
    if (room.participants.size === 1) {
      room.parkedParticipantId = entry.participantId;
      this.scheduleGraceDeletion(room.code);
      return {
        roomCode: room.code,
        removedParticipantId: entry.participantId,
        roomGone: true,
        hostChanged: false,
        hostParticipantId: null,
      };
    }

    // Not the last one — remove the leaver outright; the room lives on with the survivors.
    room.participants.delete(entry.participantId);
    room.votes.delete(entry.participantId);

    let hostChanged = false;
    if (wasHost) {
      const successor = this.oldestSurvivor(room);
      successor.isHost = true;
      room.hostParticipantId = successor.id;
      hostChanged = true;
    }

    // A departure is room activity: it keeps the surviving members' room from being
    // treated as idle purely because nobody has voted since the last person left.
    this.touch(room, now);
    return {
      roomCode: room.code,
      removedParticipantId: entry.participantId,
      roomGone: false,
      hostChanged,
      hostParticipantId: room.hostParticipantId,
    };
  }

  setTask(
    roomCode: string,
    participantId: string,
    description: string,
    now: number = Date.now(),
  ): Result<{ room: Room }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    if (room.hostParticipantId !== participantId) {
      return err("NOT_HOST", "only the host can set the task");
    }
    room.currentTask = { description };
    this.clearRound(room);
    this.touch(room, now);
    return ok({ room });
  }

  castVote(
    roomCode: string,
    participantId: string,
    cardValue: CardValue,
    now: number = Date.now(),
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
    this.touch(room, now);
    return ok({ room });
  }

  reveal(
    roomCode: string,
    participantId: string,
    now: number = Date.now(),
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
    this.touch(room, now);
    return ok({ room, votes, stats: computeVoteStats(votes) });
  }

  reset(
    roomCode: string,
    participantId: string,
    now: number = Date.now(),
  ): Result<{ room: Room }> {
    const room = this.rooms.get(normalizeCode(roomCode));
    if (!room) return err("ROOM_NOT_FOUND", "room not found");
    if (room.hostParticipantId !== participantId) {
      return err("NOT_HOST", "only the host can reset the round");
    }
    this.clearRound(room); // KEEPS currentTask (re-estimate the same task).
    this.touch(room, now);
    return ok({ room });
  }

  // -------------------------------------------------------------------------
  // Idle reaping (pure domain — socket-free, ADR-001)
  // -------------------------------------------------------------------------

  /**
   * Delete every room that is BOTH idle past `LIMITS.roomIdleTtlMs` AND has no live
   * connection left, mirroring `leave()`'s cleanup discipline (drop from `rooms`, purge
   * `bySocket`). Returns one entry per reaped room carrying its opaque connectionIds so the
   * transport layer can close any orphaned sockets — the domain never touches a socket.
   *
   * `isLive` is an injected predicate over opaque connectionIds (default: nothing is live).
   * It keeps the domain socket-free per ADR-001 — the domain asks "is this id still backed
   * by a connection?" without ever seeing a socket. A room with even one live participant is
   * spared: idleness means *no one is here*, not merely *no one pushed a button recently*.
   * A still-present but silent room therefore survives; only genuinely abandoned rooms (all
   * sockets gone) past the TTL are reaped.
   */
  reapExpired(
    now: number = Date.now(),
    isLive: (connectionId: string) => boolean = () => false,
  ): Array<{ roomCode: string; connectionIds: string[] }> {
    const reaped: Array<{ roomCode: string; connectionIds: string[] }> = [];
    for (const room of this.rooms.values()) {
      if (now - room.lastActivityAt <= LIMITS.roomIdleTtlMs) continue;
      const connectionIds = [...room.participants.values()].map(
        (p) => p.connectionId,
      );
      if (connectionIds.some(isLive)) continue; // someone is still present — spare it.
      this.cancelGraceDeletion(room.code); // never double-delete via timer + reaper.
      for (const cid of connectionIds) this.bySocket.delete(cid);
      this.rooms.delete(room.code);
      reaped.push({ roomCode: room.code, connectionIds });
    }
    return reaped;
  }

  /**
   * Cancel every pending grace-deletion timer. Called on graceful shutdown so short-lived
   * timers can't keep the process alive (the sockets are being closed anyway). Idempotent.
   */
  shutdown(): void {
    for (const handle of this.pendingDeletes.values()) {
      this.scheduler.clearTimeout(handle);
    }
    this.pendingDeletes.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Stamp the room's last-activity time; bumped by every activity-bearing mutation. */
  private touch(room: Room, now: number): void {
    room.lastActivityAt = now;
  }

  /**
   * Schedule deletion of a now-parked room `roomGraceMs` out, replacing any prior timer for
   * the same code. The room still holds its sole (socket-less) participant during the window
   * so a reconnect can rebind it. Any (re)join cancels this timer (see joinRoom/createRoom),
   * so if it fires at all no one came back: tear the room down. The parked participant's
   * connectionId is handed to `onRoomDeleted` so the transport can close that orphan socket
   * (already closed in the refresh case — the close is an idempotent no-op).
   */
  private scheduleGraceDeletion(code: string): void {
    this.cancelGraceDeletion(code);
    const handle = this.scheduler.setTimeout(() => {
      this.pendingDeletes.delete(code);
      const room = this.rooms.get(code);
      if (!room) return; // already gone (e.g. reaped) — nothing to do.
      const connectionIds = [...room.participants.values()].map(
        (p) => p.connectionId,
      );
      for (const cid of connectionIds) this.bySocket.delete(cid);
      this.rooms.delete(code);
      this.onRoomDeleted(code, connectionIds);
    }, LIMITS.roomGraceMs);
    this.pendingDeletes.set(code, handle);
  }

  /**
   * Evict a room's parked (grace-window) participant if it has one: the parked owner did not
   * return — a different person is joining — so the parked record is a ghost. Drop it and its
   * vote, and clear `parkedParticipantId`. The dangling `hostParticipantId` is left for the
   * caller to reassign (the fresh joiner becomes host of the now-empty room). No-op if the
   * room isn't parked.
   */
  private evictParkedGhost(room: Room): void {
    const ghostId = room.parkedParticipantId;
    if (ghostId === null) return;
    room.participants.delete(ghostId);
    room.votes.delete(ghostId);
    room.parkedParticipantId = null;
  }

  /** Cancel a pending grace-deletion for `code` (a rejoin rescued the room). */
  private cancelGraceDeletion(code: string): void {
    const handle = this.pendingDeletes.get(code);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.pendingDeletes.delete(code);
  }

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
