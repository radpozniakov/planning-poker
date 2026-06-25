import { describe, expect, it, vi } from "vitest";
import { ENVELOPE_KIND, S2C } from "@pp/shared";
import { RoomRegistry } from "../domain/rooms";
import { ConnectionRegistry, type Sendable } from "./connection-registry";

/** A fake socket capturing everything sent to it. readyState defaults to OPEN. */
function fakeSocket(readyState = 1): Sendable & { sent: string[] } {
  return {
    sent: [],
    readyState,
    send(data: string) {
      this.sent.push(data);
    },
    close: vi.fn(),
  };
}

describe("ConnectionRegistry", () => {
  it("registers a socket and returns a usable connectionId", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const id = conns.register(fakeSocket());
    expect(typeof id).toBe("string");
    expect(conns.size).toBe(1);
  });

  it("broadcastToRoom sends only to members of that room", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const hostWs = fakeSocket();
    const guestWs = fakeSocket();
    const outsiderWs = fakeSocket();

    const hostId = conns.register(hostWs);
    const guestId = conns.register(guestWs);
    const outsiderId = conns.register(outsiderWs);

    const created = rooms.createRoom(hostId, "Host");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const code = created.room.code;
    rooms.joinRoom(guestId, code, "Guest");
    rooms.createRoom(outsiderId, "Outsider"); // a different room

    conns.broadcastToRoom(code, S2C.presence, { participants: [] });

    expect(hostWs.sent.length).toBe(1);
    expect(guestWs.sent.length).toBe(1);
    expect(outsiderWs.sent.length).toBe(0);
    const env = JSON.parse(hostWs.sent[0]);
    expect(env.kind).toBe(ENVELOPE_KIND.event);
    expect(env.event).toBe(S2C.presence);
  });

  it("never sends to a non-open socket", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const closed = fakeSocket(3); // CLOSED
    const id = conns.register(closed);
    conns.sendEvent(id, S2C.roundReset, {});
    expect(closed.sent.length).toBe(0);
  });

  it("sendAck emits the ok and error envelope shapes", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const sock = fakeSocket();
    const id = conns.register(sock);

    conns.sendAck(id, "c1", { ok: true, payload: { ok: true, roomCode: "ABCDEF" } });
    conns.sendAck(id, "c2", { ok: false, error: { code: "ROOM_NOT_FOUND", message: "nope" } });

    expect(JSON.parse(sock.sent[0])).toMatchObject({
      kind: ENVELOPE_KIND.ack,
      id: "c1",
      ok: true,
      payload: { ok: true, roomCode: "ABCDEF" },
    });
    expect(JSON.parse(sock.sent[1])).toMatchObject({
      kind: ENVELOPE_KIND.ack,
      id: "c2",
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  it("unregister removes a connection from fan-out", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const sock = fakeSocket();
    const id = conns.register(sock);
    conns.unregister(id);
    conns.sendEvent(id, S2C.roundReset, {});
    expect(sock.sent.length).toBe(0);
    expect(conns.size).toBe(0);
  });

  it("closeAll closes every socket and clears the map", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const a = fakeSocket();
    const b = fakeSocket();
    conns.register(a);
    conns.register(b);
    conns.closeAll();
    expect(a.close).toHaveBeenCalledWith(1001, "server shutting down");
    expect(b.close).toHaveBeenCalled();
    expect(conns.size).toBe(0);
  });
});
