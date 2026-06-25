<script lang="ts">
  import "../app.css";

  let { children } = $props();
</script>

<div class="app-shell">
  <header class="app-header">
    <a class="brand" href="/">
      <span class="brand-mark">♠</span>
      <span class="brand-name">Planning Picker</span>
    </a>
  </header>

  <main class="app-main">
    {@render children()}
  </main>
</div>

<style>
  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .app-header {
    display: flex;
    align-items: center;
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    text-decoration: none;
    color: var(--color-text);
    font-weight: 700;
    font-size: var(--font-size-lg);
  }

  .brand-mark {
    color: var(--color-primary);
    font-size: 1.4rem;
  }

  .app-main {
    flex: 1;
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
  }
</style>
