<script>
  let { children } = $props();
  import "../app.css";
</script>

<div class="h-screen bg-gray-500 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
  {@render children()}
</div>
