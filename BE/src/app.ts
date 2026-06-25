import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { RoomRegistry } from "./domain/rooms";
import { registerHealthRoute } from "./http/health";
import { ConnectionRegistry } from "./ws/connection-registry";
import { createWsHandler } from "./ws/gateway";

export interface AppDeps {
  registry: RoomRegistry;
  connections: ConnectionRegistry;
}

export interface BuiltApp {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  registry: RoomRegistry;
  connections: ConnectionRegistry;
}

/**
 * Build the Hono app and its WebSocket wiring. Dependencies are injectable so integration
 * tests can supply (and inspect) their own registries. `server.ts` calls this with none.
 */
export function createApp(deps: Partial<AppDeps> = {}): BuiltApp {
  const registry = deps.registry ?? new RoomRegistry();
  const connections = deps.connections ?? new ConnectionRegistry(registry);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  registerHealthRoute(app, registry);
  app.get("/ws", upgradeWebSocket(createWsHandler(registry, connections)));

  return { app, injectWebSocket, registry, connections };
}
