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

interface RoomStore {
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

export const store: RoomStore = $state({
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
});

// ---------------------------------------------------------------------------
// Derived helpers (functions so callers read live values inside their own
// reactive scope — these read $state and stay reactive at the call site).
// ---------------------------------------------------------------------------

/** True when the participant matching my id is flagged as host. */
export function isHost(): boolean {
  if (!store.myParticipantId) return false;
  return store.participants.some(
    (p) => p.id === store.myParticipantId && p.isHost,
  );
}

/** Number of participants who have voted (pre-reveal indicator). */
export function votedCount(): number {
  return store.participants.filter((p) => p.hasVoted).length;
}

/** Look up a revealed vote value for a participant, or null if none/not revealed. */
export function voteFor(participantId: string): CardValue | null {
  const v = store.votes.find((vote) => vote.participantId === participantId);
  return v ? v.cardValue : null;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export function setConnected(value: boolean): void {
  store.connected = value;
}

export function setMyParticipantId(id: string): void {
  store.myParticipantId = id;
}

export function setRoomCode(code: string): void {
  store.roomCode = code;
}

// ---------------------------------------------------------------------------
// Server payload appliers
// ---------------------------------------------------------------------------

export function applyRoomState(payload: RoomStatePayload): void {
  store.roomCode = payload.roomCode;
  store.participants = payload.participants;
  store.task = payload.task;
  store.revealed = payload.revealed;
  store.stats = payload.stats ?? null;
  if (!payload.revealed) {
    store.votes = [];
  }
}

export function applyPresence(payload: PresencePayload): void {
  store.participants = payload.participants;
}

export function applyTaskUpdated(payload: TaskUpdatedPayload): void {
  store.task = payload.task;
  // New task => clear local selection + any revealed state.
  store.myCard = null;
  store.revealed = false;
  store.votes = [];
  store.stats = null;
}

export function applyRevealed(payload: RevealedPayload): void {
  store.revealed = true;
  store.votes = payload.votes;
  store.stats = payload.stats;
}

export function applyRoundReset(): void {
  // Votes cleared, same task kept.
  store.revealed = false;
  store.votes = [];
  store.stats = null;
  store.myCard = null;
}

export function applyHostChanged(payload: HostChangedPayload): void {
  store.participants = store.participants.map((p) => ({
    ...p,
    isHost: p.id === payload.hostParticipantId,
  }));
}

// ---------------------------------------------------------------------------
// Local mutations / errors
// ---------------------------------------------------------------------------

export function setMyCard(value: CardValue | null): void {
  store.myCard = value;
}

export function setError(message: string | null): void {
  store.lastError = message;
}

/** Wipe everything back to a clean disconnected state. */
export function resetStore(): void {
  store.connected = false;
  store.roomCode = null;
  store.myParticipantId = null;
  store.participants = [];
  store.task = null;
  store.revealed = false;
  store.stats = null;
  store.votes = [];
  store.myCard = null;
  store.lastError = null;
}
