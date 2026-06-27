import { serve } from "@hono/node-server";
import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? 3000);

const { app, injectWebSocket, registry, connections, reaper } = createApp();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[planning-picker] listening on :${PORT}`);
});

// Attach the WS upgrade handler to the node server created by @hono/node-server.
injectWebSocket(server);

function shutdown(signal: string): void {
  console.log(`[planning-picker] ${signal} received — shutting down`);
  // Stop the idle sweep first so it can't fire mid-shutdown.
  clearInterval(reaper);
  // Cancel any pending grace-deletion timers (the sockets are about to close anyway).
  registry.shutdown();
  // server.close() stops accepting connections but does NOT drain live WS sockets, so
  // close them explicitly (1001 = "Going Away") before closing the HTTP server.
  connections.closeAll();
  server.close(() => process.exit(0));
  // Don't hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
