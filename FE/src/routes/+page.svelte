<script lang="ts">
  import { goto } from "$app/navigation";
  import { LIMITS } from "@pp/shared";
  import { createRoom } from "$lib/socket";
  import { saveSession } from "$lib/session";

  let createName = $state("");
  let joinCode = $state("");
  let joinName = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function onCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = createName.trim();
    if (!name || busy) return;
    busy = true;
    error = null;
    try {
      const result = await createRoom(name);
      if (result.ok) {
        saveSession({
          participantId: result.participantId,
          displayName: name,
          roomCode: result.roomCode,
        });
        await goto(`/${result.roomCode}`);
      } else {
        error = result.error.message;
      }
    } catch {
      error = "Could not reach the server. Is it running?";
    } finally {
      busy = false;
    }
  }

  function onJoin(event: SubmitEvent): void {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    const name = joinName.trim();
    if (code.length !== LIMITS.roomCodeLength || !name) return;
    // Persist the name so the room page can auto-join without re-prompting.
    saveSession({ participantId: "", displayName: name, roomCode: code });
    goto(`/${code}`);
  }

  function onCodeInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    joinCode = target.value.toUpperCase();
  }
</script>

<div class="landing">
  <header class="hero">
    <h1>Plan together, pick faster.</h1>
    <p class="subtitle">
      Real-time planning poker. Create a room, share the link, estimate as a
      team.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="actions">
    <form class="panel card-surface" onsubmit={onCreate}>
      <h2>Create a room</h2>
      <label class="field">
        <span>Your name</span>
        <input
          class="input"
          type="text"
          placeholder="e.g. Alex"
          bind:value={createName}
          maxlength={LIMITS.displayNameMax}
          autocomplete="off"
        />
      </label>
      <button
        class="btn btn-primary"
        type="submit"
        disabled={!createName.trim() || busy}
      >
        {busy ? "Creating…" : "Create room"}
      </button>
    </form>

    <form class="panel card-surface" onsubmit={onJoin}>
      <h2>Join a room</h2>
      <label class="field">
        <span>Room code</span>
        <input
          class="input code"
          type="text"
          placeholder="ABC123"
          value={joinCode}
          oninput={onCodeInput}
          maxlength={LIMITS.roomCodeLength}
          autocomplete="off"
          autocapitalize="characters"
        />
      </label>
      <label class="field">
        <span>Your name</span>
        <input
          class="input"
          type="text"
          placeholder="e.g. Sam"
          bind:value={joinName}
          maxlength={LIMITS.displayNameMax}
          autocomplete="off"
        />
      </label>
      <button
        class="btn"
        type="submit"
        disabled={joinCode.trim().length !== LIMITS.roomCodeLength ||
          !joinName.trim()}
      >
        Join room
      </button>
    </form>
  </div>
</div>

<style>
  .landing {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .hero {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .hero h1 {
    font-size: 2.25rem;
    line-height: 1.1;
  }

  .subtitle {
    color: var(--color-text-muted);
    font-size: var(--font-size-lg);
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-5);
  }

  .panel {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .panel h2 {
    font-size: var(--font-size-lg);
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

  .code {
    text-transform: uppercase;
    letter-spacing: 0.25em;
    font-weight: 700;
  }

  .error {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-danger-soft);
    color: var(--color-danger);
    text-align: center;
  }

  @media (max-width: 640px) {
    .actions {
      grid-template-columns: 1fr;
    }
  }
</style>
