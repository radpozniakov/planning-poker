import { useSyncExternalStore } from "react";
import { subscribe, getSnapshot, type RoomStore } from "./store";
import { subscribeConnection, connectionHandle } from "./socket";

/** Subscribe a component to the framework-agnostic room store. */
export function useRoomStore(): RoomStore {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Live connection flag, read straight from the socket module's handle (the source
 * of truth) rather than the store, so it reflects real socket open/close transitions.
 */
export function useConnected(): boolean {
  return useSyncExternalStore(
    subscribeConnection,
    () => connectionHandle.connected,
    () => false,
  );
}
