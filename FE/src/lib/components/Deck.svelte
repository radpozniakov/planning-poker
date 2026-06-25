<script lang="ts">
  import { DECK, type CardValue } from "@pp/shared";
  import Card from "./Card.svelte";

  interface Props {
    selected: CardValue | null;
    disabled: boolean;
    onpick: (value: CardValue) => void;
  }

  let { selected, disabled, onpick }: Props = $props();
</script>

<div class="deck" role="group" aria-label="Voting deck">
  {#each DECK as value (value)}
    <Card
      {value}
      selected={selected === value}
      {disabled}
      onpick={() => onpick(value)}
    />
  {/each}
</div>

<style>
  .deck {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
