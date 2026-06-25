import { browser } from "$app/environment";
import {
  C2S,
  ENVELOPE_KIND,
  S2C,
  type CardValue,
  type CreateRoomResult,
  type JoinRoomResult,
  type ClientEnvelope,
  type ServerEnvelope,
} from "@pp/shared";

/**
 * Native-WebSocket transport (replaces socket.io-client). The ONLY transport-aware file
 * on the FE: it hand-rolls the three things socket.io gave for free — request/response
 * acks (correlation-id promise map), auto-reconnect with backoff, and outbound buffering
 * before the socket is open. Everything else (store/components/pages) speaks the
 * `@pp/shared` event contract via the unchanged exports below.
 */

/** In dev the BE runs on :3000; in prod we are same-origin. Computed lazily (browser-only). */
function wsUrl(): string {
  if (import.meta.env.DEV) return "ws://localhost:3000/ws";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

const ACK_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

interface PendingAck {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Armed on actual send (not on enqueue) so buffering during a reconnect doesn't burn it. */
  timer?: ReturnType<typeof setTimeout>;
}

let ws: WebSocket | null = null;
let connected = false;
let intentionalClose = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const pending = new Map<string, PendingAck>();
/** Frames buffered while the socket isn't OPEN, flushed on open. Bounded to survive outages. */
const MAX_OUTBOX = 64;
const outbox: Array<{ id?: string; data: string }> = [];
const eventListeners = new Map<ServerEvent, Set<(payload: unknown) => void>>();
const connectHooks = new Set<() => void>();
const disconnectHooks = new Set<() => void>();

/** Stable handle whose `.connected` getter the room page reads synchronously. */
const handle = {
  get connected(): boolean {
    return connected;
  },
};
export type SocketHandle = typeof handle;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function open(): void {
  intentionalClose = false;
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    connected = true;
    reconnectAttempts = 0;
    flushOutbox();
    for (const hook of connectHooks) hook();
  });

  ws.addEventListener("message", (event: MessageEvent) => handleMessage(event.data));

  ws.addEventListener("close", () => {
    connected = false;
    for (const hook of disconnectHooks) hook();
    rejectAllPending(new Error("socket closed"));
    // Nothing in the outbox was delivered (the socket closed before/without flushing).
    // Drop it: replaying stale frames (old votes, an abandoned create) on the next
    // connection is wrong — the room page re-joins fresh on reconnect.
    outbox.length = 0;
    if (!intentionalClose) scheduleReconnect();
  });

  // `error` is always followed by `close`; cleanup happens there.
  ws.addEventListener("error", () => {});
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

/** Lazily create + start connecting the singleton socket. Returns a handle, or null on SSR. */
export function connectSocket(): SocketHandle | null {
  if (!browser) return null;
  if (!ws || ws.readyState === WebSocket.CLOSED) open();
  return handle;
}

export function disconnectSocket(): void {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// Send path
// ---------------------------------------------------------------------------

/** Encode + send (or buffer until open) one client request frame. */
function send(event: ClientEnvelope["event"], payload: unknown, id?: string): void {
  const envelope: ClientEnvelope = { kind: ENVELOPE_KIND.request, event, payload };
  if (id) envelope.id = id;
  const data = JSON.stringify(envelope);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    if (id) armAckTimer(id);
    return;
  }
  // Buffer until the socket opens (socket.io did this transparently). Bound the buffer so
  // a prolonged outage can't grow it without limit; drop the oldest frame when full.
  if (outbox.length >= MAX_OUTBOX) outbox.shift();
  outbox.push({ id, data });
}

function flushOutbox(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const entry of outbox) {
    ws.send(entry.data);
    if (entry.id) armAckTimer(entry.id);
  }
  outbox.length = 0;
}

/**
 * Start the ack-timeout clock when the frame is actually sent — never while it sits in the
 * outbox. This makes the 10s budget measure the server round-trip rather than round-trip
 * plus reconnect backoff, so a buffered request can't time out before it is even delivered.
 * A request that is never sent (socket never opens) is settled by `rejectAllPending` on close.
 */
function armAckTimer(id: string): void {
  const entry = pending.get(id);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => {
    pending.delete(id);
    entry.reject(new Error("request timed out"));
  }, ACK_TIMEOUT_MS);
}

/** Send a correlated request and resolve with the matching ack payload (the Result object). */
function request<T>(event: ClientEnvelope["event"], payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send(event, payload, id);
  });
}

function rejectAllPending(reason: unknown): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

// ---------------------------------------------------------------------------
// Receive path
// ---------------------------------------------------------------------------

function handleMessage(data: unknown): void {
  if (typeof data !== "string") return;
  let envelope: ServerEnvelope;
  try {
    envelope = JSON.parse(data) as ServerEnvelope;
  } catch {
    return;
  }
  if (!envelope || typeof envelope !== "object") return;

  if (envelope.kind === ENVELOPE_KIND.ack) {
    const entry = pending.get(envelope.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(envelope.id);
    // Success carries the full Result object; failure is reshaped into the ErrorAck union.
    entry.resolve(envelope.ok ? envelope.payload : { ok: false, error: envelope.error });
    return;
  }

  if (envelope.kind === ENVELOPE_KIND.event) {
    const listeners = eventListeners.get(envelope.event);
    if (listeners) {
      for (const fn of listeners) fn(envelope.payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Client -> Server helpers
// ---------------------------------------------------------------------------

export async function createRoom(displayName: string): Promise<CreateRoomResult> {
  const s = connectSocket();
  if (!s) {
    return { ok: false, error: { code: "VALIDATION", message: "Socket unavailable." } };
  }
  return request<CreateRoomResult>(C2S.createRoom, { displayName });
}

export interface JoinRoomInput {
  roomCode: string;
  displayName: string;
  participantId?: string;
}

export async function joinRoom(input: JoinRoomInput): Promise<JoinRoomResult> {
  const s = connectSocket();
  if (!s) {
    return { ok: false, error: { code: "VALIDATION", message: "Socket unavailable." } };
  }
  return request<JoinRoomResult>(C2S.joinRoom, input);
}

export function setTask(roomCode: string, description: string): void {
  send(C2S.setTask, { roomCode, description });
}

export function castVote(roomCode: string, cardValue: CardValue): void {
  send(C2S.castVote, { roomCode, cardValue });
}

export function reveal(roomCode: string): void {
  send(C2S.reveal, { roomCode });
}

export function reset(roomCode: string): void {
  send(C2S.reset, { roomCode });
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
  let set = eventListeners.get(event);
  if (!set) {
    set = new Set();
    eventListeners.set(event, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

/** Map of S2C event name -> handler, for bulk registration in a page. */
export type ServerHandlers = Partial<Record<ServerEvent, (payload: never) => void>>;

/**
 * Register many S2C listeners at once plus connection lifecycle hooks, returning a single
 * cleanup that removes exactly what was registered here. `onConnect` fires on every
 * (re)connect — NOT on registration — so a transient socket drop silently re-joins; this
 * mirrors socket.io's `connect` event and is what the room page relies on for rebind.
 */
export function registerServerHandlers(
  handlers: ServerHandlers,
  lifecycle?: { onConnect?: () => void; onDisconnect?: () => void },
): () => void {
  if (!browser) return () => {};

  const offs: Array<() => void> = [];

  for (const [event, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    offs.push(onServerEvent(event as ServerEvent, handler as (payload: unknown) => void));
  }

  if (lifecycle?.onConnect) {
    const fn = lifecycle.onConnect;
    connectHooks.add(fn);
    offs.push(() => connectHooks.delete(fn));
  }
  if (lifecycle?.onDisconnect) {
    const fn = lifecycle.onDisconnect;
    disconnectHooks.add(fn);
    offs.push(() => disconnectHooks.delete(fn));
  }

  return () => {
    for (const off of offs) off();
  };
}
