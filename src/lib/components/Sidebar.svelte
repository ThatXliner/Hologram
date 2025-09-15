<script lang="ts">
    import { photoStore, stats, currentFilter } from "../stores/photoStore.js";
    import { HologramAPI } from "../api.js";
    import type { PhotoFilter, Photo } from "../types.js";
    import {
        Camera,
        Aperture,
        Calendar,
        Image,
        Filter,
        BarChart3,
        FolderOpen,
    } from "@lucide/svelte";

    interface Props {
        photos: Photo[];
        onFilter: (filter: PhotoFilter) => void;
    }

    let { photos, onFilter }: Props = $props();

    let activeFilter = $state<PhotoFilter>({});
    let showFilters = $state(false);

    // Get unique values for filter dropdowns
    const cameraModels = $derived(
        Array.from(
            new Set(photos.map((p) => p.exif.camera_model).filter(Boolean)),
        ).sort(),
    );
    const lensModels = $derived(
        Array.from(
            new Set(photos.map((p) => p.exif.lens_model).filter(Boolean)),
        ).sort(),
    );
    const fileTypes = $derived(
        Array.from(
            new Set(photos.map((p) => p.file_type).filter(Boolean)),
        ).sort(),
    );

    async function importFolder() {
        const folderPath = await HologramAPI.selectFolder();
        if (folderPath) {
            photoStore.setLoading(true);
            try {
                const scannedPhotos = await HologramAPI.scanFolder(folderPath);
                photoStore.setPhotos(scannedPhotos);
                const photoStats =
                    await HologramAPI.getPhotoStats(scannedPhotos);
                photoStore.setStats(photoStats);
            } catch (error) {
                console.error("Failed to import folder:", error);
            } finally {
                photoStore.setLoading(false);
            }
        }
    }

    function applyFilter() {
        onFilter(activeFilter);
    }

    function clearFilter() {
        activeFilter = {};
        onFilter({});
    }

    function formatNumber(num: number): string {
        return new Intl.NumberFormat().format(num);
    }
</script>

<aside class="sidebar">
    <!-- Import Section -->
    <div class="sidebar-section">
        <button class="import-button" onclick={importFolder}>
            <FolderOpen size={20} />
            Import Photos
        </button>
    </div>

    <!-- Stats Section -->
    {#if $stats}
        <div class="sidebar-section">
            <div class="section-header">
                <BarChart3 size={16} />
                <h3>Library Stats</h3>
            </div>
            <div class="stats-grid">
                <div class="stat-item">
                    <span class="stat-value"
                        >{formatNumber($stats.total_photos)}</span
                    >
                    <span class="stat-label">Total Photos</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value"
                        >{formatNumber($stats.raw_count)}</span
                    >
                    <span class="stat-label">RAW Files</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value"
                        >{formatNumber($stats.jpeg_count)}</span
                    >
                    <span class="stat-label">JPEG Files</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value"
                        >{formatNumber($stats.paired_count)}</span
                    >
                    <span class="stat-label">Paired Sets</span>
                </div>
            </div>

            <!-- Top Cameras -->
            {#if Object.keys($stats.cameras).length > 0}
                <div class="top-items">
                    <h4>Top Cameras</h4>
                    {#each Object.entries($stats.cameras)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 3) as [camera, count]}
                        <div class="top-item">
                            <span class="item-name">{camera}</span>
                            <span class="item-count">{count}</span>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Filters Section -->
    <div class="sidebar-section">
        <div class="section-header">
            <Filter size={16} />
            <h3>Filters</h3>
            <button
                class="toggle-button"
                onclick={() => (showFilters = !showFilters)}
                class:active={showFilters}
            >
                {showFilters ? "−" : "+"}
            </button>
        </div>

        {#if showFilters}
            <div class="filters-content">
                <!-- Camera Model Filter -->
                {#if cameraModels.length > 0}
                    <div class="filter-group">
                        <label for="camera-filter">
                            <Camera size={14} />
                            Camera Model
                        </label>
                        <select
                            id="camera-filter"
                            bind:value={activeFilter.camera_model}
                            onchange={applyFilter}
                        >
                            <option value="">All Cameras</option>
                            {#each cameraModels as model}
                                <option value={model}>{model}</option>
                            {/each}
                        </select>
                    </div>
                {/if}

                <!-- Lens Model Filter -->
                {#if lensModels.length > 0}
                    <div class="filter-group">
                        <label for="lens-filter">
                            <Aperture size={14} />
                            Lens Model
                        </label>
                        <select
                            id="lens-filter"
                            bind:value={activeFilter.lens_model}
                            onchange={applyFilter}
                        >
                            <option value="">All Lenses</option>
                            {#each lensModels as lens}
                                <option value={lens}>{lens}</option>
                            {/each}
                        </select>
                    </div>
                {/if}

                <!-- File Type Filter -->
                {#if fileTypes.length > 0}
                    <div class="filter-group">
                        <label for="filetype-filter">
                            <Image size={14} />
                            File Type
                        </label>
                        <select
                            id="filetype-filter"
                            bind:value={activeFilter.file_type}
                            onchange={applyFilter}
                        >
                            <option value="">All Types</option>
                            {#each fileTypes as type}
                                <option value={type}>{type}</option>
                            {/each}
                        </select>
                    </div>
                {/if}

                <!-- ISO Range Filter -->
                <div class="filter-group">
                    <label>ISO Range</label>
                    <div class="range-inputs">
                        <input
                            type="number"
                            placeholder="Min ISO"
                            onchange={(e) => {
                                if (activeFilter.iso_range?.[0]) {
                                    activeFilter.iso_range[0] = parseInt(
                                        e.target.value,
                                    );
                                }
                                applyFilter();
                            }}
                        />
                        <input
                            type="number"
                            placeholder="Max ISO"
                            onchange={(e) => {
                                if (activeFilter.iso_range?.[1]) {
                                    activeFilter.iso_range[1] = parseInt(
                                        e.target.value,
                                    );
                                }
                                applyFilter();
                            }}
                        />
                    </div>
                </div>

                <!-- Aperture Range Filter -->
                <div class="filter-group">
                    <label>Aperture Range</label>
                    <div class="range-inputs">
                        <input
                            type="number"
                            step="0.1"
                            placeholder="Min f/"
                            onchange={(e) => {
                                if (activeFilter.aperture_range?.[0]) {
                                    activeFilter.aperture_range[0] = parseFloat(
                                        e.target.value,
                                    );
                                }
                                applyFilter();
                            }}
                        />
                        <input
                            type="number"
                            step="0.1"
                            placeholder="Max f/"
                            onchange={(e) => {
                                if (activeFilter.aperture_range?.[1]) {
                                    activeFilter.aperture_range[1] = parseFloat(
                                        e.target.value,
                                    );
                                }
                                applyFilter();
                            }}
                        />
                    </div>
                </div>

                <div class="filter-actions">
                    <button class="clear-button" onclick={clearFilter}
                        >Clear Filters</button
                    >
                </div>
            </div>
        {/if}
    </div>
</aside>

<style>
    @reference "../../app.css";
    .sidebar {
        @apply w-80 bg-gray-500 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 overflow-y-auto;
        height: 100vh;
    }

    .sidebar-section {
        @apply p-4 border-b border-gray-200 dark:border-gray-700;
    }

    .section-header {
        @apply flex items-center gap-2 mb-3;
    }

    .section-header h3 {
        @apply text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1;
        margin: 0;
    }

    .toggle-button {
        @apply w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-bold flex items-center justify-center hover:bg-gray-300 dark:hover:bg-gray-600;
    }

    .toggle-button.active {
        @apply bg-blue-500 text-white;
    }

    .import-button {
        @apply w-full flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 text-white font-medium py-3 px-4 rounded-lg transition-colors;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
        margin-bottom: 1rem;
    }

    .stat-item {
        @apply text-center p-3 bg-white dark:bg-gray-800 rounded-lg;
    }

    .stat-value {
        @apply block text-lg font-bold text-blue-600 dark:text-blue-400;
    }

    .stat-label {
        @apply block text-xs text-gray-600 dark:text-gray-400 mt-1;
    }

    .top-items {
        margin-top: 1rem;
    }

    .top-items h4 {
        @apply text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2;
        margin: 0;
    }

    .top-item {
        @apply flex justify-between items-center py-1 text-sm;
    }

    .item-name {
        @apply text-gray-700 dark:text-gray-300 truncate mr-2;
    }

    .item-count {
        @apply text-gray-500 dark:text-gray-400 font-medium;
    }

    .filters-content {
        @apply space-y-4;
    }

    .filter-group {
        @apply space-y-2;
    }

    .filter-group label {
        @apply flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300;
    }

    .filter-group select,
    .filter-group input {
        @apply w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500;
    }

    .range-inputs {
        @apply grid grid-cols-2 gap-2;
    }

    .filter-actions {
        @apply pt-2;
    }

    .clear-button {
        @apply w-full px-3 py-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors;
    }
</style>
