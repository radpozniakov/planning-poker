import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { C2S, ENVELOPE_KIND, S2C } from "@pp/shared";
import { createApp } from "../app";

/**
 * End-to-end transport test: boots the real Hono app + node-server + WS on an ephemeral
 * port and drives it through a real `ws` client. Proves ack correlation, room broadcast,
 * disconnect cleanup, and malformed-frame resilience — the socket.io features we hand-rolled.
 */

let server: ReturnType<typeof serve>;
let port = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  const { app, injectWebSocket } = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
    injectWebSocket(server);
  });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(): Promise<WebSocket> {
  const sock = new WebSocket(`ws://localhost:${port}/ws`);
  sockets.push(sock);
  return new Promise((resolve, reject) => {
    sock.on("open", () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Send a correlated request and resolve with its matching ack envelope. */
function rpc(sock: WebSocket, event: string, payload: unknown): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData) => {
      const env = JSON.parse(data.toString());
      if (env.kind === ENVELOPE_KIND.ack && env.id === id) {
        sock.off("message", onMsg);
        resolve(env);
      }
    };
    sock.on("message", onMsg);
    sock.send(JSON.stringify({ kind: ENVELOPE_KIND.request, event, payload, id }));
  });
}

/** Resolve with the next server event envelope of the given type on this socket. */
function nextEvent(sock: WebSocket, event: string): Promise<any> {
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData) => {
      const env = JSON.parse(data.toString());
      if (env.kind === ENVELOPE_KIND.event && env.event === event) {
        sock.off("message", onMsg);
        resolve(env);
      }
    };
    sock.on("message", onMsg);
  });
}

describe("WebSocket gateway (integration)", () => {
  it("runs the full create -> join -> task -> vote -> reveal -> leave flow", async () => {
    // --- createRoom: ack carries the room code + participant id ---
    const host = await connect();
    const createAck = await rpc(host, C2S.createRoom, { displayName: "Host" });
    expect(createAck.ok).toBe(true);
    expect(createAck.payload).toMatchObject({ ok: true, isHost: true });
    const roomCode: string = createAck.payload.roomCode;
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);

    // --- joinRoom: both connections receive an updated presence broadcast ---
    const hostPresence = nextEvent(host, S2C.presence);
    const guest = await connect();
    const joinAck = await rpc(guest, C2S.joinRoom, { roomCode, displayName: "Guest" });
    expect(joinAck.ok).toBe(true);
    expect(joinAck.payload.state.participants).toHaveLength(2);
    const presence = await hostPresence;
    expect(presence.payload.participants).toHaveLength(2);

    // --- setTask (host): broadcast taskUpdated to the guest ---
    const guestTask = nextEvent(guest, S2C.taskUpdated);
    host.send(
      JSON.stringify({
        kind: ENVELOPE_KIND.request,
        event: C2S.setTask,
        payload: { roomCode, description: "Estimate the widget" },
      }),
    );
    const task = await guestTask;
    expect(task.payload.task).toMatchObject({ description: "Estimate the widget" });

    // --- castVote (guest): presence shows the voted dot, never the value ---
    const votedPresence = nextEvent(host, S2C.presence);
    guest.send(
      JSON.stringify({
        kind: ENVELOPE_KIND.request,
        event: C2S.castVote,
        payload: { roomCode, cardValue: 5 },
      }),
    );
    const voted = await votedPresence;
    const guestEntry = voted.payload.participants.find((p: any) => p.displayName === "Guest");
    expect(guestEntry.hasVoted).toBe(true);
    expect(guestEntry).not.toHaveProperty("cardValue");

    // --- reveal (host): both sides get the values + stats ---
    const revealed = nextEvent(guest, S2C.revealed);
    host.send(
      JSON.stringify({
        kind: ENVELOPE_KIND.request,
        event: C2S.reveal,
        payload: { roomCode },
      }),
    );
    const reveal = await revealed;
    expect(reveal.payload.stats).toMatchObject({ min: 5, max: 5, average: 5, allAgree: true });

    // --- disconnect: closing the guest removes it and re-broadcasts presence ---
    const afterLeave = nextEvent(host, S2C.presence);
    guest.close();
    const left = await afterLeave;
    expect(left.payload.participants).toHaveLength(1);
  });

  it("rejects a join for an unknown room via the ack channel", async () => {
    const sock = await connect();
    const ack = await rpc(sock, C2S.joinRoom, { roomCode: "ZZZZZZ", displayName: "Nobody" });
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("ROOM_NOT_FOUND");
  });

  it("closes the connection (1009) on an oversized frame", async () => {
    const sock = await connect();
    const closed = new Promise<number>((resolve) => sock.on("close", (code) => resolve(code)));
    sock.send("x".repeat(100_001)); // > MAX_FRAME_BYTES (100_000)
    expect(await closed).toBe(1009);
  });

  it("survives malformed and unknown-event frames without crashing", async () => {
    const sock = await connect();
    sock.send("{ not valid json");
    sock.send(JSON.stringify({ kind: ENVELOPE_KIND.request, event: "bogus", payload: {} }));
    // The server is still responsive: a fresh request still acks.
    const ack = await rpc(sock, C2S.createRoom, { displayName: "Survivor" });
    expect(ack.ok).toBe(true);
  });
});
