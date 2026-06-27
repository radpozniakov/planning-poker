/** Reconnection triple persisted to localStorage so a refresh rejoins silently. */
export interface StoredSession {
  participantId: string;
  displayName: string;
  roomCode: string;
}

const STORAGE_KEY = "pp.session";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/** Persist the reconnection triple. */
export function saveSession(session: StoredSession): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage may be unavailable (private mode / quota) — fail silently.
  }
}

/**
 * Load the stored session. When `roomCode` is provided, the stored session is
 * returned only if it matches that room (otherwise null), so stale sessions for
 * a different room don't leak a name/participantId into the wrong room.
 */
export function loadSession(roomCode?: string): StoredSession | null {
  if (!canUseStorage()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.participantId !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.roomCode !== "string"
    ) {
      return null;
    }
    const session: StoredSession = {
      participantId: parsed.participantId,
      displayName: parsed.displayName,
      roomCode: parsed.roomCode,
    };
    if (roomCode && session.roomCode !== roomCode) return null;
    return session;
  } catch {
    return null;
  }
}

/** Drop the stored session entirely. */
export function clearSession(): void {
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
