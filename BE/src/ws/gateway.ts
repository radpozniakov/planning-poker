import type { Context } from "hono";
import type { WSContext, WSMessageReceive } from "hono/ws";
import type { RoomRegistry } from "../domain/rooms";
import type { ConnectionRegistry } from "./connection-registry";
import { decodeClientFrame, MAX_FRAME_BYTES } from "./envelope";
import { dispatch, handleDisconnect } from "./router";

/**
 * The ONE place the WebSocket transport lives on the server (the old ADR-001 boundary,
 * now native WS instead of socket.io). Mints a connectionId on open, parses + dispatches
 * each frame, and runs the disconnect path on close. Everything below speaks the
 * `@pp/shared` envelope contract; the registries never see a socket type beyond `Sendable`.
 */
export function createWsHandler(
  registry: RoomRegistry,
  connections: ConnectionRegistry,
) {
  // The factory runs once per connection, so `connectionId` is per-connection state.
  return (_c: Context) => {
    let connectionId: string | null = null;

    return {
      onOpen(_evt: Event, ws: WSContext) {
        connectionId = connections.register(ws);
      },

      // `evt` is typed structurally (not as the DOM `MessageEvent`, which is absent from
      // the node lib) so only `.data` is depended on.
      onMessage(evt: { data: WSMessageReceive }, ws: WSContext) {
        if (connectionId === null) return;
        const raw = evt.data;

        // Frame-size abuse guard, checked on the raw frame before any decode/parse (replaces
        // socket.io maxHttpBufferSize). Unknown/binary frame types fail CLOSED — the protocol
        // is JSON text only, so anything unrecognized is treated as oversized and rejected.
        const byteSize =
          typeof raw === "string"
            ? Buffer.byteLength(raw, "utf8")
            : raw instanceof ArrayBuffer
              ? raw.byteLength
              : Number.POSITIVE_INFINITY;
        if (byteSize > MAX_FRAME_BYTES) {
          ws.close(1009, "message too large");
          return;
        }

        const text =
          typeof raw === "string"
            ? raw
            : new TextDecoder().decode(raw as ArrayBuffer);
        if (!text) return;

        const decoded = decodeClientFrame(text);
        // Malformed frames are dropped: a pre-handshake client has no correlation id and
        // no room, so there is no meaningful channel to report a protocol error on.
        if (!decoded.ok) return;

        dispatch(connectionId, decoded.envelope, registry, connections);
      },

      onClose() {
        if (connectionId === null) return;
        handleDisconnect(connectionId, registry, connections);
        connectionId = null;
      },
    };
  };
}
