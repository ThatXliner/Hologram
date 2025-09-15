<script lang="ts">
    import { photoStore, stats, currentFilter } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type { PhotoFilter, Photo } from "../types.ts";
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

<aside
    class="w-80 bg-amber-50 border-r border-amber-200 overflow-y-auto"
    style="height: 100vh;"
>
    <!-- Import Section -->
    <div class="p-4 border-b border-amber-200">
        <button
            class="w-full flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 text-white font-medium py-3 px-4 rounded-lg transition-colors"
            onclick={importFolder}
        >
            <FolderOpen size={20} />
            Import Photos
        </button>
    </div>

    <!-- Stats Section -->
    {#if $stats}
        <div class="p-4 border-b border-amber-200">
            <div class="flex items-center gap-2 mb-3">
                <BarChart3 size={16} />
                <h3
                    class="text-sm font-semibold text-amber-900 flex-1"
                    style="margin: 0;"
                >
                    Library Stats
                </h3>
            </div>
            <div
                style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1rem;"
            >
                <div
                    class="text-center p-3 bg-white rounded-lg shadow-sm"
                >
                    <span
                        class="block text-lg font-bold text-amber-800"
                        >{formatNumber($stats.total_photos)}</span
                    >
                    <span
                        class="block text-xs text-amber-600 mt-1"
                        >Total Photos</span
                    >
                </div>
                <div
                    class="text-center p-3 bg-white rounded-lg shadow-sm"
                >
                    <span
                        class="block text-lg font-bold text-amber-800"
                        >{formatNumber($stats.raw_count)}</span
                    >
                    <span
                        class="block text-xs text-amber-600 mt-1"
                        >RAW Files</span
                    >
                </div>
                <div
                    class="text-center p-3 bg-white rounded-lg shadow-sm"
                >
                    <span
                        class="block text-lg font-bold text-amber-800"
                        >{formatNumber($stats.jpeg_count)}</span
                    >
                    <span
                        class="block text-xs text-amber-600 mt-1"
                        >JPEG Files</span
                    >
                </div>
                <div
                    class="text-center p-3 bg-white rounded-lg shadow-sm"
                >
                    <span
                        class="block text-lg font-bold text-amber-800"
                        >{formatNumber($stats.paired_count)}</span
                    >
                    <span
                        class="block text-xs text-amber-600 mt-1"
                        >Paired Sets</span
                    >
                </div>
            </div>

            <!-- Top Cameras -->
            {#if Object.keys($stats.cameras).length > 0}
                <div style="margin-top: 1rem;">
                    <h4
                        class="text-xs font-semibold text-amber-800 mb-2"
                        style="margin: 0;"
                    >
                        Top Cameras
                    </h4>
                    {#each Object.entries($stats.cameras)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 3) as [camera, count]}
                        <div
                            class="flex justify-between items-center py-1 text-sm"
                        >
                            <span
                                class="text-amber-700 truncate mr-2"
                                >{camera}</span
                            >
                            <span
                                class="text-amber-600 font-medium"
                                >{count}</span
                            >
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Filters Section -->
    <div class="p-4 border-b border-amber-200">
        <div class="flex items-center gap-2 mb-3">
            <Filter size={16} />
            <h3
                class="text-sm font-semibold text-amber-900 flex-1"
                style="margin: 0;"
            >
                Filters
            </h3>
            <button
                class="w-6 h-6 rounded-full bg-amber-200 text-amber-700 text-xs font-bold flex items-center justify-center hover:bg-amber-300"
                onclick={() => (showFilters = !showFilters)}
                class:bg-amber-700={showFilters}
                class:text-white={showFilters}
            >
                {showFilters ? "−" : "+"}
            </button>
        </div>

        {#if showFilters}
            <div class="space-y-4">
                <!-- Camera Model Filter -->
                {#if cameraModels.length > 0}
                    <div class="space-y-2">
                        <label
                            for="camera-filter"
                            class="flex items-center gap-2 text-sm font-medium text-amber-800"
                        >
                            <Camera size={14} />
                            Camera Model
                        </label>
                        <select
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                    <div class="space-y-2">
                        <label
                            for="lens-filter"
                            class="flex items-center gap-2 text-sm font-medium text-amber-800"
                        >
                            <Aperture size={14} />
                            Lens Model
                        </label>
                        <select
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                    <div class="space-y-2">
                        <label
                            for="filetype-filter"
                            class="flex items-center gap-2 text-sm font-medium text-amber-800"
                        >
                            <Image size={14} />
                            File Type
                        </label>
                        <select
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                    <label
                        class="flex items-center gap-2 text-sm font-medium text-amber-800"
                        >ISO Range</label
                    >
                    <div class="grid grid-cols-2 gap-2">
                        <input
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                    <label
                        class="flex items-center gap-2 text-sm font-medium text-amber-800"
                        >Aperture Range</label
                    >
                    <div class="grid grid-cols-2 gap-2">
                        <input
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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
                            class="w-full px-3 py-2 text-sm border border-amber-300 rounded-md bg-white text-amber-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
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

                <div class="pt-2">
                    <button
                        class="w-full px-3 py-2 text-sm text-amber-700 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors"
                        onclick={clearFilter}>Clear Filters</button
                    >
                </div>
            </div>
        {/if}
    </div>
</aside>
