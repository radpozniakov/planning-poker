<script lang="ts">
  import type { CardValue } from "@pp/shared";

  interface Props {
    value: CardValue;
    selected: boolean;
    disabled: boolean;
    onpick: () => void;
  }

  let { value, selected, disabled, onpick }: Props = $props();
</script>

<button
  type="button"
  class="card"
  class:selected
  {disabled}
  aria-pressed={selected}
  aria-label={`Pick ${value}`}
  onclick={onpick}
>
  <span class="face">{value}</span>
</button>

<style>
  .card {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 92px;
    border: 2px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    font-size: var(--font-size-lg);
    font-weight: 700;
    box-shadow: var(--shadow-sm);
    transition:
      transform 0.1s ease,
      border-color 0.15s ease,
      background 0.15s ease;
  }

  .card:hover:not(:disabled) {
    transform: translateY(-4px);
    border-color: var(--color-primary);
  }

  .card.selected {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #fff;
    transform: translateY(-4px);
  }

  .card:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .face {
    pointer-events: none;
  }
</style>
