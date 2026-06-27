import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@pp/shared";
import { RoomRegistry } from "../domain/rooms";
import { ConnectionRegistry, type Sendable } from "./connection-registry";
import { startIdleReaper, SWEEP_INTERVAL_MS } from "./reaper";

/** A fake socket capturing close calls. readyState defaults to OPEN. */
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

describe("closeConnections (reaper transport)", () => {
  it("closes + unregisters orphaned sockets with 1001 'room expired'", () => {
    const conns = new ConnectionRegistry(new RoomRegistry());
    const a = fakeSocket();
    const b = fakeSocket();
    const idA = conns.register(a);
    const idB = conns.register(b);

    conns.closeConnections([idA, idB]);

    expect(a.close).toHaveBeenCalledWith(1001, "room expired");
    expect(b.close).toHaveBeenCalledWith(1001, "room expired");
    expect(conns.size).toBe(0);
  });

  it("reaps an abandoned expired room but spares a present-but-silent one", () => {
    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    // Abandoned room: sockets are CLOSED (readyState 3) — nobody is actually here, the
    // close just never propagated to a clean disconnect.
    const deadHost = fakeSocket(3);
    const deadGuest = fakeSocket(3);
    // Present-but-silent room: socket is OPEN (someone is here, they just haven't voted).
    const liveHost = fakeSocket(1);

    const deadHostId = conns.register(deadHost);
    const deadGuestId = conns.register(deadGuest);
    const liveHostId = conns.register(liveHost);

    const dead = rooms.createRoom(deadHostId, "Dead", 1000);
    expect(dead.ok).toBe(true);
    if (!dead.ok) return;
    rooms.joinRoom(deadGuestId, dead.room.code, "Guest", undefined, 1000);

    const live = rooms.createRoom(liveHostId, "Live", 1000);
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    // Both rooms are equally idle (no mutation since 1000) and equally past the TTL.
    const now = 1000 + LIMITS.roomIdleTtlMs + 1;
    const isLive = (cid: string) => conns.isLive(cid);

    for (const { connectionIds } of rooms.reapExpired(now, isLive)) {
      conns.closeConnections(connectionIds);
    }

    // Abandoned room reaped; present-but-silent room spared purely because a socket is open.
    expect(deadHost.close).toHaveBeenCalledWith(1001, "room expired");
    expect(deadGuest.close).toHaveBeenCalledWith(1001, "room expired");
    expect(liveHost.close).not.toHaveBeenCalled();
    expect(rooms.getRoom(dead.room.code)).toBeUndefined();
    expect(rooms.getRoom(live.room.code)).toBeDefined();
    expect(conns.size).toBe(1); // only the live host remains
  });
});

describe("startIdleReaper — setInterval lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the sockets of an abandoned room after one sweep interval elapses", () => {
    vi.useFakeTimers();
    const BASE = 1000;
    vi.setSystemTime(BASE);

    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const sock = fakeSocket(3); // CLOSED — the room is genuinely abandoned.
    const connId = conns.register(sock);

    const created = rooms.createRoom(connId, "Alice", BASE);
    expect(created.ok).toBe(true);

    // Advance past the idle TTL so the room is stale when the sweep fires.
    vi.setSystemTime(BASE + LIMITS.roomIdleTtlMs + 1);

    const handle = startIdleReaper(rooms, conns);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(sock.close).toHaveBeenCalledWith(1001, "room expired");
    expect(conns.size).toBe(0);

    clearInterval(handle);
  });

  it("spares a present-but-silent room even after the TTL elapses", () => {
    vi.useFakeTimers();
    const BASE = 1000;
    vi.setSystemTime(BASE);

    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const sock = fakeSocket(1); // OPEN — someone is here, they just haven't voted.
    const connId = conns.register(sock);

    const created = rooms.createRoom(connId, "Alice", BASE);
    expect(created.ok).toBe(true);

    // Idle past the TTL, but the socket is still open.
    vi.setSystemTime(BASE + LIMITS.roomIdleTtlMs * 2);

    const handle = startIdleReaper(rooms, conns);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);

    // Live presence beats idleness — the room and its socket are untouched.
    expect(sock.close).not.toHaveBeenCalled();
    expect(conns.size).toBe(1);
    if (created.ok) expect(rooms.getRoom(created.room.code)).toBeDefined();

    clearInterval(handle);
  });

  it("does NOT reap after clearInterval stops the sweep", () => {
    vi.useFakeTimers();
    const BASE = 1000;
    vi.setSystemTime(BASE);

    const rooms = new RoomRegistry();
    const conns = new ConnectionRegistry(rooms);
    const sock = fakeSocket();
    const connId = conns.register(sock);

    const created = rooms.createRoom(connId, "Bob", BASE);
    expect(created.ok).toBe(true);

    const handle = startIdleReaper(rooms, conns);

    // Stop the sweep before any interval fires.
    clearInterval(handle);

    // Now make the room go idle.
    vi.setSystemTime(BASE + LIMITS.roomIdleTtlMs + 1);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);

    // Sweep was cancelled — socket must be untouched.
    expect(sock.close).not.toHaveBeenCalled();
    expect(conns.size).toBe(1);
  });
});
