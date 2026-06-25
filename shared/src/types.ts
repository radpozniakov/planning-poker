import type { CardValue } from "./deck";

/** The single task currently being estimated in a room. */
export interface Task {
  description: string;
}

/** A participant's vote. `hidden` mirrors pre-reveal state; values cross the wire only inside `revealed`. */
export interface Vote {
  participantId: string;
  cardValue: CardValue;
  hidden: boolean;
}

/**
 * INTERNAL participant model — held only in BE process memory.
 * NEVER serialized to clients (it carries `connectionId`). See `PublicParticipant`.
 */
export interface Participant {
  id: string;
  displayName: string;
  isHost: boolean;
  connectionId: string;
  hasVoted: boolean;
  /** epoch ms; drives deterministic host-transfer ("oldest survivor"). Preserved across reconnects. */
  joinedAt: number;
}

/**
 * PUBLIC WIRE DTO — the ONLY participant shape that crosses the wire.
 * No `connectionId`, no `cardValue`. Built by mapping `Participant` -> this.
 */
export interface PublicParticipant {
  id: string;
  displayName: string;
  isHost: boolean;
  hasVoted: boolean;
}

/** Computed only from numeric cards; nulls when no numeric votes exist. */
export interface VoteStats {
  min: number | null;
  max: number | null;
  average: number | null;
  allAgree: boolean;
  numericCount: number;
}

/** INTERNAL room model — lives in BE memory, lost on restart by design. */
export interface Room {
  code: string;
  hostParticipantId: string;
  currentTask: Task | null;
  revealed: boolean;
  participants: Map<string, Participant>;
  votes: Map<string, Vote>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Server -> Client payloads (all participant lists are PublicParticipant[])
// ---------------------------------------------------------------------------

export interface RoomStatePayload {
  roomCode: string;
  participants: PublicParticipant[];
  task: Task | null;
  revealed: boolean;
  /** Present only when `revealed === true`. */
  stats?: VoteStats;
}

export interface PresencePayload {
  participants: PublicParticipant[];
}

export interface TaskUpdatedPayload {
  task: Task | null;
}

export interface RevealedPayload {
  votes: Vote[];
  stats: VoteStats;
}

export type RoundResetPayload = Record<string, never>;

export interface HostChangedPayload {
  hostParticipantId: string;
}

export interface ErrorEventPayload {
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "VALIDATION"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "TOO_MANY_ROOMS"
  | "NOT_HOST"
  | "ALREADY_REVEALED"
  | "NOT_IN_ROOM";

// ---------------------------------------------------------------------------
// Client -> Server acknowledgement payloads
// ---------------------------------------------------------------------------

export interface CreateRoomAck {
  ok: true;
  roomCode: string;
  participantId: string;
  isHost: true;
}

export interface JoinRoomAck {
  ok: true;
  participantId: string;
  state: RoomStatePayload;
}

export interface ErrorAck {
  ok: false;
  error: ErrorEventPayload;
}

export type CreateRoomResult = CreateRoomAck | ErrorAck;
export type JoinRoomResult = JoinRoomAck | ErrorAck;
