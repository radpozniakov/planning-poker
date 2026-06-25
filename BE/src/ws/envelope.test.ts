import { describe, expect, it } from "vitest";
import { C2S, ENVELOPE_KIND } from "@pp/shared";
import { decodeClientFrame, MAX_FRAME_BYTES } from "./envelope";

describe("decodeClientFrame", () => {
  it("accepts a valid request carrying a correlation id", () => {
    const raw = JSON.stringify({
      kind: ENVELOPE_KIND.request,
      event: C2S.createRoom,
      payload: { displayName: "Alex" },
      id: "abc",
    });
    const result = decodeClientFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.event).toBe(C2S.createRoom);
      expect(result.envelope.id).toBe("abc");
    }
  });

  it("accepts a valid fire-and-forget request with no id", () => {
    const raw = JSON.stringify({
      kind: ENVELOPE_KIND.request,
      event: C2S.castVote,
      payload: { roomCode: "ABCDEF", cardValue: 5 },
    });
    const result = decodeClientFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.id).toBeUndefined();
  });

  it("rejects invalid JSON", () => {
    expect(decodeClientFrame("{ not json").ok).toBe(false);
  });

  it("rejects an unknown event name", () => {
    const raw = JSON.stringify({ kind: ENVELOPE_KIND.request, event: "bogus", payload: {} });
    expect(decodeClientFrame(raw).ok).toBe(false);
  });

  it("rejects the wrong envelope kind", () => {
    const raw = JSON.stringify({ kind: ENVELOPE_KIND.event, event: C2S.reveal, payload: {} });
    expect(decodeClientFrame(raw).ok).toBe(false);
  });

  it("rejects an oversized correlation id", () => {
    const raw = JSON.stringify({
      kind: ENVELOPE_KIND.request,
      event: C2S.reveal,
      payload: {},
      id: "x".repeat(65),
    });
    expect(decodeClientFrame(raw).ok).toBe(false);
  });

  it("exposes the frame-size guard at 100KB (socket.io parity)", () => {
    expect(MAX_FRAME_BYTES).toBe(100_000);
  });
});
