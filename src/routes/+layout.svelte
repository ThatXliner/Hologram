<script>
  let { children } = $props();
  import "../app.css";
</script>

<div class="h-screen text-gray-900">
  {@render children()}
</div>
