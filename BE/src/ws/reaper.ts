import type { RoomRegistry } from "../domain/rooms";
import type { ConnectionRegistry } from "./connection-registry";

/** How often the idle sweep runs (ms). The TTL itself lives in `LIMITS.roomIdleTtlMs`. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Start the idle-room sweep: every interval, ask the domain which rooms have gone idle
 * past their TTL AND have no live connection left (`reapExpired`), then close any orphaned
 * sockets each one left behind. The liveness check (`connections.isLive`) is passed *in* as
 * a predicate over opaque connectionIds, so the domain stays socket-free (ADR-001) — it
 * hands back connectionIds, and only this transport-layer loop touches sockets. The handle
 * is `.unref()`'d so it never keeps the process alive, and returned so `server.ts` can
 * `clearInterval` it on shutdown.
 */
export function startIdleReaper(
  registry: RoomRegistry,
  connections: ConnectionRegistry,
): ReturnType<typeof setInterval> {
  const isLive = (cid: string) => connections.isLive(cid);
  const handle = setInterval(() => {
    for (const { connectionIds } of registry.reapExpired(Date.now(), isLive)) {
      connections.closeConnections(connectionIds);
    }
  }, SWEEP_INTERVAL_MS);
  handle.unref();
  return handle;
}
