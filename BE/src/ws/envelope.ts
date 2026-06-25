import { clientEnvelopeSchema, type ParsedClientEnvelope } from "@pp/shared";

/** Cheap abuse guard (parity with socket.io `maxHttpBufferSize`): reject oversized frames. */
export const MAX_FRAME_BYTES = 100_000;

export type DecodeResult =
  | { ok: true; envelope: ParsedClientEnvelope }
  | { ok: false; reason: string };

/**
 * Decode + validate one inbound text frame into a typed client envelope. Validates the
 * FRAME only (kind/event/id); the inner `payload` stays `unknown` and is validated by the
 * per-event schema in the router. Never throws — malformed input returns `ok:false`.
 */
export function decodeClientFrame(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  const parsed = clientEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: "invalid envelope" };
  }
  return { ok: true, envelope: parsed.data };
}
