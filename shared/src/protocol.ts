import { z } from "zod";
import { C2S, S2C } from "./events";
import type { ErrorEventPayload } from "./types";

/**
 * Wire envelope for the native-WebSocket transport (replaces socket.io's implicit
 * event/ack framing). Every WS frame is JSON of one of the shapes below. The transport
 * is the ONLY thing that knows about envelopes — handlers/domain still speak the
 * `@pp/shared` event + payload contract (C2S/S2C + the per-event payload types).
 */
export const ENVELOPE_KIND = {
  /** client -> server. Carries an `id` only when the client awaits an ack (create/join). */
  request: "req",
  /** server -> client. Broadcast/push of an S2C event. No correlation. */
  event: "evt",
  /** server -> client. Reply to a correlated `req`, matched by `id`. */
  ack: "ack",
} as const;

export type EnvelopeKind = (typeof ENVELOPE_KIND)[keyof typeof ENVELOPE_KIND];

type C2SEvent = (typeof C2S)[keyof typeof C2S];
type S2CEvent = (typeof S2C)[keyof typeof S2C];

/** Client -> Server. `id` present only for the ack'd requests (createRoom/joinRoom). */
export interface ClientEnvelope {
  kind: typeof ENVELOPE_KIND.request;
  event: C2SEvent;
  payload: unknown;
  id?: string;
}

/** Server -> Client broadcast/push. No correlation id. */
export interface ServerEventEnvelope {
  kind: typeof ENVELOPE_KIND.event;
  event: S2CEvent;
  payload: unknown;
}

/** Server -> Client reply to a correlated request, matched by `id`. */
export type ServerAckEnvelope =
  | { kind: typeof ENVELOPE_KIND.ack; id: string; ok: true; payload: unknown }
  | {
      kind: typeof ENVELOPE_KIND.ack;
      id: string;
      ok: false;
      error: ErrorEventPayload;
    };

export type ServerEnvelope = ServerEventEnvelope | ServerAckEnvelope;

/**
 * zod schema for the INBOUND (client) envelope — the only untrusted frame the server
 * parses. It validates the FRAME only (kind/event/id); the inner `payload` stays
 * `unknown` and is validated by the existing per-event schema in the router.
 */
export const clientEnvelopeSchema = z.object({
  kind: z.literal(ENVELOPE_KIND.request),
  event: z.enum([
    C2S.createRoom,
    C2S.joinRoom,
    C2S.setTask,
    C2S.castVote,
    C2S.reveal,
    C2S.reset,
  ]),
  payload: z.unknown(),
  id: z.string().min(1).max(64).optional(),
});

export type ParsedClientEnvelope = z.infer<typeof clientEnvelopeSchema>;
