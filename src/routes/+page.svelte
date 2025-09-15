<script lang="ts">
    import { onMount } from "svelte";
    import {
        photoStore,
        filteredPhotos,
        selectedPhoto,
        viewMode,
        isLoading,
    } from "../lib/stores/photoStore.js";
    import { HologramAPI } from "../lib/api.js";
    import PhotoGrid from "../lib/components/PhotoGrid.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import type { PhotoFilter } from "../lib/types.js";
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
        const currentMode = $viewMode;
        if (currentMode === "grid") {
            photoStore.setViewMode("list");
        } else {
            photoStore.setViewMode("grid");
        }
    }
</script>

<svelte:head>
    <title>Hologram - Professional Photo Management</title>
</svelte:head>

<div class="app">
    {#if showWelcome && $filteredPhotos.length === 0}
        <!-- Welcome Screen -->
        <div class="welcome-screen">
            <div class="welcome-content">
                <div class="welcome-header">
                    <div class="logo">
                        <div class="logo-icon">📸</div>
                        <h1>Hologram</h1>
                    </div>
                    <p class="tagline">
                        Pro-grade photo management for photographers who want
                        total control over their files
                    </p>
                </div>

                <div class="welcome-features">
                    <div class="feature">
                        <h3>RAW+JPEG Workflows</h3>
                        <p>
                            Automatically pair RAW and JPEG files for seamless
                            comparison and organization
                        </p>
                    </div>
                    <div class="feature">
                        <h3>EXIF-Based Filtering</h3>
                        <p>
                            Filter by camera, lens, exposure settings, and more
                            with professional precision
                        </p>
                    </div>
                    <div class="feature">
                        <h3>Local Processing</h3>
                        <p>
                            Your files stay on your machine. No cloud, no
                            subscriptions, just pure control
                        </p>
                    </div>
                </div>

                <div class="welcome-cta">
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
        <div class="main-layout">
            <Sidebar photos={$filteredPhotos} onFilter={handleFilter} />

            <div class="content-area">
                {#if $isLoading}
                    <div class="loading-screen">
                        <Loader2 size={32} class="animate-spin" />
                        <p>Processing photos...</p>
                    </div>
                {:else if $filteredPhotos.length === 0}
                    <div class="empty-state">
                        <div class="empty-icon">📁</div>
                        <h3>No photos found</h3>
                        <p>Try adjusting your filters or import a new folder</p>
                    </div>
                {:else}
                    <!-- Toolbar -->
                    <div class="toolbar">
                        <div class="toolbar-left">
                            <h2>Photos ({$filteredPhotos.length})</h2>
                        </div>
                        <div class="toolbar-right">
                            <button
                                class="view-toggle"
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
                    <div class="photo-content">
                        <PhotoGrid photos={$filteredPhotos} />
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    <!-- Photo Viewer Modal -->
    {#if $selectedPhoto && $viewMode === "viewer"}
        <PhotoViewer photo={$selectedPhoto} photos={$filteredPhotos} />
    {/if}
</div>

<style>
    @reference "../app.css";

    .app {
        @apply h-screen flex;
    }

    .welcome-screen {
        @apply flex-1 flex;
    }

    .welcome-content {
        @apply flex-1 flex flex-col items-center justify-center p-8 text-center;
    }

    .welcome-header {
        @apply mb-12;
    }

    .logo {
        @apply flex flex-col items-center mb-6;
    }

    .logo-icon {
        @apply text-6xl mb-4;
    }

    .logo h1 {
        @apply text-4xl font-bold text-gray-900 dark:text-gray-100;
        margin: 0;
    }

    .tagline {
        @apply text-xl text-gray-600 dark:text-gray-400 max-w-2xl;
    }

    .welcome-features {
        @apply grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mb-12;
    }

    .feature {
        @apply text-center;
    }

    .feature h3 {
        @apply text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2;
        margin: 0;
    }

    .feature p {
        @apply text-gray-600 dark:text-gray-400;
    }

    .welcome-cta {
        @apply text-gray-500 dark:text-gray-400;
    }

    .main-layout {
        @apply flex flex-1;
    }

    .content-area {
        @apply flex-1 flex flex-col;
    }

    .loading-screen {
        @apply flex-1 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400;
    }

    .loading-screen p {
        @apply mt-4 text-lg;
    }

    .empty-state {
        @apply flex-1 flex flex-col items-center justify-center text-center;
    }

    .empty-icon {
        @apply text-6xl mb-4;
    }

    .empty-state h3 {
        @apply text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2;
        margin: 0;
    }

    .empty-state p {
        @apply text-gray-600 dark:text-gray-400;
    }

    .toolbar {
        @apply flex items-center justify-between p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700;
    }

    .toolbar h2 {
        @apply text-lg font-semibold text-gray-900 dark:text-gray-100;
        margin: 0;
    }

    .view-toggle {
        @apply p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors;
    }

    .photo-content {
        @apply flex-1 overflow-y-auto;
    }
</style>
