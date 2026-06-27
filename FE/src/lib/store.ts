import type {
  CardValue,
  HostChangedPayload,
  PresencePayload,
  PublicParticipant,
  RevealedPayload,
  RoomStatePayload,
  Task,
  TaskUpdatedPayload,
  Vote,
  VoteStats,
} from "@pp/shared";

export interface RoomStore {
  connected: boolean;
  roomCode: string | null;
  myParticipantId: string | null;
  participants: PublicParticipant[];
  task: Task | null;
  revealed: boolean;
  stats: VoteStats | null;
  /** Vote values, only populated by a `revealed` payload. */
  votes: Vote[];
  /** Local optimistic selection; cleared on task change / round reset. */
  myCard: CardValue | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// External store: module-level state + listener set, surfaced to React via
// useSyncExternalStore. Every mutation replaces the top-level `state` object
// (new reference) so React detects the change, then notifies listeners.
// ---------------------------------------------------------------------------

let state: RoomStore = {
  connected: false,
  roomCode: null,
  myParticipantId: null,
  participants: [],
  task: null,
  revealed: false,
  stats: null,
  votes: [],
  myCard: null,
  lastError: null,
};

const listeners = new Set<() => void>();

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current snapshot (stable reference until the next mutation). */
export function getSnapshot(): RoomStore {
  return state;
}

function notify(): void {
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Derived helpers (pure: take the snapshot as an argument so React components
// can call them with the value returned by useRoomStore()).
// ---------------------------------------------------------------------------

/** True when the participant matching my id is flagged as host. */
export function isHost(s: RoomStore): boolean {
  if (!s.myParticipantId) return false;
  return s.participants.some((p) => p.id === s.myParticipantId && p.isHost);
}

/** Number of participants who have voted (pre-reveal indicator). */
export function votedCount(s: RoomStore): number {
  return s.participants.filter((p) => p.hasVoted).length;
}

/** Look up a revealed vote value for a participant, or null if none/not revealed. */
export function voteFor(s: RoomStore, participantId: string): CardValue | null {
  const v = s.votes.find((vote) => vote.participantId === participantId);
  return v ? v.cardValue : null;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export function setConnected(value: boolean): void {
  state = { ...state, connected: value };
  notify();
}

export function setMyParticipantId(id: string): void {
  state = { ...state, myParticipantId: id };
  notify();
}

export function setRoomCode(code: string): void {
  state = { ...state, roomCode: code };
  notify();
}

// ---------------------------------------------------------------------------
// Server payload appliers
// ---------------------------------------------------------------------------

export function applyRoomState(payload: RoomStatePayload): void {
  state = {
    ...state,
    roomCode: payload.roomCode,
    participants: payload.participants,
    task: payload.task,
    revealed: payload.revealed,
    stats: payload.stats ?? null,
    votes: payload.revealed ? state.votes : [],
  };
  notify();
}

export function applyPresence(payload: PresencePayload): void {
  state = { ...state, participants: payload.participants };
  notify();
}

export function applyTaskUpdated(payload: TaskUpdatedPayload): void {
  // New task => clear local selection + any revealed state.
  state = {
    ...state,
    task: payload.task,
    myCard: null,
    revealed: false,
    votes: [],
    stats: null,
  };
  notify();
}

export function applyRevealed(payload: RevealedPayload): void {
  state = {
    ...state,
    revealed: true,
    votes: payload.votes,
    stats: payload.stats,
  };
  notify();
}

export function applyRoundReset(): void {
  // Votes cleared, same task kept.
  state = {
    ...state,
    revealed: false,
    votes: [],
    stats: null,
    myCard: null,
  };
  notify();
}

export function applyHostChanged(payload: HostChangedPayload): void {
  state = {
    ...state,
    participants: state.participants.map((p) => ({
      ...p,
      isHost: p.id === payload.hostParticipantId,
    })),
  };
  notify();
}

// ---------------------------------------------------------------------------
// Local mutations / errors
// ---------------------------------------------------------------------------

export function setMyCard(value: CardValue | null): void {
  state = { ...state, myCard: value };
  notify();
}

export function setError(message: string | null): void {
  state = { ...state, lastError: message };
  notify();
}

/** Wipe everything back to a clean disconnected state. */
export function resetStore(): void {
  state = {
    connected: false,
    roomCode: null,
    myParticipantId: null,
    participants: [],
    task: null,
    revealed: false,
    stats: null,
    votes: [],
    myCard: null,
    lastError: null,
  };
  notify();
}
