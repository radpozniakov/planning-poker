import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { RoomRegistry } from "./domain/rooms";
import { registerHealthRoute } from "./http/health";
import { ConnectionRegistry } from "./ws/connection-registry";
import { createWsHandler } from "./ws/gateway";
import { startIdleReaper } from "./ws/reaper";

export interface AppDeps {
  registry: RoomRegistry;
  connections: ConnectionRegistry;
}

export interface BuiltApp {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  registry: RoomRegistry;
  connections: ConnectionRegistry;
  /** Idle-room sweep handle; `server.ts` clears it on shutdown. Already `.unref()`'d. */
  reaper: ReturnType<typeof setInterval>;
}

/**
 * Build the Hono app and its WebSocket wiring. Dependencies are injectable so integration
 * tests can supply (and inspect) their own registries. `server.ts` calls this with none.
 */
export function createApp(deps: Partial<AppDeps> = {}): BuiltApp {
  // When a grace-deletion timer fires for an abandoned room, close any sockets it orphaned.
  // Late-bound via a holder so the registry (constructed first) can call back into the
  // connection registry (constructed second) — neither default dep can reference the other
  // at construction time. For a solo-host refresh this never fires (the rejoin cancels it).
  let connectionsRef: ConnectionRegistry | undefined;
  const registry =
    deps.registry ??
    new RoomRegistry(undefined, (_roomCode, connectionIds) => {
      connectionsRef?.closeConnections(connectionIds);
    });
  const connections = deps.connections ?? new ConnectionRegistry(registry);
  connectionsRef = connections;

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  registerHealthRoute(app, registry);
  app.get("/ws", upgradeWebSocket(createWsHandler(registry, connections)));

  const reaper = startIdleReaper(registry, connections);

  return { app, injectWebSocket, registry, connections, reaper };
}
