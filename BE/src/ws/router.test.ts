import { describe, expect, it } from "vitest";
import { C2S, ENVELOPE_KIND, S2C, type ParsedClientEnvelope } from "@pp/shared";
import { RoomRegistry } from "../domain/rooms";
import type { Logger } from "../lib/logger";
import { ConnectionRegistry, type Sendable } from "./connection-registry";
import { dispatch, handleDisconnect } from "./router";

// ---------------------------------------------------------------------------
// Recording logger fake (shared by logging-specific test blocks)
// ---------------------------------------------------------------------------

interface LogCall {
  level: "info" | "warn" | "error" | "fatal";
  obj?: Record<string, unknown>;
  msg: string;
}

function makeRecordingLogger(calls: LogCall[] = []): Logger {
  const makeLevel =
    (level: LogCall["level"]) =>
    (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === "string") {
        calls.push({ level, msg: objOrMsg });
      } else {
        calls.push({ level, obj: objOrMsg, msg: msg ?? "" });
      }
    };
  const log: Logger = {
    info: makeLevel("info") as Logger["info"],
    warn: makeLevel("warn") as Logger["warn"],
    error: makeLevel("error") as Logger["error"],
    fatal: makeLevel("fatal") as Logger["fatal"],
    child(bindings: Record<string, unknown>): Logger {
      const childCalls = calls;
      const childLog: Logger = {
        info: ((objOrMsg: Record<string, unknown> | string, msg?: string) => {
          if (typeof objOrMsg === "string") {
            childCalls.push({ level: "info", obj: bindings, msg: objOrMsg });
          } else {
            childCalls.push({
              level: "info",
              obj: { ...bindings, ...objOrMsg },
              msg: msg ?? "",
            });
          }
        }) as Logger["info"],
        warn: ((objOrMsg: Record<string, unknown> | string, msg?: string) => {
          if (typeof objOrMsg === "string") {
            childCalls.push({ level: "warn", obj: bindings, msg: objOrMsg });
          } else {
            childCalls.push({
              level: "warn",
              obj: { ...bindings, ...objOrMsg },
              msg: msg ?? "",
            });
          }
        }) as Logger["warn"],
        error: ((objOrMsg: Record<string, unknown> | string, msg?: string) => {
          if (typeof objOrMsg === "string") {
            childCalls.push({ level: "error", obj: bindings, msg: objOrMsg });
          } else {
            childCalls.push({
              level: "error",
              obj: { ...bindings, ...objOrMsg },
              msg: msg ?? "",
            });
          }
        }) as Logger["error"],
        fatal: ((objOrMsg: Record<string, unknown> | string, msg?: string) => {
          if (typeof objOrMsg === "string") {
            childCalls.push({ level: "fatal", obj: bindings, msg: objOrMsg });
          } else {
            childCalls.push({
              level: "fatal",
              obj: { ...bindings, ...objOrMsg },
              msg: msg ?? "",
            });
          }
        }) as Logger["fatal"],
        child(more: Record<string, unknown>): Logger {
          return makeRecordingLogger(childCalls).child({
            ...bindings,
            ...more,
          });
        },
      };
      return childLog;
    },
  };
  return log;
}

/** Fake socket that records the parsed envelopes sent to it. */
function fakeSocket(): Sendable & { sent: any[] } {
  return {
    sent: [],
    readyState: 1,
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
    close() {},
  };
}

function req(
  event: string,
  payload: unknown,
  id?: string,
): ParsedClientEnvelope {
  return {
    kind: ENVELOPE_KIND.request,
    event,
    payload,
    ...(id ? { id } : {}),
  } as ParsedClientEnvelope;
}

/** Create a room and return the host's connectionId + room code. */
function createRoom(
  rooms: RoomRegistry,
  conns: ConnectionRegistry,
  ws: Sendable & { sent: any[] },
) {
  const id = conns.register(ws);
  dispatch(
    id,
    req(C2S.createRoom, { displayName: "Host" }, "create"),
    rooms,
    conns,
  );
  const code: string = ws.sent[0].payload.roomCode;
  return { id, code };
}

describe("router dispatch", () => {
  it("createRoom success replies on the ack channel", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    dispatch(
      id,
      req(C2S.createRoom, { displayName: "Host" }, "c1"),
      rooms,
      conns,
    );
    const ack = ws.sent.find((m) => m.kind === ENVELOPE_KIND.ack);
    expect(ack).toMatchObject({ id: "c1", ok: true });
    expect(ack.payload).toMatchObject({ ok: true, isHost: true });
    expect(ack.payload.roomCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("createRoom validation error replies via ack (not an errorEvent)", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    dispatch(id, req(C2S.createRoom, { displayName: "" }, "c1"), rooms, conns);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      kind: ENVELOPE_KIND.ack,
      id: "c1",
      ok: false,
    });
    expect(ws.sent[0].error.code).toBe("VALIDATION");
  });

  it("joinRoom for an unknown room replies via ack error", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    dispatch(
      id,
      req(C2S.joinRoom, { roomCode: "ZZZZZZ", displayName: "X" }, "j1"),
      rooms,
      conns,
    );
    expect(ws.sent[0]).toMatchObject({
      kind: ENVELOPE_KIND.ack,
      id: "j1",
      ok: false,
    });
    expect(ws.sent[0].error.code).toBe("ROOM_NOT_FOUND");
  });

  it("setTask before joining pushes a NOT_IN_ROOM errorEvent with no ack", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    dispatch(
      id,
      req(C2S.setTask, { roomCode: "ABCDEF", description: "x" }),
      rooms,
      conns,
    );
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      kind: ENVELOPE_KIND.event,
      event: S2C.errorEvent,
    });
    expect(ws.sent[0].payload.code).toBe("NOT_IN_ROOM");
  });

  it("castVote with an invalid card pushes a VALIDATION errorEvent (no ack)", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    ws.sent.length = 0;
    dispatch(
      id,
      req(C2S.castVote, { roomCode: code, cardValue: 999 }),
      rooms,
      conns,
    );
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      kind: ENVELOPE_KIND.event,
      event: S2C.errorEvent,
    });
    expect(ws.sent[0].payload.code).toBe("VALIDATION");
  });

  it("a non-host setTask is rejected with a NOT_HOST errorEvent", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const hostWs = fakeSocket();
    const guestWs = fakeSocket();
    const { code } = createRoom(rooms, conns, hostWs);
    const guestId = conns.register(guestWs);
    dispatch(
      guestId,
      req(C2S.joinRoom, { roomCode: code, displayName: "Guest" }, "j1"),
      rooms,
      conns,
    );
    guestWs.sent.length = 0;
    dispatch(
      guestId,
      req(C2S.setTask, { roomCode: code, description: "x" }),
      rooms,
      conns,
    );
    expect(guestWs.sent[0]).toMatchObject({
      kind: ENVELOPE_KIND.event,
      event: S2C.errorEvent,
    });
    expect(guestWs.sent[0].payload.code).toBe("NOT_HOST");
  });

  it("unknown event warns 'unknown event' with connectionId + event name", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    const log = makeRecordingLogger(calls);
    dispatch(
      id,
      req("bogusEvent", {}) as ParsedClientEnvelope,
      rooms,
      conns,
      log,
    );
    const warn = calls.find((c) => c.msg === "unknown event");
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.obj).toMatchObject({ connectionId: id, event: "bogusEvent" });
  });

  it("a host disconnect broadcasts hostChanged + presence to the survivors", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const hostWs = fakeSocket();
    const guestWs = fakeSocket();
    const { id: hostId, code } = createRoom(rooms, conns, hostWs);
    const guestId = conns.register(guestWs);
    dispatch(
      guestId,
      req(C2S.joinRoom, { roomCode: code, displayName: "Guest" }, "j1"),
      rooms,
      conns,
    );
    const guestParticipantId: string = guestWs.sent.find((m) => m.id === "j1")
      .payload.participantId;
    guestWs.sent.length = 0;

    handleDisconnect(hostId, rooms, conns);

    const events = guestWs.sent.map((m) => m.event);
    expect(events).toContain(S2C.hostChanged);
    expect(events).toContain(S2C.presence);
    const hostChanged = guestWs.sent.find((m) => m.event === S2C.hostChanged);
    expect(hostChanged.payload.hostParticipantId).toBe(guestParticipantId);
  });
});

// ---------------------------------------------------------------------------
// AC-6: per-handler success info logs + castVote privacy invariant
// ---------------------------------------------------------------------------

describe("router logging — AC-6 success paths", () => {
  it("createRoom logs 'room created' with roomCode + participantId", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.createRoom, { displayName: "Host" }, "c1"),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "room created");
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({
      roomCode: expect.any(String),
      participantId: expect.any(String),
    });
  });

  it("joinRoom logs 'room joined' with reconnected flag", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const hostWs = fakeSocket();
    const { code } = createRoom(rooms, conns, hostWs);
    const guestWs = fakeSocket();
    const guestId = conns.register(guestWs);
    const calls: LogCall[] = [];
    dispatch(
      guestId,
      req(C2S.joinRoom, { roomCode: code, displayName: "Guest" }, "j1"),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "room joined");
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({
      roomCode: code,
      participantId: expect.any(String),
      reconnected: false,
    });
  });

  it("castVote log payload keys are EXACTLY {participantId} — no cardValue under any name", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.castVote, { roomCode: code, cardValue: 5 }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "vote recorded");
    expect(entry).toBeDefined();
    // Must have participantId
    expect(entry?.obj).toMatchObject({ participantId: expect.any(String) });
    // Must NOT have cardValue or any value-like key
    const objKeys = Object.keys(entry?.obj ?? {});
    expect(objKeys).not.toContain("cardValue");
    expect(objKeys).not.toContain("value");
    expect(objKeys).not.toContain("card");
    // The only payload key beyond correlation ids must be participantId
    const payloadKeys = objKeys.filter(
      (k) => !["connectionId", "roomCode", "participantId"].includes(k),
    );
    expect(payloadKeys).toHaveLength(0);
  });

  it("reveal logs 'votes revealed' with stats", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    // Cast a vote first
    dispatch(
      id,
      req(C2S.castVote, { roomCode: code, cardValue: 8 }),
      rooms,
      conns,
    );
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.reveal, { roomCode: code }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "votes revealed");
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({
      roomCode: code,
      stats: expect.any(Object),
    });
  });

  it("reset logs 'round reset' with roomCode", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.reset, { roomCode: code }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "round reset");
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({ roomCode: code });
  });

  it("setTask logs 'task set' with roomCode", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.setTask, { roomCode: code, description: "story" }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const entry = calls.find((c) => c.msg === "task set");
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({ roomCode: code });
  });
});

// ---------------------------------------------------------------------------
// AC-9: error codes all produce warn logs
// ---------------------------------------------------------------------------

describe("router logging — AC-9 error codes produce warn", () => {
  it("VALIDATION via replyError emits warn with code VALIDATION", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.createRoom, { displayName: "" }, "c1"),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "VALIDATION",
    );
    expect(warn).toBeDefined();
  });

  it("ROOM_NOT_FOUND via replyError emits warn", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.joinRoom, { roomCode: "ZZZZZZ", displayName: "X" }, "j1"),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "ROOM_NOT_FOUND",
    );
    expect(warn).toBeDefined();
  });

  it("NOT_IN_ROOM via emitError emits warn", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.setTask, { roomCode: "ABCDEF", description: "x" }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "NOT_IN_ROOM",
    );
    expect(warn).toBeDefined();
  });

  it("NOT_HOST via emitError emits warn", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const hostWs = fakeSocket();
    const guestWs = fakeSocket();
    const { code } = createRoom(rooms, conns, hostWs);
    const guestId = conns.register(guestWs);
    dispatch(
      guestId,
      req(C2S.joinRoom, { roomCode: code, displayName: "Guest" }, "j1"),
      rooms,
      conns,
    );
    const calls: LogCall[] = [];
    dispatch(
      guestId,
      req(C2S.setTask, { roomCode: code, description: "x" }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "NOT_HOST",
    );
    expect(warn).toBeDefined();
  });

  it("ALREADY_REVEALED via emitError emits warn (castVote after reveal)", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const ws = fakeSocket();
    const { id, code } = createRoom(rooms, conns, ws);
    // Reveal first so subsequent castVote returns ALREADY_REVEALED
    dispatch(id, req(C2S.reveal, { roomCode: code }), rooms, conns);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.castVote, { roomCode: code, cardValue: 5 }),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "ALREADY_REVEALED",
    );
    expect(warn).toBeDefined();
  });

  it("TOO_MANY_ROOMS via replyError emits warn", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    // Fill up to the limit (50 rooms)
    for (let i = 0; i < 50; i++) {
      const ws = fakeSocket();
      const id = conns.register(ws);
      rooms.createRoom(id, `Host${i}`);
    }
    const ws = fakeSocket();
    const id = conns.register(ws);
    const calls: LogCall[] = [];
    dispatch(
      id,
      req(C2S.createRoom, { displayName: "OverLimit" }, "c1"),
      rooms,
      conns,
      makeRecordingLogger(calls),
    );
    const warn = calls.find(
      (c) => c.level === "warn" && c.obj?.code === "TOO_MANY_ROOMS",
    );
    expect(warn).toBeDefined();
  });
});
