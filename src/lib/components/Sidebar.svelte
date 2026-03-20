<script lang="ts">
    import { photoStore, stats, currentFilter } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type { PhotoFilter, Photo, ThumbnailReady, ExifData } from "../types.ts";
    import {
        Filter,
        BarChart3,
        FolderOpen,
        Plus,
        X,
    } from "@lucide/svelte";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        onFilter: (filter: PhotoFilter) => void;
    }

    let { photos, allPhotos, onFilter }: Props = $props();

    let activeFilter = $state<PhotoFilter>({});
    let showFilters = $state(false);

    // All possible filter definitions, derived from actual data
    type FilterKind = "select" | "range" | "date-range";
    interface FilterDef {
        key: string;
        label: string;
        kind: FilterKind;
        filterKey: keyof PhotoFilter; // maps to PhotoFilter field
    }

    // Select filters: auto-detect which EXIF string fields have values in the library
    const selectFields: { exifKey: keyof ExifData; label: string; filterKey: keyof PhotoFilter }[] = [
        { exifKey: "camera_model", label: "Camera Model", filterKey: "camera_model" },
        { exifKey: "camera_make", label: "Camera Make", filterKey: "camera_make" },
        { exifKey: "lens_model", label: "Lens Model", filterKey: "lens_model" },
        { exifKey: "shutter_speed", label: "Shutter Speed", filterKey: "shutter_speed" },
        { exifKey: "exposure_mode", label: "Exposure Mode", filterKey: "exposure_mode" },
        { exifKey: "flash", label: "Flash", filterKey: "flash" },
        { exifKey: "white_balance", label: "White Balance", filterKey: "white_balance" },
    ];

    // File type is on the Photo object, not exif
    const fileTypeOptions = $derived(
        Array.from(new Set(allPhotos.map((p) => p.file_type).filter(Boolean))).sort(),
    );

    // Build available select filters from data (only show if at least 1 value exists)
    const availableSelectFilters = $derived(
        selectFields
            .map((f) => ({
                ...f,
                options: Array.from(
                    new Set(allPhotos.map((p) => p.exif[f.exifKey] as string | undefined).filter(Boolean)),
                ).sort() as string[],
            }))
            .filter((f) => f.options.length > 0),
    );

    // Range filters
    const rangeFields: { label: string; filterKey: "iso_range" | "aperture_range" | "focal_length_range"; step: number; prefix: string; exifKey: keyof ExifData }[] = [
        { label: "ISO", filterKey: "iso_range", step: 1, prefix: "", exifKey: "iso" },
        { label: "Aperture", filterKey: "aperture_range", step: 0.1, prefix: "f/", exifKey: "aperture" },
        { label: "Focal Length", filterKey: "focal_length_range", step: 1, prefix: "", exifKey: "focal_length" },
    ];

    // Only show range filters that have data
    const availableRangeFilters = $derived(
        rangeFields.filter((f) => allPhotos.some((p) => p.exif[f.exifKey] != null)),
    );

    // Check if date data exists
    const hasDateData = $derived(allPhotos.some((p) => p.exif.date_taken));

    // Track which filters the user has added (customizable)
    // By default, show the first 3 available select filters + file type
    let addedFilterKeys = $state<Set<string>>(new Set(["camera_model", "lens_model", "file_type"]));
    let showAddFilter = $state(false);

    // All possible filter keys that can be added
    const allFilterOptions = $derived([
        ...availableSelectFilters.map((f) => ({ key: f.filterKey, label: f.label, kind: "select" as const })),
        { key: "file_type", label: "File Type", kind: "select" as const },
        ...availableRangeFilters.map((f) => ({ key: f.filterKey, label: f.label + " Range", kind: "range" as const })),
        ...(hasDateData ? [{ key: "date_range", label: "Date Range", kind: "date-range" as const }] : []),
    ]);

    const unaddedFilters = $derived(
        allFilterOptions.filter((f) => !addedFilterKeys.has(f.key)),
    );

    function addFilter(key: string) {
        addedFilterKeys = new Set([...addedFilterKeys, key]);
        showAddFilter = false;
    }

    function removeFilter(key: string) {
        addedFilterKeys = new Set([...addedFilterKeys].filter((k) => k !== key));
        // Also clear that filter value
        const updated = { ...activeFilter };
        delete (updated as any)[key];
        activeFilter = updated;
        onFilter(activeFilter);
    }

    async function importFolder() {
        const folderPath = await HologramAPI.selectFolder();
        if (folderPath) {
            try {
                photoStore.setLoading(true);
                const result = await HologramAPI.scanFolder(
                    folderPath,
                    (data: ThumbnailReady) => {
                        photoStore.setThumbnail(data.id, data.thumbnail);
                    },
                );
                photoStore.setPhotos(result.photos);
                photoStore.setStats(result.stats);
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

    function setRangeMin(key: "iso_range" | "aperture_range" | "focal_length_range", value: string) {
        const num = parseFloat(value);
        if (!value) {
            if (activeFilter[key]) {
                const max = activeFilter[key]![1];
                if (max == null) {
                    const updated = { ...activeFilter };
                    delete updated[key];
                    activeFilter = updated;
                } else {
                    activeFilter = { ...activeFilter, [key]: [undefined as any, max] };
                }
            }
        } else {
            const current = activeFilter[key];
            activeFilter = { ...activeFilter, [key]: [num, current?.[1] as any] };
        }
        applyFilter();
    }

    function setRangeMax(key: "iso_range" | "aperture_range" | "focal_length_range", value: string) {
        const num = parseFloat(value);
        if (!value) {
            if (activeFilter[key]) {
                const min = activeFilter[key]![0];
                if (min == null) {
                    const updated = { ...activeFilter };
                    delete updated[key];
                    activeFilter = updated;
                } else {
                    activeFilter = { ...activeFilter, [key]: [min, undefined as any] };
                }
            }
        } else {
            const current = activeFilter[key];
            activeFilter = { ...activeFilter, [key]: [current?.[0] as any, num] };
        }
        applyFilter();
    }

    function setDateMin(value: string) {
        if (!value && !activeFilter.date_range?.[1]) {
            const updated = { ...activeFilter };
            delete updated.date_range;
            activeFilter = updated;
        } else {
            activeFilter = { ...activeFilter, date_range: [value || "", activeFilter.date_range?.[1] || ""] };
        }
        applyFilter();
    }

    function setDateMax(value: string) {
        if (!value && !activeFilter.date_range?.[0]) {
            const updated = { ...activeFilter };
            delete updated.date_range;
            activeFilter = updated;
        } else {
            activeFilter = { ...activeFilter, date_range: [activeFilter.date_range?.[0] || "", value || ""] };
        }
        applyFilter();
    }

    function formatNumber(num: number): string {
        return new Intl.NumberFormat().format(num);
    }

    // Count active filters
    const activeFilterCount = $derived(
        Object.entries(activeFilter).filter(([k, v]) => {
            if (k === "search") return false; // search is in the toolbar
            if (v == null || v === "") return false;
            if (Array.isArray(v) && v.every((x: any) => x == null || x === "")) return false;
            return true;
        }).length,
    );

    const inputClass = "w-full px-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:ring-2 focus:ring-ring focus:border-ring focus:outline-none";
</script>

<aside
    class="w-72 bg-sidebar border-r border-sidebar-border overflow-y-auto h-screen"
>
    <!-- Import Section -->
    <div class="p-4 border-b border-border">
        <button
            class="w-full flex items-center justify-center gap-2 bg-primary hover:opacity-90 text-primary-foreground font-medium py-2.5 px-4 rounded-lg transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            onclick={importFolder}
        >
            <FolderOpen size={20} />
            Import Photos
        </button>
    </div>

    <!-- Stats Section -->
    {#if $stats}
        <div class="p-4 border-b border-border">
            <div class="flex items-center gap-2 mb-3">
                <BarChart3 size={16} />
                <h3 class="text-xs font-semibold text-foreground uppercase tracking-wide flex-1">
                    Library Stats
                </h3>
            </div>
            <div class="grid grid-cols-2 gap-3 mb-4">
                <div class="text-center p-3 bg-card rounded-lg border border-border shadow-sm">
                    <span class="block text-lg font-semibold tabular-nums text-foreground"
                        >{formatNumber($stats.total_photos)}</span
                    >
                    <span class="block text-xs text-muted-foreground mt-1"
                        >Total Photos</span
                    >
                </div>
                <div class="text-center p-3 bg-card rounded-lg border border-border shadow-sm">
                    <span class="block text-lg font-semibold tabular-nums text-foreground"
                        >{formatNumber($stats.raw_count)}</span
                    >
                    <span class="block text-xs text-muted-foreground mt-1"
                        >RAW Files</span
                    >
                </div>
                <div class="text-center p-3 bg-card rounded-lg border border-border shadow-sm">
                    <span class="block text-lg font-semibold tabular-nums text-foreground"
                        >{formatNumber($stats.jpeg_count)}</span
                    >
                    <span class="block text-xs text-muted-foreground mt-1"
                        >JPEG Files</span
                    >
                </div>
                <div class="text-center p-3 bg-card rounded-lg border border-border shadow-sm">
                    <span class="block text-lg font-semibold tabular-nums text-foreground"
                        >{formatNumber($stats.paired_count)}</span
                    >
                    <span class="block text-xs text-muted-foreground mt-1"
                        >Paired Sets</span
                    >
                </div>
            </div>

            <!-- Top Cameras -->
            {#if Object.keys($stats.cameras).length > 0}
                <div class="mt-4">
                    <h4 class="text-xs font-semibold text-foreground uppercase tracking-wide mb-2">
                        Top Cameras
                    </h4>
                    {#each Object.entries($stats.cameras)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 3) as [camera, count]}
                        <div
                            class="flex justify-between items-center py-1 text-sm"
                        >
                            <span class="text-muted-foreground truncate mr-2"
                                >{camera}</span
                            >
                            <span class="text-foreground font-medium"
                                >{count}</span
                            >
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Filters Section -->
    <div class="p-4 border-b border-border">
        <div class="flex items-center gap-2 mb-3">
            <Filter size={16} />
            <h3 class="text-xs font-semibold text-foreground uppercase tracking-wide flex-1">
                Filters
                {#if activeFilterCount > 0}
                    <span class="ml-1 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">{activeFilterCount}</span>
                {/if}
            </h3>
            <button
                class="w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors {showFilters ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'}"
                onclick={() => (showFilters = !showFilters)}
            >
                {showFilters ? "\u2212" : "+"}
            </button>
        </div>

        {#if showFilters}
            <div class="space-y-3">
                <!-- Dynamic select filters -->
                {#each availableSelectFilters.filter((f) => addedFilterKeys.has(f.filterKey)) as filter (filter.filterKey)}
                    <div class="space-y-1">
                        <div class="flex items-center justify-between">
                            <label
                                for="filter-{filter.filterKey}"
                                class="text-sm font-medium text-foreground"
                            >
                                {filter.label}
                            </label>
                            <button
                                class="text-muted-foreground hover:text-foreground p-0.5"
                                onclick={() => removeFilter(filter.filterKey)}
                                title="Remove filter"
                            >
                                <X size={12} />
                            </button>
                        </div>
                        <select
                            class={inputClass}
                            id="filter-{filter.filterKey}"
                            bind:value={activeFilter[filter.filterKey]}
                            onchange={applyFilter}
                        >
                            <option value="">All</option>
                            {#each filter.options as opt}
                                <option value={opt}>{opt}</option>
                            {/each}
                        </select>
                    </div>
                {/each}

                <!-- File type (special: on Photo, not exif) -->
                {#if addedFilterKeys.has("file_type") && fileTypeOptions.length > 0}
                    <div class="space-y-1">
                        <div class="flex items-center justify-between">
                            <label
                                for="filter-file_type"
                                class="text-sm font-medium text-foreground"
                            >
                                File Type
                            </label>
                            <button
                                class="text-muted-foreground hover:text-foreground p-0.5"
                                onclick={() => removeFilter("file_type")}
                                title="Remove filter"
                            >
                                <X size={12} />
                            </button>
                        </div>
                        <select
                            class={inputClass}
                            id="filter-file_type"
                            bind:value={activeFilter.file_type}
                            onchange={applyFilter}
                        >
                            <option value="">All Types</option>
                            {#each fileTypeOptions as type}
                                <option value={type}>{type}</option>
                            {/each}
                        </select>
                    </div>
                {/if}

                <!-- Dynamic range filters -->
                {#each availableRangeFilters.filter((f) => addedFilterKeys.has(f.filterKey)) as range (range.filterKey)}
                    <div class="space-y-1">
                        <div class="flex items-center justify-between">
                            <label class="text-sm font-medium text-foreground">
                                {range.label} Range
                            </label>
                            <button
                                class="text-muted-foreground hover:text-foreground p-0.5"
                                onclick={() => removeFilter(range.filterKey)}
                                title="Remove filter"
                            >
                                <X size={12} />
                            </button>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <input
                                class={inputClass}
                                type="number"
                                step={range.step}
                                placeholder="Min {range.prefix}"
                                value={activeFilter[range.filterKey]?.[0] ?? ""}
                                onchange={(e) => setRangeMin(range.filterKey, (e.target as HTMLInputElement).value)}
                            />
                            <input
                                class={inputClass}
                                type="number"
                                step={range.step}
                                placeholder="Max {range.prefix}"
                                value={activeFilter[range.filterKey]?.[1] ?? ""}
                                onchange={(e) => setRangeMax(range.filterKey, (e.target as HTMLInputElement).value)}
                            />
                        </div>
                    </div>
                {/each}

                <!-- Date range filter -->
                {#if addedFilterKeys.has("date_range") && hasDateData}
                    <div class="space-y-1">
                        <div class="flex items-center justify-between">
                            <label class="text-sm font-medium text-foreground">
                                Date Range
                            </label>
                            <button
                                class="text-muted-foreground hover:text-foreground p-0.5"
                                onclick={() => removeFilter("date_range")}
                                title="Remove filter"
                            >
                                <X size={12} />
                            </button>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <input
                                class={inputClass}
                                type="date"
                                value={activeFilter.date_range?.[0] ?? ""}
                                onchange={(e) => setDateMin((e.target as HTMLInputElement).value)}
                            />
                            <input
                                class={inputClass}
                                type="date"
                                value={activeFilter.date_range?.[1] ?? ""}
                                onchange={(e) => setDateMax((e.target as HTMLInputElement).value)}
                            />
                        </div>
                    </div>
                {/if}

                <!-- Add filter button -->
                {#if unaddedFilters.length > 0}
                    <div class="relative">
                        <button
                            class="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-muted-foreground bg-accent/50 hover:bg-accent rounded-lg transition-colors border border-dashed border-border"
                            onclick={() => (showAddFilter = !showAddFilter)}
                        >
                            <Plus size={14} />
                            Add Filter
                        </button>
                        {#if showAddFilter}
                            <div class="absolute z-10 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                                {#each unaddedFilters as opt}
                                    <button
                                        class="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
                                        onclick={() => addFilter(opt.key)}
                                    >
                                        {opt.label}
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {/if}

                {#if activeFilterCount > 0}
                    <div class="pt-1">
                        <button
                            class="w-full px-3 py-2 text-sm text-secondary-foreground bg-secondary hover:bg-accent rounded-lg transition-colors"
                            onclick={clearFilter}>Clear All Filters</button
                        >
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</aside>
