import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RoomRegistry } from "../domain/rooms";
import type { Logger } from "../lib/logger";
import { ConnectionRegistry } from "./connection-registry";
import { createWsHandler } from "./gateway";

// ---------------------------------------------------------------------------
// Recording logger fake
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
      // Child captures parent calls array, merges bindings into each obj
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

// ---------------------------------------------------------------------------
// Minimal WSContext fake
// ---------------------------------------------------------------------------

function makeWsContext(raw: EventEmitter | null = null): {
  raw: EventEmitter | null;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  closed: { code?: number; reason?: string } | null;
} {
  return {
    raw,
    closed: null,
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
    },
    send(_data: string) {},
  };
}

function openEvent(): Event {
  return {} as Event;
}

function msgEvent(data: string): { data: string } {
  return { data };
}

// ---------------------------------------------------------------------------
// Helpers to drive the handler
// ---------------------------------------------------------------------------

function makeHandler(calls: LogCall[]) {
  const rooms = new RoomRegistry();
  const conns = new ConnectionRegistry(rooms);
  const log = makeRecordingLogger(calls);
  const factory = createWsHandler(rooms, conns, log);
  const handler = factory({} as never);
  return { handler, rooms, conns };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway unit — AC-5: onOpen logs ws connected with connectionId", () => {
  it("logs 'ws connected' carrying connectionId on open", () => {
    const calls: LogCall[] = [];
    const { handler } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);
    const connected = calls.find((c) => c.msg === "ws connected");
    expect(connected).toBeDefined();
    expect(connected?.obj).toMatchObject({ connectionId: expect.any(String) });
  });
});

describe("gateway unit — AC-12: raw-socket error listener carries connectionId", () => {
  it("captures 'ws error' with the connectionId from the open closure", () => {
    const calls: LogCall[] = [];
    const { handler } = makeHandler(calls);
    const rawEmitter = new EventEmitter();
    const ws = makeWsContext(rawEmitter);
    handler.onOpen(openEvent(), ws as never);

    // Grab the connectionId from the "ws connected" log
    const connected = calls.find((c) => c.msg === "ws connected");
    const connectionId = connected?.obj?.connectionId as string;
    expect(connectionId).toBeTruthy();

    // Emit an error on the raw socket
    rawEmitter.emit("error", new Error("boom"));

    const errCall = calls.find((c) => c.msg === "ws error");
    expect(errCall).toBeDefined();
    expect(errCall?.level).toBe("error");
    expect(errCall?.obj).toMatchObject({
      connectionId,
      err: expect.any(Error),
    });
  });
});

describe("gateway unit — AC-10: oversized and malformed frames log warn", () => {
  it("warns on oversized frame (no body logged)", () => {
    const calls: LogCall[] = [];
    const { handler } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);

    // > MAX_FRAME_BYTES (100_000)
    handler.onMessage(msgEvent("x".repeat(100_001)), ws as never);

    const warn = calls.find((c) => c.msg === "oversized frame");
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    // Must NOT log frame body
    expect(JSON.stringify(warn?.obj ?? {})).not.toContain("x".repeat(10));
  });

  it("warns on malformed (non-JSON) frame", () => {
    const calls: LogCall[] = [];
    const { handler } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);

    handler.onMessage(msgEvent("{ not valid json"), ws as never);

    const warn = calls.find((c) => c.msg === "malformed frame");
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
  });

  it("survives malformed frame (no crash, connection still functional)", () => {
    const calls: LogCall[] = [];
    const { handler, conns } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);
    const sizeBefore = conns.size;

    handler.onMessage(msgEvent("{ not valid json"), ws as never);

    // Registry still has the connection
    expect(conns.size).toBe(sizeBefore);
  });
});

describe("gateway unit — AC-5: onClose logs ws disconnected with connectionId + code + reason", () => {
  it("logs 'ws disconnected' on close", () => {
    const calls: LogCall[] = [];
    const { handler } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);

    handler.onClose({ code: 1000, reason: "normal" }, ws as never);

    const disc = calls.find((c) => c.msg === "ws disconnected");
    expect(disc).toBeDefined();
    expect(disc?.obj).toMatchObject({
      connectionId: expect.any(String),
      code: 1000,
      reason: "normal",
    });
  });

  it("onClose with connectionId-only when contextFor is undefined (reaped room path)", () => {
    const calls: LogCall[] = [];
    const { handler, rooms } = makeHandler(calls);
    const ws = makeWsContext(new EventEmitter());
    handler.onOpen(openEvent(), ws as never);

    // Never joined a room — contextFor returns undefined
    expect(rooms.contextFor("anything")).toBeUndefined();
    handler.onClose({ code: 1001, reason: "going away" }, ws as never);

    const disc = calls.find((c) => c.msg === "ws disconnected");
    expect(disc).toBeDefined();
    expect(disc?.obj).toMatchObject({ connectionId: expect.any(String) });
    // No roomCode or participantId present
    expect(disc?.obj).not.toHaveProperty("roomCode");
    expect(disc?.obj).not.toHaveProperty("participantId");
  });
});
