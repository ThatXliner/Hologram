<script lang="ts">
    import { onMount } from "svelte";
    import {
        photoStore,
        filteredPhotos,
        viewMode,
        isLoading,
    } from "../lib/stores/photoStore.ts";
    import { HologramAPI } from "../lib/api.ts";
    import PhotoGrid from "../lib/components/PhotoGrid.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import type { PhotoFilter } from "../lib/types.ts";
    import { Loader2, Grid, List } from "@lucide/svelte";

    let showWelcome = $state(true);

    onMount(() => {
        // Check if we have photos already loaded
        if ($filteredPhotos.length > 0) {
            showWelcome = false;
        }
    });

    async function handleFilter(filter: PhotoFilter) {
        photoStore.setLoading(true);
        try {
            const photos = photoStore.photos || [];
            const filtered = await HologramAPI.filterPhotos(photos, filter);
            photoStore.setFilteredPhotos(filtered);
            photoStore.setFilter(filter);
        } catch (error) {
            console.error("Failed to filter photos:", error);
        } finally {
            photoStore.setLoading(false);
        }
    }

    function handlePhotosImported() {
        showWelcome = false;
    }

    function toggleViewMode() {
        if ($viewMode === "grid") {
            photoStore.setViewMode("list");
        } else {
            photoStore.setViewMode("grid");
        }
    }
</script>

<svelte:head>
    <title>Hologram - Professional Photo Management</title>
</svelte:head>

<div class="h-screen flex">
    {#if showWelcome && $filteredPhotos.length === 0}
        <!-- Welcome Screen -->
        <div class="flex-1 flex">
            <div
                class="flex-1 flex flex-col items-center justify-center p-8 text-center"
            >
                <div class="mb-12">
                    <div class="flex flex-col items-center mb-6">
                        <div class="text-6xl mb-4">📸</div>
                        <h1
                            class="text-4xl font-bold text-amber-900"
                            style="margin: 0;"
                        >
                            Hologram
                        </h1>
                    </div>
                    <p class="text-xl text-amber-700 max-w-2xl">
                        Pro-grade photo management for photographers who want
                        total control over their files
                    </p>
                </div>

                <div
                    class="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mb-12"
                >
                    <div class="text-center">
                        <h3
                            class="text-lg font-semibold text-amber-900 mb-2"
                            style="margin: 0;"
                        >
                            RAW+JPEG Workflows
                        </h3>
                        <p class="text-amber-700">
                            Automatically pair RAW and JPEG files for seamless
                            comparison and organization
                        </p>
                    </div>
                    <div class="text-center">
                        <h3
                            class="text-lg font-semibold text-amber-900 mb-2"
                            style="margin: 0;"
                        >
                            EXIF-Based Filtering
                        </h3>
                        <p class="text-amber-700">
                            Filter by camera, lens, exposure settings, and more
                            with professional precision
                        </p>
                    </div>
                    <div class="text-center">
                        <h3
                            class="text-lg font-semibold text-amber-900 mb-2"
                            style="margin: 0;"
                        >
                            Local Processing
                        </h3>
                        <p class="text-amber-700">
                            Your files stay on your machine. No cloud, no
                            subscriptions, just pure control
                        </p>
                    </div>
                </div>

                <div class="text-amber-600">
                    <p>
                        Get started by importing your first photo folder using
                        the sidebar.
                    </p>
                </div>
            </div>

            <!-- Sidebar always visible -->
            <Sidebar photos={$filteredPhotos} onFilter={handleFilter} />
        </div>
    {:else}
        <!-- Main Application -->
        <div class="flex flex-1">
            <Sidebar photos={$filteredPhotos} onFilter={handleFilter} />

            <div class="flex-1 flex flex-col">
                {#if $isLoading}
                    <div
                        class="flex-1 flex flex-col items-center justify-center text-amber-600"
                    >
                        <Loader2 size={32} class="animate-spin" />
                        <p class="mt-4 text-lg">Processing photos...</p>
                    </div>
                {:else if $filteredPhotos.length === 0}
                    <div
                        class="flex-1 flex flex-col items-center justify-center text-center"
                    >
                        <div class="text-6xl mb-4">📁</div>
                        <h3
                            class="text-xl font-semibold text-amber-900 mb-2"
                            style="margin: 0;"
                        >
                            No photos found
                        </h3>
                        <p class="text-amber-700">
                            Try adjusting your filters or import a new folder
                        </p>
                    </div>
                {:else}
                    <!-- Toolbar -->
                    <div
                        class="flex items-center justify-between p-4 bg-stone-50 border-b border-amber-200"
                    >
                        <div>
                            <h2
                                class="text-lg font-semibold text-amber-900"
                                style="margin: 0;"
                            >
                                Photos ({$filteredPhotos.length})
                            </h2>
                        </div>
                        <div>
                            <button
                                class="p-2 text-amber-600 hover:text-amber-800 hover:bg-amber-100 rounded-md transition-colors"
                                onclick={toggleViewMode}
                            >
                                {#if $viewMode === "grid"}
                                    <List size={16} />
                                {:else}
                                    <Grid size={16} />
                                {/if}
                            </button>
                        </div>
                    </div>

                    <!-- Photo Grid -->
                    <div class="flex-1 overflow-y-auto">
                        <PhotoGrid photos={$filteredPhotos} />
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    <!-- Photo Viewer Modal -->
    {#if $viewMode === "viewer"}
        <PhotoViewer photos={$filteredPhotos} />
    {/if}
</div>
