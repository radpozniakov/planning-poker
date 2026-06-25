<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
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
    registerServerHandlers,
    reset,
    reveal,
    setTask,
    joinRoom,
  } from "$lib/socket";
  import { clearSession, loadSession, saveSession } from "$lib/session";
  import {
    applyHostChanged,
    applyPresence,
    applyRevealed,
    applyRoomState,
    applyRoundReset,
    applyTaskUpdated,
    isHost,
    setConnected,
    setError,
    setMyCard,
    setMyParticipantId,
    store,
    votedCount,
  } from "$lib/store.svelte";
  import TaskBar from "$lib/components/TaskBar.svelte";
  import ParticipantList from "$lib/components/ParticipantList.svelte";
  import Deck from "$lib/components/Deck.svelte";
  import StatsPanel from "$lib/components/StatsPanel.svelte";

  const roomCode = $derived((page.params.roomCode ?? "").toUpperCase());

  let needsName = $state(false);
  let nameInput = $state("");
  let joining = $state(false);
  let copied = $state(false);
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => void) | undefined;

  const host = $derived(isHost());
  const voted = $derived(votedCount());

  // Auto-dismiss the error toast a few seconds after it appears.
  $effect(() => {
    if (store.lastError) {
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => setError(null), 4000);
    }
  });

  // The display name we (re)join with. Set from the stored session or the name gate;
  // retained so a transient socket reconnect can silently re-join the room.
  let joinName: string | null = null;

  async function doJoin(displayName: string, participantId?: string): Promise<void> {
    if (joining) return;
    joining = true;
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
        needsName = false;
      } else {
        // Stale participant/session for a room that no longer exists, etc.
        if (result.error.code === "ROOM_NOT_FOUND") {
          clearSession();
        }
        setError(result.error.message);
        needsName = true;
      }
    } catch {
      setError("Could not reach the server.");
      needsName = true;
    } finally {
      joining = false;
    }
  }

  /** Join/re-join using the known name, reusing the BE's idempotent rebind path. */
  function joinWithKnownName(): void {
    if (!joinName) return;
    const stored = loadSession(roomCode);
    void doJoin(joinName, store.myParticipantId ?? stored?.participantId);
  }

  function onNameSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    joinName = name;
    joinWithKnownName();
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
    if (!browser) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      setError("Could not copy the link.");
    }
  }

  onMount(() => {
    if (!browser) return;

    const session = loadSession(roomCode);
    if (session?.displayName) {
      joinName = session.displayName;
    } else {
      needsName = true;
    }

    // No `roomState` listener: the join/reconnect snapshot arrives on the joinRoom ack
    // (see doJoin), never as a broadcast.
    cleanup = registerServerHandlers(
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
        // BE's idempotent reconnect path (preserves joinedAt + host). See MAJOR-1.
        onConnect: () => {
          setConnected(true);
          joinWithKnownName();
        },
        onDisconnect: () => setConnected(false),
      },
    );

    // The socket is a singleton; arriving here right after creating a room means it is
    // already connected, so `connect` won't fire again — join immediately in that case.
    const s = connectSocket();
    if (s?.connected) joinWithKnownName();
  });

  onDestroy(() => {
    clearTimeout(errorTimer);
    cleanup?.();
  });
</script>

<div class="room">
  <div class="room-top">
    <div class="room-code">
      <span class="label">Room</span>
      <span class="code">{roomCode}</span>
    </div>
    <div class="room-top-actions">
      <button class="btn" type="button" onclick={copyLink}>
        {copied ? "Copied ✓" : "Copy link"}
      </button>
      <button
        class="btn"
        type="button"
        onclick={() => goto("/")}
      >
        Leave
      </button>
    </div>
  </div>

  {#if needsName}
    <div class="name-gate card-surface">
      <h2>Join room {roomCode}</h2>
      <form onsubmit={onNameSubmit}>
        <label class="field">
          <span>Your name</span>
          <input
            class="input"
            type="text"
            placeholder="e.g. Jordan"
            bind:value={nameInput}
            maxlength={LIMITS.displayNameMax}
            autocomplete="off"
          />
        </label>
        <button
          class="btn btn-primary"
          type="submit"
          disabled={!nameInput.trim() || joining}
        >
          {joining ? "Joining…" : "Join"}
        </button>
      </form>
    </div>
  {:else if store.myParticipantId}
    <TaskBar task={store.task} isHost={host} onsettask={onSetTask} />

    <section class="grid">
      <div class="left card-surface">
        <div class="section-head">
          <h2>Participants</h2>
          {#if !store.revealed}
            <span class="muted">{voted}/{store.participants.length} voted</span>
          {/if}
        </div>
        <ParticipantList
          participants={store.participants}
          myId={store.myParticipantId}
          revealed={store.revealed}
          votes={store.votes}
        />
      </div>

      <div class="right">
        <div class="deck-wrap card-surface">
          <div class="section-head">
            <h2>Your vote</h2>
            {#if store.revealed}
              <span class="muted">Votes revealed</span>
            {/if}
          </div>
          <Deck
            selected={store.myCard}
            disabled={store.revealed}
            onpick={onPick}
          />
        </div>

        {#if store.revealed && store.stats}
          <StatsPanel stats={store.stats} />
        {/if}

        {#if host}
          <div class="host-controls card-surface">
            <button
              class="btn btn-primary"
              type="button"
              onclick={onReveal}
              disabled={store.revealed}
            >
              Reveal
            </button>
            <button class="btn" type="button" onclick={onReset}>Reset</button>
          </div>
        {/if}
      </div>
    </section>
  {:else}
    <p class="connecting">Connecting…</p>
  {/if}
</div>

{#if store.lastError}
  <div class="toast" role="alert">{store.lastError}</div>
{/if}

<style>
  .room {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .room-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .room-code {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .room-code .label {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .room-code .code {
    font-size: var(--font-size-xl);
    font-weight: 800;
    letter-spacing: 0.15em;
  }

  .room-top-actions {
    display: flex;
    gap: var(--space-3);
  }

  .grid {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: var(--space-5);
    align-items: start;
  }

  .left,
  .deck-wrap,
  .host-controls {
    padding: var(--space-5);
  }

  .right {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-4);
  }

  .section-head h2 {
    font-size: var(--font-size-lg);
  }

  .muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .host-controls {
    display: flex;
    gap: var(--space-3);
  }

  .name-gate {
    max-width: 420px;
    margin: var(--space-6) auto;
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .name-gate form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .field span {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .connecting {
    text-align: center;
    color: var(--color-text-muted);
    padding: var(--space-6);
  }

  .toast {
    position: fixed;
    bottom: var(--space-5);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-md);
    background: var(--color-danger);
    color: #fff;
    box-shadow: var(--shadow-md);
    z-index: 50;
  }

  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
