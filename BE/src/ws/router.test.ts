import { describe, expect, it } from "vitest";
import { C2S, ENVELOPE_KIND, S2C, type ParsedClientEnvelope } from "@pp/shared";
import { RoomRegistry } from "../domain/rooms";
import { ConnectionRegistry, type Sendable } from "./connection-registry";
import { dispatch, handleDisconnect } from "./router";

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
