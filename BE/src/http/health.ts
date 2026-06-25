import type { Hono } from "hono";
import type { RoomRegistry } from "../domain/rooms";

/** Tiny health endpoint for container/proxy probes (parity with the old node:http route). */
export function registerHealthRoute(app: Hono, registry: RoomRegistry): void {
  app.get("/health", (c) => c.json({ status: "ok", rooms: registry.roomCount }));
}
