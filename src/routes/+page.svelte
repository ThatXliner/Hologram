<script lang="ts">
    import { onMount } from "svelte";
    import {
        photoStore,
        photos,
        filteredPhotos,
        displayPhotos,
        viewMode,
        isLoading,
        selectedIndex,
    } from "../lib/stores/photoStore.ts";
    import PhotoGrid from "../lib/components/PhotoGrid.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import type { PhotoFilter } from "../lib/types.ts";
    import { Loader2, Grid, List, Search } from "@lucide/svelte";

    let showWelcome = $state(true);
    let searchQuery = $state("");
    let sidebarFilter = $state<PhotoFilter>({});

    onMount(() => {
        if ($filteredPhotos.length > 0) {
            showWelcome = false;
        }
    });

    function handleSidebarFilter(filter: PhotoFilter) {
        sidebarFilter = filter;
        applyAllFilters();
    }

    function handleSearchInput() {
        applyAllFilters();
    }

    function applyAllFilters() {
        const filter: PhotoFilter = {
            ...sidebarFilter,
            search: searchQuery || undefined,
        };
        const allPhotos = photoStore.photos || [];
        photoStore.setFilter(filter);

        const filtered = allPhotos.filter((photo) => {
            // Text search: match against filename and all EXIF text fields
            if (filter.search) {
                const q = filter.search.toLowerCase();
                const searchable = [
                    photo.file_name,
                    photo.exif.camera_make,
                    photo.exif.camera_model,
                    photo.exif.lens_model,
                    photo.exif.shutter_speed,
                    photo.exif.exposure_mode,
                    photo.exif.flash,
                    photo.exif.white_balance,
                    photo.exif.date_taken,
                    photo.file_type,
                ].filter(Boolean).map(s => s!.toLowerCase());
                if (!searchable.some(s => s.includes(q))) return false;
            }

            // Dropdown / exact-match filters
            if (filter.camera_make && (!photo.exif.camera_make || !photo.exif.camera_make.includes(filter.camera_make))) return false;
            if (filter.camera_model && (!photo.exif.camera_model || !photo.exif.camera_model.includes(filter.camera_model))) return false;
            if (filter.lens_model && (!photo.exif.lens_model || !photo.exif.lens_model.includes(filter.lens_model))) return false;
            if (filter.file_type && photo.file_type !== filter.file_type) return false;
            if (filter.shutter_speed && photo.exif.shutter_speed !== filter.shutter_speed) return false;
            if (filter.exposure_mode && photo.exif.exposure_mode !== filter.exposure_mode) return false;
            if (filter.flash && photo.exif.flash !== filter.flash) return false;
            if (filter.white_balance && photo.exif.white_balance !== filter.white_balance) return false;

            // Range filters
            if (filter.iso_range) {
                if (!photo.exif.iso) return false;
                if (filter.iso_range[0] != null && photo.exif.iso < filter.iso_range[0]) return false;
                if (filter.iso_range[1] != null && photo.exif.iso > filter.iso_range[1]) return false;
            }
            if (filter.aperture_range) {
                if (!photo.exif.aperture) return false;
                if (filter.aperture_range[0] != null && photo.exif.aperture < filter.aperture_range[0]) return false;
                if (filter.aperture_range[1] != null && photo.exif.aperture > filter.aperture_range[1]) return false;
            }
            if (filter.focal_length_range) {
                if (!photo.exif.focal_length) return false;
                if (filter.focal_length_range[0] != null && photo.exif.focal_length < filter.focal_length_range[0]) return false;
                if (filter.focal_length_range[1] != null && photo.exif.focal_length > filter.focal_length_range[1]) return false;
            }
            if (filter.date_range) {
                if (!photo.exif.date_taken) return false;
                if (filter.date_range[0] && photo.exif.date_taken < filter.date_range[0]) return false;
                if (filter.date_range[1] && photo.exif.date_taken > filter.date_range[1]) return false;
            }
            return true;
        });

        photoStore.setFilteredPhotos(filtered);
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

            <Sidebar photos={$filteredPhotos} allPhotos={$photos} onFilter={handleSidebarFilter} />
        </div>
    {:else}
        <!-- Main Application -->
        <div class="flex flex-1">
            <Sidebar photos={$filteredPhotos} allPhotos={$photos} onFilter={handleSidebarFilter} />

            <div class="flex-1 flex flex-col">
                {#if $isLoading}
                    <div
                        class="flex-1 flex flex-col items-center justify-center text-amber-600"
                    >
                        <Loader2 size={32} class="animate-spin" />
                        <p class="mt-4 text-lg">Scanning photos...</p>
                    </div>
                {:else if $displayPhotos.length === 0}
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
                        class="flex items-center gap-4 p-4 bg-stone-50 border-b border-amber-200"
                    >
                        <h2
                            class="text-lg font-semibold text-amber-900 whitespace-nowrap"
                            style="margin: 0;"
                        >
                            Photos ({$displayPhotos.length})
                        </h2>
                        <div class="flex-1 max-w-md relative">
                            <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-amber-400 pointer-events-none" />
                            <input
                                type="text"
                                placeholder="Search by filename, camera, lens, date..."
                                class="w-full pl-9 pr-3 py-2 text-sm border border-amber-300 rounded-lg bg-white text-amber-900 placeholder:text-amber-400 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 focus:outline-none"
                                bind:value={searchQuery}
                                oninput={handleSearchInput}
                            />
                        </div>
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

                    <!-- Photo Grid -->
                    <div class="flex-1 overflow-y-auto">
                        <PhotoGrid photos={$displayPhotos} />
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    <!-- Photo Viewer Modal -->
    {#if $viewMode === "viewer"}
        <PhotoViewer photos={$displayPhotos} allPhotos={$filteredPhotos} startIndex={$selectedIndex} />
    {/if}
</div>
