import { z } from "zod";
import { DECK, type CardValue } from "./deck";

/** Client -> Server event names. */
export const C2S = {
  createRoom: "createRoom",
  joinRoom: "joinRoom",
  setTask: "setTask",
  castVote: "castVote",
  reveal: "reveal",
  reset: "reset",
} as const;

/** Server -> Client event names. */
export const S2C = {
  /** Join/reconnect snapshot. Delivered on the joinRoom ack, not broadcast. */
  roomState: "roomState",
  presence: "presence",
  taskUpdated: "taskUpdated",
  revealed: "revealed",
  roundReset: "roundReset",
  hostChanged: "hostChanged",
  errorEvent: "errorEvent",
} as const;

/** Cheap abuse guards (spec line 41) — sane shape/size limits, not full rate-limiting. */
export const LIMITS = {
  displayNameMax: 40,
  taskDescriptionMax: 200,
  roomCodeLength: 6,
  maxRooms: 50,
  maxParticipantsPerRoom: 30,
  /**
   * Idle TTL: a room with no activity for this long is reaped (30 min).
   * Reaping is granular to the sweep interval (`SWEEP_INTERVAL_MS` = 60 s), so the
   * effective maximum lifetime is `roomIdleTtlMs + SWEEP_INTERVAL_MS` (~31 min).
   */
  roomIdleTtlMs: 30 * 60_000,
  /**
   * Grace window before an emptied room is deleted (10 s). Bridges the gap between the
   * last socket closing and a refresh's new socket rejoining: a solo host who refreshes
   * drops to zero participants for a few hundred ms, so deleting on-empty would lose their
   * room. Instead `leave()` schedules deletion this far out, and any (re)join inside the
   * window cancels it — the room (and its host/votes) survives the round-trip.
   */
  roomGraceMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// zod schemas (zod 4). Inbound messages are validated with `safeParse` on BE.
// ---------------------------------------------------------------------------

/**
 * Exact deck membership: a union of one literal per DECK entry, so only the real cards
 * (`0,1,2,3,5,8,13,21,?,☕`) validate. The cast is load-bearing: `DECK.map(z.literal)`
 * yields a `ZodLiteral[]`, but `z.union` wants a non-empty tuple `[A, B, ...rest]` — DECK
 * is a non-empty `as const` tuple, so the shape is sound. Revisit if DECK could ever empty.
 */
export const cardValueSchema: z.ZodType<CardValue> = z.union(
  DECK.map((value) => z.literal(value)) as unknown as readonly [
    z.ZodLiteral<CardValue>,
    z.ZodLiteral<CardValue>,
    ...z.ZodLiteral<CardValue>[],
  ],
);

const displayName = z.string().trim().min(1).max(LIMITS.displayNameMax);
const roomCode = z.string().trim().length(LIMITS.roomCodeLength);

export const createRoomSchema = z.object({
  displayName,
});

export const joinRoomSchema = z.object({
  roomCode,
  displayName,
  participantId: z.string().min(1).max(64).optional(),
});

export const setTaskSchema = z.object({
  roomCode,
  description: z.string().trim().min(1).max(LIMITS.taskDescriptionMax),
});

export const castVoteSchema = z.object({
  roomCode,
  cardValue: cardValueSchema,
});

export const revealSchema = z.object({ roomCode });
export const resetSchema = z.object({ roomCode });

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type SetTaskInput = z.infer<typeof setTaskSchema>;
export type CastVoteInput = z.infer<typeof castVoteSchema>;
export type RevealInput = z.infer<typeof revealSchema>;
export type ResetInput = z.infer<typeof resetSchema>;
