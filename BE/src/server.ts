import { createServer } from "node:http";
import { createSocketServer } from "./handlers";
import { RoomRegistry } from "./rooms";

const PORT = Number(process.env.PORT ?? 3000);

const registry = new RoomRegistry();

const httpServer = createServer((req, res) => {
  // Tiny health endpoint for container/proxy probes; everything else is WS.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: registry.roomCount }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

const io = createSocketServer(httpServer, registry);

httpServer.listen(PORT, () => {
  console.log(`[planning-picker] listening on :${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`[planning-picker] ${signal} received — shutting down`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Don't hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
