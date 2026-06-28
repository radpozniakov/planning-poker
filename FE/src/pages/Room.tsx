import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LIMITS,
  type CardValue,
  type ErrorEventPayload,
  type HostChangedPayload,
  type PresencePayload,
  type RevealedPayload,
  type TaskUpdatedPayload,
} from "@pp/shared";
import {
  castVote,
  connectSocket,
  disconnectSocket,
  registerServerHandlers,
  reset,
  reveal,
  setTask,
  joinRoom,
} from "@/lib/socket";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import {
  applyHostChanged,
  applyPresence,
  applyRevealed,
  applyRoomState,
  applyRoundReset,
  applyTaskUpdated,
  getSnapshot,
  isHost,
  resetStore,
  setConnected,
  setError,
  setMyCard,
  setMyParticipantId,
  votedCount,
} from "@/lib/store";
import { useConnected, useRoomStore } from "@/lib/useRoomStore";
import { TaskBar } from "@/components/TaskBar";
import { ParticipantList } from "@/components/ParticipantList";
import { Deck } from "@/components/Deck";
import { StatsPanel } from "@/components/StatsPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import styles from "./Room.module.css";

export default function Room() {
  const navigate = useNavigate();
  const params = useParams();
  const roomCode = (params.roomCode ?? "").toUpperCase();

  const store = useRoomStore();
  useConnected();

  const [needsName, setNeedsName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tracks the last room we reset for, so the pre-join reset fires once per REAL room
  // change and never on a StrictMode same-room remount.
  const prevRoom = useRef<string | null>(null);
  // The display name we (re)join with. Retained so a transient socket reconnect can
  // silently re-join the room.
  const joinName = useRef<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Re-entrancy guard for doJoin, read synchronously (avoids stale-closure `joining`).
  const joiningRef = useRef(false);
  // Lets the name-gate submit handler invoke the effect's closure-bound joinWithKnownName.
  const joinRef = useRef<(() => void) | null>(null);

  const host = isHost(store);
  const voted = votedCount(store);

  // Auto-dismiss the error toast a few seconds after it appears.
  useEffect(() => {
    if (store.lastError) {
      clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setError(null), 4000);
    }
    return () => {
      clearTimeout(errorTimer.current);
    };
  }, [store.lastError]);

  function onNameSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    joinName.current = name;
    joinRef.current?.();
  }

  function onPick(value: CardValue): void {
    if (store.revealed) return;
    setMyCard(value);
    castVote(roomCode, value);
  }

  function onSetTask(description: string): void {
    setTask(roomCode, description);
  }

  function onReveal(): void {
    reveal(roomCode);
  }

  function onReset(): void {
    reset(roomCode);
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy the link.");
    }
  }

  /**
   * Explicit leave: close the singleton socket so the BE's disconnect path runs
   * `leave()` and broadcasts updated presence to the others right away (the protocol
   * has no client `leave` event — departure is signalled only by the socket closing).
   * Reset `prevRoom` so re-entering the SAME room re-triggers the pre-join `resetStore`
   * instead of being short-circuited by the ref guard. The next room mount lazily
   * reopens a fresh socket via `connectSocket()`.
   */
  function onLeave(): void {
    disconnectSocket();
    resetStore();
    prevRoom.current = null;
    navigate("/");
  }

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Ref-guarded reset BEFORE join. Fires once per REAL room change, never on a
    // StrictMode same-room remount (prevRoom already equals roomCode then), and NEVER
    // in cleanup. Clears room-A residue before joining room B.
    if (prevRoom.current !== roomCode) {
      resetStore();
      prevRoom.current = roomCode;
    }

    async function doJoin(
      displayName: string,
      participantId?: string,
    ): Promise<void> {
      if (joiningRef.current) return;
      joiningRef.current = true;
      setJoining(true);
      setError(null);
      try {
        const result = await joinRoom({
          roomCode,
          displayName,
          participantId: participantId || undefined,
        });
        if (result.ok) {
          setMyParticipantId(result.participantId);
          applyRoomState(result.state);
          saveSession({
            participantId: result.participantId,
            displayName,
            roomCode,
          });
          setNeedsName(false);
        } else {
          // Stale participant/session for a room that no longer exists, etc.
          if (result.error.code === "ROOM_NOT_FOUND") {
            clearSession();
          }
          setError(result.error.message);
          setNeedsName(true);
        }
      } catch {
        setError("Could not reach the server.");
        setNeedsName(true);
      } finally {
        joiningRef.current = false;
        setJoining(false);
      }
    }

    /** Join/re-join using the known name, reusing the BE's idempotent rebind path. */
    function joinWithKnownName(): void {
      if (!joinName.current) return;
      const stored = loadSession(roomCode);
      // Read the live participantId from the store snapshot (not the effect-captured
      // `store`, which would be stale after the pre-join reset) so a reconnect rebinds
      // onto the existing participant.
      void doJoin(
        joinName.current,
        getSnapshot().myParticipantId ?? stored?.participantId,
      );
    }

    // Expose so the name-gate submit handler can trigger a join with the current closure.
    joinRef.current = joinWithKnownName;

    const session = loadSession(roomCode);
    if (session?.displayName) joinName.current = session.displayName;
    else setNeedsName(true);

    // No `roomState` listener: the join/reconnect snapshot arrives on the joinRoom ack
    // (see doJoin), never as a broadcast.
    const cleanup = registerServerHandlers(
      {
        presence: (p: PresencePayload) => applyPresence(p),
        taskUpdated: (p: TaskUpdatedPayload) => applyTaskUpdated(p),
        revealed: (p: RevealedPayload) => applyRevealed(p),
        roundReset: () => applyRoundReset(),
        hostChanged: (p: HostChangedPayload) => applyHostChanged(p),
        errorEvent: (p: ErrorEventPayload) => {
          // A vote that raced past a reveal is rejected server-side; drop the stale pick.
          if (p.code === "ALREADY_REVEALED") setMyCard(null);
          setError(p.message);
        },
      },
      {
        // Re-join on every (re)connect so a transient socket drop silently rebinds via the
        // BE's idempotent reconnect path (preserves joinedAt + host).
        onConnect: () => {
          setConnected(true);
          joinWithKnownName();
        },
        onDisconnect: () => setConnected(false),
      },
    );

    // Singleton may ALREADY be open (arrived right after createRoom, or StrictMode
    // remount). connectHooks only fire on a real 'open', so handle the already-open
    // case at the call site. BE rebind is idempotent (reuses participantId), so a
    // double-join is a harmless safety net.
    const s = connectSocket();
    if (s?.connected) joinWithKnownName();

    return () => {
      cleanup(); // remove ONLY this effect's handlers. No resetStore, no disconnect.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  return (
    <>
      <div className={styles.room}>
        <div className={styles.roomTop}>
          <div className={styles.roomCode}>
            <span className={styles.label}>Room</span>
            <span className={styles.code}>{roomCode}</span>
          </div>
          <div className={styles.roomTopActions}>
            <Button variant="secondary" type="button" onClick={copyLink}>
              {copied ? "Copied ✓" : "Copy link"}
            </Button>
            <Button variant="secondary" type="button" onClick={onLeave}>
              Leave
            </Button>
          </div>
        </div>

        {needsName ? (
          <div className={styles.nameGate}>
            <h2>Join room {roomCode}</h2>
            <form onSubmit={onNameSubmit}>
              <label className={styles.field}>
                <span>Your name</span>
                <Input
                  type="text"
                  placeholder="e.g. Jordan"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={LIMITS.displayNameMax}
                  autoComplete="off"
                />
              </label>
              <Button type="submit" disabled={!nameInput.trim() || joining}>
                {joining ? "Joining…" : "Join"}
              </Button>
            </form>
          </div>
        ) : store.myParticipantId ? (
          <>
            <TaskBar task={store.task} isHost={host} onSetTask={onSetTask} />

            <section className={styles.grid}>
              <div className={styles.left}>
                <div className={styles.sectionHead}>
                  <h2>Participants</h2>
                  {!store.revealed && (
                    <span className={styles.muted}>
                      {voted}/{store.participants.length} voted
                    </span>
                  )}
                </div>
                <ParticipantList
                  participants={store.participants}
                  myId={store.myParticipantId}
                  revealed={store.revealed}
                  votes={store.votes}
                />
              </div>

              <div className={styles.right}>
                <div className={styles.deckWrap}>
                  <div className={styles.sectionHead}>
                    <h2>Your vote</h2>
                    {store.revealed && (
                      <span className={styles.muted}>Votes revealed</span>
                    )}
                  </div>
                  <Deck
                    selected={store.myCard}
                    disabled={store.revealed}
                    onPick={onPick}
                  />
                </div>

                {store.revealed && store.stats && (
                  <StatsPanel stats={store.stats} />
                )}

                {host && (
                  <div className={styles.hostControls}>
                    <Button
                      type="button"
                      onClick={onReveal}
                      disabled={store.revealed}
                    >
                      Reveal
                    </Button>
                    <Button variant="secondary" type="button" onClick={onReset}>
                      Reset
                    </Button>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : (
          <p className={styles.connecting}>Connecting…</p>
        )}
      </div>

      {store.lastError && (
        <div className={styles.toast} role="alert">
          {store.lastError}
        </div>
      )}
    </>
  );
}
