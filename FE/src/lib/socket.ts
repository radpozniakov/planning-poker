import { io, type Socket } from "socket.io-client";
import { browser } from "$app/environment";
import {
  C2S,
  S2C,
  type CardValue,
  type CreateRoomResult,
  type JoinRoomResult,
} from "@pp/shared";

/** In dev the BE runs on :3000; in prod we are same-origin behind Caddy. */
const SERVER_URL = import.meta.env.DEV ? "http://localhost:3000" : undefined;

let socket: Socket | null = null;

/** Lazily create (but do not connect) the singleton socket. Browser-only. */
function getSocket(): Socket | null {
  if (!browser) return null;
  if (!socket) {
    socket = io(SERVER_URL, { autoConnect: false });
  }
  return socket;
}

/** Ensure the singleton socket exists and is connecting/connected. */
export function connectSocket(): Socket | null {
  const s = getSocket();
  if (s && !s.connected) {
    s.connect();
  }
  return s;
}

export function disconnectSocket(): void {
  if (socket && socket.connected) {
    socket.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Client -> Server helpers
// ---------------------------------------------------------------------------

export async function createRoom(
  displayName: string,
): Promise<CreateRoomResult> {
  const s = connectSocket();
  if (!s) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Socket unavailable." },
    };
  }
  return s.emitWithAck(C2S.createRoom, { displayName });
}

export interface JoinRoomInput {
  roomCode: string;
  displayName: string;
  participantId?: string;
}

export async function joinRoom(
  input: JoinRoomInput,
): Promise<JoinRoomResult> {
  const s = connectSocket();
  if (!s) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Socket unavailable." },
    };
  }
  return s.emitWithAck(C2S.joinRoom, input);
}

export function setTask(roomCode: string, description: string): void {
  getSocket()?.emit(C2S.setTask, { roomCode, description });
}

export function castVote(roomCode: string, cardValue: CardValue): void {
  getSocket()?.emit(C2S.castVote, { roomCode, cardValue });
}

export function reveal(roomCode: string): void {
  getSocket()?.emit(C2S.reveal, { roomCode });
}

export function reset(roomCode: string): void {
  getSocket()?.emit(C2S.reset, { roomCode });
}

// ---------------------------------------------------------------------------
// Server -> Client listener registration
// ---------------------------------------------------------------------------

export type ServerEvent = (typeof S2C)[keyof typeof S2C];

/** Register a single S2C listener. Returns an unsubscribe function. */
export function onServerEvent(
  event: ServerEvent,
  handler: (payload: unknown) => void,
): () => void {
  const s = getSocket();
  if (!s) return () => {};
  s.on(event, handler as (...args: unknown[]) => void);
  return () => {
    s.off(event, handler as (...args: unknown[]) => void);
  };
}

/** Map of S2C event name -> handler, for bulk registration in a page. */
export type ServerHandlers = Partial<Record<ServerEvent, (payload: never) => void>>;

/**
 * Register many S2C listeners at once and return a single cleanup that removes
 * exactly the handlers registered here. Also handles connection lifecycle hooks
 * passed via `onConnect` / `onDisconnect`.
 */
export function registerServerHandlers(
  handlers: ServerHandlers,
  lifecycle?: { onConnect?: () => void; onDisconnect?: () => void },
): () => void {
  const s = getSocket();
  if (!s) return () => {};

  const offs: Array<() => void> = [];

  for (const [event, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    const fn = handler as (...args: unknown[]) => void;
    s.on(event, fn);
    offs.push(() => s.off(event, fn));
  }

  if (lifecycle?.onConnect) {
    const fn = lifecycle.onConnect;
    s.on("connect", fn);
    offs.push(() => s.off("connect", fn));
  }
  if (lifecycle?.onDisconnect) {
    const fn = lifecycle.onDisconnect;
    s.on("disconnect", fn);
    offs.push(() => s.off("disconnect", fn));
  }

  return () => {
    for (const off of offs) off();
  };
}
