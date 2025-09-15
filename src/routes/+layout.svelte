<script>
  let { children } = $props();
  import "../app.css";
</script>

<div class="app-layout">
  {@render children()}
</div>

<style>
    @reference "../app.css";

  .app-layout {
    @apply h-screen bg-gray-500 dark:bg-gray-900 text-gray-900 dark:text-gray-100;
  }
</style>
