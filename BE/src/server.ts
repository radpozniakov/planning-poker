import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { logger } from "./lib/logger";

const PORT = Number(process.env.PORT ?? 3000);

const { app, injectWebSocket, registry, connections, reaper } = createApp();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info({ port: PORT }, "server listening");
});

// Attach the WS upgrade handler to the node server created by @hono/node-server.
injectWebSocket(server);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutdown initiated");
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

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandledRejection");
  process.exit(1);
});
