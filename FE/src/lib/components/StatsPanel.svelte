<script lang="ts">
  import type { VoteStats } from "@pp/shared";

  interface Props {
    stats: VoteStats;
  }

  let { stats }: Props = $props();

  const hasNumeric = $derived(stats.numericCount > 0);

  function fmt(value: number | null): string {
    return value === null ? "—" : String(value);
  }

  function fmtAvg(value: number | null): string {
    if (value === null) return "—";
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
</script>

<div class="stats card-surface">
  {#if hasNumeric}
    <div class="grid">
      <div class="stat">
        <span class="label">Min</span>
        <span class="num">{fmt(stats.min)}</span>
      </div>
      <div class="stat">
        <span class="label">Max</span>
        <span class="num">{fmt(stats.max)}</span>
      </div>
      <div class="stat">
        <span class="label">Average</span>
        <span class="num">{fmtAvg(stats.average)}</span>
      </div>
      <div class="stat">
        <span class="label">Numeric votes</span>
        <span class="num">{stats.numericCount}</span>
      </div>
    </div>
    {#if stats.allAgree}
      <p class="agree">All agree ✅</p>
    {/if}
  {:else}
    <p class="empty">No numeric votes</p>
  {/if}
</div>

<style>
  .stats {
    padding: var(--space-5);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-4);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    text-align: center;
  }

  .label {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .num {
    font-size: var(--font-size-xl);
    font-weight: 700;
  }

  .agree {
    margin-top: var(--space-4);
    text-align: center;
    font-weight: 700;
    color: var(--color-success);
  }

  .empty {
    text-align: center;
    color: var(--color-text-muted);
  }

  @media (max-width: 520px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
