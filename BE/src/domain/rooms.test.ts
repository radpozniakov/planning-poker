import { describe, expect, it } from "vitest";
import { RoomRegistry } from "./rooms";

/** Narrow a registry Result to its success variant, failing the test otherwise. */
function assertOk<R extends { ok: boolean }>(
  r: R,
): asserts r is Extract<R, { ok: true }> {
  if (!r.ok) {
    throw new Error(`expected ok result, got error: ${JSON.stringify(r)}`);
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
    expect(left?.roomDeleted).toBe(false);
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

  it("deletes the room when the last participant leaves", () => {
    const reg = new RoomRegistry();
    const created = reg.createRoom("s1", "Alice");
    assertOk(created);
    const code = created.room.code;

    const left = reg.leave("s1");
    expect(left?.roomDeleted).toBe(true);
    expect(reg.getRoom(code)).toBeUndefined();
    expect(reg.roomCount).toBe(0);
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
