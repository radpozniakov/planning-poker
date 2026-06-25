<script lang="ts">
  import { LIMITS, type Task } from "@pp/shared";

  interface Props {
    task: Task | null;
    isHost: boolean;
    onsettask: (description: string) => void;
  }

  let { task, isHost, onsettask }: Props = $props();

  let draft = $state("");

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const description = draft.trim();
    if (!description) return;
    onsettask(description);
    draft = "";
  }
</script>

<section class="taskbar card-surface">
  <div class="current">
    <span class="label">Current task</span>
    <p class="text" class:none={!task}>
      {task ? task.description : "No task yet"}
    </p>
  </div>

  {#if isHost}
    <form class="set-form" onsubmit={submit}>
      <input
        class="input"
        type="text"
        placeholder="Describe the task to estimate…"
        bind:value={draft}
        maxlength={LIMITS.taskDescriptionMax}
        aria-label="Task description"
      />
      <button class="btn btn-primary" type="submit" disabled={!draft.trim()}>
        Set task
      </button>
    </form>
  {/if}
</section>

<style>
  .taskbar {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .current {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .label {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .text {
    font-size: var(--font-size-lg);
    font-weight: 600;
  }

  .text.none {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .set-form {
    display: flex;
    gap: var(--space-3);
  }

  .set-form .input {
    flex: 1;
  }

  .set-form .btn {
    white-space: nowrap;
  }

  @media (max-width: 520px) {
    .set-form {
      flex-direction: column;
    }
  }
</style>
