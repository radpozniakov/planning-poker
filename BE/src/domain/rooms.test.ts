import { describe, expect, it } from "vitest";
import { LIMITS } from "@pp/shared";
import { RoomRegistry, type Scheduler } from "./rooms";
import type { Logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Recording fake logger — captures calls for assertion without touching stdout.
// ---------------------------------------------------------------------------
type LogCall = { obj?: Record<string, unknown>; msg: string };

function makeFakeLogger(): Logger & { calls: Record<string, LogCall[]> } {
  const calls: Record<string, LogCall[]> = {
    info: [],
    warn: [],
    error: [],
    fatal: [],
  };
  function makeLevel(level: string) {
    return (objOrMsg: Record<string, unknown> | string, msg?: string): void => {
      if (typeof objOrMsg === "string") {
        calls[level]!.push({ msg: objOrMsg });
      } else {
        calls[level]!.push({ obj: objOrMsg, msg: msg ?? "" });
      }
    };
  }
  return {
    calls,
    info: makeLevel("info") as Logger["info"],
    warn: makeLevel("warn") as Logger["warn"],
    error: makeLevel("error") as Logger["error"],
    fatal: makeLevel("fatal") as Logger["fatal"],
    child(_bindings: Record<string, unknown>): Logger {
      return this;
    },
  };
}

/** Narrow a registry Result to its success variant, failing the test otherwise. */
function assertOk<R extends { ok: boolean }>(
  r: R,
): asserts r is Extract<R, { ok: true }> {
  if (!r.ok) {
    throw new Error(`expected ok result, got error: ${JSON.stringify(r)}`);
  }
}

/**
 * Deterministic Scheduler stub: records callbacks instead of waiting real time, lets a test
 * fire them on demand (`runAll`), and honours `clearTimeout` so cancelled timers never fire.
 * Mirrors the domain's existing injection style (an explicit `now`) rather than vitest's
 * global fake timers — the grace logic is pure given a scheduler, so this keeps it that way.
 */
class FakeScheduler implements Scheduler {
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(fn: () => void): unknown {
    const id = this.nextId++;
    this.callbacks.set(id, fn);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  /** Number of timers still pending (not yet fired or cleared). */
  get pending(): number {
    return this.callbacks.size;
  }

  /** Fire every pending timer once, in scheduling order, draining the queue. */
  runAll(): void {
    const due = [...this.callbacks.entries()].toSorted((a, b) => a[0] - b[0]);
    this.callbacks.clear();
    for (const [, fn] of due) fn();
  }
}

describe("RoomRegistry — create & join", () => {
  it("makes the creator the host and seeds the room", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("sock-host", "Alice");
    assertOk(created);

    expect(created.participant.isHost).toBe(true);
    expect(created.room.hostParticipantId).toBe(created.participant.id);
    expect(created.room.code).toHaveLength(6);
    expect(reg.roomCount).toBe(1);
  });

  it("adds joiners as non-hosts and enforces the contextFor index", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("sock-host", "Alice");
    assertOk(created);
    const joined = reg.joinRoom("sock-bob", created.room.code, "Bob");
    assertOk(joined);

    expect(joined.participant.isHost).toBe(false);
    expect(reg.getRoom(created.room.code)?.participants.size).toBe(2);
    expect(reg.contextFor("sock-bob")).toEqual({
      roomCode: created.room.code,
      participantId: joined.participant.id,
    });
  });

  it("rejects joining a room that does not exist", () => {
    const reg = new RoomRegistry();
    const res = reg.joinRoom("sock-x", "ZZZZZZ", "Nobody");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ROOM_NOT_FOUND");
  });
});

describe("RoomRegistry — voting rules", () => {
  it("overwrites a prior vote (re-pick allowed, one vote per participant)", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const id = created.participant.id;

    reg.castVote(code, id, 5);
    reg.castVote(code, id, 8);

    const room = reg.getRoom(code);
    expect(room?.votes.size).toBe(1);
    expect(room?.votes.get(id)?.cardValue).toBe(8);
  });

  it("rejects a vote after reveal with ALREADY_REVEALED (no value change)", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const id = created.participant.id;

    reg.castVote(code, id, 3);
    assertOk(reg.reveal(code, id));

    const late = reg.castVote(code, id, 13);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe("ALREADY_REVEALED");
    expect(reg.getRoom(code)?.votes.get(id)?.cardValue).toBe(3);
  });

  it("hides votes until reveal, then exposes them with stats", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const bob = reg.joinRoom("s2", created.room.code, "Bob");
    assertOk(bob);
    const code = created.room.code;

    reg.castVote(code, created.participant.id, 5);
    reg.castVote(code, bob.participant.id, 5);

    // Pre-reveal: stored votes are hidden.
    expect(
      [...(reg.getRoom(code)?.votes.values() ?? [])].every((v) => v.hidden),
    ).toBe(true);

    const revealed = reg.reveal(code, created.participant.id);
    assertOk(revealed);
    expect(revealed.votes.every((v) => v.hidden === false)).toBe(true);
    expect(revealed.stats.allAgree).toBe(true);
    expect(revealed.stats.average).toBe(5);
  });

  it("only the host may set task / reveal / reset", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const bob = reg.joinRoom("s2", created.room.code, "Bob");
    assertOk(bob);
    const code = created.room.code;

    expect(reg.setTask(code, bob.participant.id, "x").ok).toBe(false);
    expect(reg.reveal(code, bob.participant.id).ok).toBe(false);
    expect(reg.reset(code, bob.participant.id).ok).toBe(false);
    expect(reg.setTask(code, created.participant.id, "x").ok).toBe(true);
  });

  it("reset clears votes + reveal but KEEPS the current task", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const id = created.participant.id;

    reg.setTask(code, id, "Estimate the login flow");
    reg.castVote(code, id, 8);
    assertOk(reg.reveal(code, id));
    assertOk(reg.reset(code, id));

    const room = reg.getRoom(code);
    expect(room?.votes.size).toBe(0);
    expect(room?.revealed).toBe(false);
    expect(room?.currentTask?.description).toBe("Estimate the login flow");
    expect(room?.participants.get(id)?.hasVoted).toBe(false);
  });
});

describe("public-DTO wire boundary (§3a)", () => {
  it("never serializes connectionId or cardValue in roomState/presence", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    reg.joinRoom("s2", code, "Bob");
    reg.castVote(code, created.participant.id, 5); // a real, hidden vote exists

    const room = reg.getRoom(code)!;
    const roomState = JSON.stringify(reg.buildRoomState(room));
    const presence = JSON.stringify({ participants: reg.toPublic(room) });

    expect(roomState).not.toMatch(/connectionId|cardValue/);
    expect(presence).not.toMatch(/connectionId|cardValue/);

    // Shape check: PublicParticipant only.
    const first = reg.toPublic(room)[0]!;
    expect(Object.keys(first).toSorted()).toEqual([
      "displayName",
      "hasVoted",
      "id",
      "isHost",
    ]);
    expect(first).not.toHaveProperty("connectionId");

    // cardValue is allowed to appear ONLY in the revealed payload.
    const revealed = reg.reveal(code, created.participant.id);
    assertOk(revealed);
    expect(JSON.stringify(revealed.votes)).toMatch(/cardValue/);
  });
});

describe("disconnect / host transfer (§3b)", () => {
  it("removes a non-host without changing the host", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    reg.joinRoom("s2", code, "Bob");

    const left = reg.leave("s2");
    expect(left?.roomGone).toBe(false);
    expect(left?.hostChanged).toBe(false);
    expect(reg.getRoom(code)?.participants.size).toBe(1);
    expect(reg.getRoom(code)?.hostParticipantId).toBe(created.participant.id);
  });

  it("promotes the smallest-joinedAt survivor when the host leaves (NOT map order)", () => {
    const reg = new RoomRegistry();
    const host = reg.createRoom("s1", "Host", 1000);
    assertOk(host);
    const code = host.room.code;
    // Inserted first, but joined LATER (joinedAt 3000).
    const bob = reg.joinRoom("s2", code, "Bob", undefined, 3000);
    assertOk(bob);
    // Inserted second, but joined EARLIER (joinedAt 2000) -> should win.
    const carol = reg.joinRoom("s3", code, "Carol", undefined, 2000);
    assertOk(carol);

    const left = reg.leave("s1");
    expect(left?.hostChanged).toBe(true);
    expect(left?.hostParticipantId).toBe(carol.participant.id);
    expect(
      reg.getRoom(code)?.participants.get(carol.participant.id)?.isHost,
    ).toBe(true);
  });

  it("schedules deletion (grace window) when the last participant leaves", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;

    const left = reg.leave("s1");
    // Reported gone (no one to broadcast to) but kept alive for the grace window…
    expect(left?.roomGone).toBe(true);
    expect(reg.getRoom(code)).toBeDefined();
    expect(reg.roomCount).toBe(1);

    // …and only actually deleted once the grace timer fires.
    sched.runAll();
    expect(reg.getRoom(code)).toBeUndefined();
    expect(reg.roomCount).toBe(0);
  });
});

describe("empty-room grace period (refresh survival)", () => {
  it("a solo host who rejoins inside the grace window keeps the room", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const pid = created.participant.id;

    // Refresh: old socket closes (empties room), new socket rejoins with the same pid.
    reg.leave("s1");
    const rejoined = reg.joinRoom("s2", code, "Alice", pid);
    assertOk(rejoined);
    expect(rejoined.reconnected).toBe(true);
    expect(rejoined.participant.isHost).toBe(true); // host status preserved

    // The pending grace timer was cancelled — firing any remaining timers is a no-op.
    sched.runAll();
    expect(reg.getRoom(code)).toBeDefined();
    expect(reg.getRoom(code)?.hostParticipantId).toBe(pid);
  });

  it("a DIFFERENT person joining a parked room evicts the ghost and becomes host", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const aliceId = created.participant.id;
    // Alice casts a vote, then abandons the solo room (no refresh).
    reg.castVote(code, aliceId, 5);
    reg.leave("s1");

    // Bob opens the share link within the grace window with NO stored session.
    const bob = reg.joinRoom("s3", code, "Bob");
    assertOk(bob);
    expect(bob.reconnected).toBe(false);

    const room = reg.getRoom(code)!;
    // The parked ghost (Alice) must NOT linger in the roster…
    const roster = reg.toPublic(room);
    expect(roster.map((p) => p.displayName)).toEqual(["Bob"]);
    // …Bob inherits the host role (no dangling pointer to the gone host)…
    expect(bob.participant.isHost).toBe(true);
    expect(room.hostParticipantId).toBe(bob.participant.id);
    // …and Alice's stale vote is gone so it can't surface on reveal.
    expect(room.votes.has(aliceId)).toBe(false);
    expect(room.parkedParticipantId).toBeNull();

    // The grace timer was cancelled by Bob's join — firing it leaves the room intact.
    sched.runAll();
    expect(reg.getRoom(code)).toBeDefined();
  });

  it("deletes the room if no one rejoins before the timer fires", () => {
    const sched = new FakeScheduler();
    const deleted: Array<{ code: string; cids: string[] }> = [];
    const reg = new RoomRegistry(sched, (code, cids) =>
      deleted.push({ code, cids }),
    );
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;

    reg.leave("s1");
    sched.runAll();

    expect(reg.getRoom(code)).toBeUndefined();
    expect(reg.contextFor("s1")).toBeUndefined(); // bySocket purged
    // The parked (socket-less) participant's dead connectionId is handed back so the
    // transport can close it — an idempotent no-op since the refresh already closed it.
    expect(deleted).toEqual([{ code, cids: ["s1"] }]);
  });

  it("re-emptying after a rejoin reschedules a fresh timer", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const pid = created.participant.id;

    reg.leave("s1"); // timer #1 scheduled
    reg.joinRoom("s2", code, "Alice", pid); // cancels #1
    reg.leave("s2"); // timer #2 scheduled

    sched.runAll(); // fires #2 only
    expect(reg.getRoom(code)).toBeUndefined();
  });

  it("the reaper cancels a pending grace timer so a room is never double-deleted", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);
    const code = created.room.code;

    reg.leave("s1", 1000); // schedules grace deletion
    // Reaper sweeps the now-idle, abandoned room before the grace timer fires.
    const reaped = reg.reapExpired(
      1000 + LIMITS.roomIdleTtlMs + 1,
      () => false,
    );
    expect(reaped.map((r) => r.roomCode)).toEqual([code]);
    expect(reg.getRoom(code)).toBeUndefined();

    // The grace timer was cancelled — firing it must NOT throw or touch a deleted room.
    expect(() => sched.runAll()).not.toThrow();
  });

  it("shutdown() clears all pending grace timers", () => {
    const sched = new FakeScheduler();
    const reg = new RoomRegistry(sched);
    const a = reg.createRoom("s1", "A");
    const b = reg.createRoom("s2", "B");
    assertOk(a);
    assertOk(b);

    reg.leave("s1");
    reg.leave("s2");
    expect(sched.pending).toBe(2);

    reg.shutdown();
    expect(sched.pending).toBe(0);
    // Rooms still exist (deletion never fired); they'd be cleared on process exit.
    sched.runAll();
    expect(reg.roomCount).toBe(2);
  });
});

describe("idle-room reaping", () => {
  const TTL = LIMITS.roomIdleTtlMs;

  it("reaps a room idle past the TTL but spares an active one", () => {
    const reg = new RoomRegistry();
    const idle = reg.createRoom("s-idle", "Idle", 1000);
    assertOk(idle);
    const active = reg.createRoom("s-active", "Active", 1000);
    assertOk(active);

    // `now` is just past the idle room's TTL; the active room is touched right before.
    const now = 1000 + TTL + 1;
    reg.castVote(active.room.code, active.participant.id, 5, now);

    const reaped = reg.reapExpired(now);

    expect(reaped.map((r) => r.roomCode)).toEqual([idle.room.code]);
    expect(reg.getRoom(idle.room.code)).toBeUndefined();
    expect(reg.getRoom(active.room.code)).toBeDefined();
    expect(reg.roomCount).toBe(1);
  });

  it("does NOT reap exactly at the TTL boundary (strictly greater than)", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);

    expect(reg.reapExpired(1000 + TTL)).toEqual([]);
    expect(reg.roomCount).toBe(1);
  });

  it("returns each reaped room's code and its participants' connectionIds", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s-host", "Host", 1000);
    assertOk(created);
    reg.joinRoom("s-guest", created.room.code, "Guest", undefined, 1000);

    const reaped = reg.reapExpired(1000 + TTL + 1);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.roomCode).toBe(created.room.code);
    expect(reaped[0]!.connectionIds.toSorted()).toEqual(["s-guest", "s-host"]);
  });

  it("purges the bySocket index so a reaped socket no longer resolves", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);

    reg.reapExpired(1000 + TTL + 1);

    expect(reg.contextFor("s1")).toBeUndefined();
    expect(reg.leave("s1")).toBeNull();
  });

  it("bumps lastActivityAt on every activity-bearing mutation", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);
    const code = created.room.code;
    const id = created.participant.id;
    const room = reg.getRoom(code)!;
    expect(room.lastActivityAt).toBe(1000); // seeded to createdAt

    reg.joinRoom("s2", code, "Bob", undefined, 2000);
    expect(room.lastActivityAt).toBe(2000);

    // Reconnect rebind counts as activity.
    reg.joinRoom("s1-new", code, "Alice", id, 3000);
    expect(room.lastActivityAt).toBe(3000);

    reg.setTask(code, id, "task", 4000);
    expect(room.lastActivityAt).toBe(4000);

    reg.castVote(code, id, 5, 5000);
    expect(room.lastActivityAt).toBe(5000);

    reg.reveal(code, id, 6000);
    expect(room.lastActivityAt).toBe(6000);

    reg.reset(code, id, 7000);
    expect(room.lastActivityAt).toBe(7000);
  });

  it("does NOT bump lastActivityAt on read-only calls", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);
    const room = reg.getRoom(created.room.code)!;

    reg.getRoom(created.room.code);
    reg.contextFor("s1");
    reg.connectionIdsIn(created.room.code);
    reg.buildRoomState(room);

    expect(room.lastActivityAt).toBe(1000);
  });

  it("spares an expired room when the liveness predicate reports a live connection", () => {
    const reg = new RoomRegistry();
    const present = reg.createRoom("s-present", "Present", 1000);
    assertOk(present);
    const abandoned = reg.createRoom("s-gone", "Gone", 1000);
    assertOk(abandoned);

    // Both rooms are equally idle and equally past the TTL; only presence differs.
    const now = 1000 + TTL + 1;
    const reaped = reg.reapExpired(now, (cid) => cid === "s-present");

    // Only the abandoned room is reaped; presence beats idleness.
    expect(reaped.map((r) => r.roomCode)).toEqual([abandoned.room.code]);
    expect(reg.getRoom(present.room.code)).toBeDefined();
    expect(reg.getRoom(abandoned.room.code)).toBeUndefined();
  });

  it("bumps lastActivityAt when a participant leaves a surviving room", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice", 1000);
    assertOk(created);
    reg.joinRoom("s2", created.room.code, "Bob", undefined, 1000);
    const room = reg.getRoom(created.room.code)!;

    // Bob disconnects much later; the room survives (Alice remains) and the departure
    // counts as activity, so the room is not treated as idle since 1000.
    reg.leave("s2", 9000);
    expect(room.lastActivityAt).toBe(9000);
  });
});

describe("reconnection rebind", () => {
  it("preserves joinedAt + host status and no-ops the stale socket's disconnect", () => {
    const reg = new RoomRegistry();
    const host = reg.createRoom("s1", "Host", 1000);
    assertOk(host);
    const code = host.room.code;

    // Same participant reconnects on a new socket.
    const re = reg.joinRoom("s1-new", code, "Host", host.participant.id, 9999);
    assertOk(re);
    expect(re.reconnected).toBe(true);
    expect(re.participant.joinedAt).toBe(1000); // preserved, not re-stamped
    expect(re.participant.isHost).toBe(true);
    expect(reg.contextFor("s1-new")?.participantId).toBe(host.participant.id);

    // The old socket's late disconnect must NOT remove the reconnected participant.
    expect(reg.leave("s1")).toBeNull();
    expect(reg.getRoom(code)?.participants.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7: grace lifecycle logging (injected fake logger)
// ---------------------------------------------------------------------------
describe("grace-lifecycle logging (AC-7)", () => {
  it("logs grace.scheduled when the last participant leaves", () => {
    const sched = new FakeScheduler();
    const fakeLog = makeFakeLogger();
    const reg = new RoomRegistry(sched, () => {}, fakeLog);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;

    reg.leave("s1");

    const scheduled = fakeLog.calls.info!.filter(
      (c) => c.msg === "grace.scheduled",
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.obj).toMatchObject({ roomCode: code });
  });

  it("logs grace.cancelled when a participant rejoins within the grace window", () => {
    const sched = new FakeScheduler();
    const fakeLog = makeFakeLogger();
    const reg = new RoomRegistry(sched, () => {}, fakeLog);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;
    const pid = created.participant.id;

    reg.leave("s1");
    reg.joinRoom("s2", code, "Alice", pid);

    const cancelled = fakeLog.calls.info!.filter(
      (c) => c.msg === "grace.cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.obj).toMatchObject({ roomCode: code });
  });

  it("logs grace.fired when the grace timer fires and no one rejoined", () => {
    const sched = new FakeScheduler();
    const fakeLog = makeFakeLogger();
    const reg = new RoomRegistry(sched, () => {}, fakeLog);
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;

    reg.leave("s1");
    sched.runAll(); // fire the grace timer

    const fired = fakeLog.calls.info!.filter((c) => c.msg === "grace.fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.obj).toMatchObject({ roomCode: code });
  });

  it("logs room.reaped with roomCode and connectionIds when reapExpired removes a room", () => {
    const fakeLog = makeFakeLogger();
    const reg = new RoomRegistry(undefined, () => {}, fakeLog);
    const created = reg.createRoom("s-host", "Host", 1000);
    assertOk(created);
    reg.joinRoom("s-guest", created.room.code, "Guest", undefined, 1000);
    const code = created.room.code;

    reg.reapExpired(1000 + LIMITS.roomIdleTtlMs + 1, () => false);

    const reaped = fakeLog.calls.info!.filter((c) => c.msg === "room.reaped");
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.obj).toMatchObject({ roomCode: code });
    const loggedIds = (reaped[0]!.obj!.connectionIds as string[]).toSorted();
    expect(loggedIds).toEqual(["s-guest", "s-host"]);
  });
});
