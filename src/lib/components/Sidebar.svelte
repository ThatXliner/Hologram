<script lang="ts">
    import { photoStore, stats } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type { ExifData, Photo, PhotoFilter, SavedSearch, SmartCollection, ThumbnailReady, VisualIndexProgress } from "../types.ts";
    import {
        Check,
        FolderOpen,
        Lock,
        Plus,
        Trash2,
        X,
    } from "@lucide/svelte";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        filter?: PhotoFilter;
        savedSearches?: SavedSearch[];
        activeSavedSearchId?: string | null;
        smartCollections?: SmartCollection[];
        activeSmartCollectionId?: string | null;
        smartCollectionsEnabled?: boolean;
        smartCollectionsIndexing?: boolean;
        visualIndexProgress?: VisualIndexProgress;
        onFilter: (filter: PhotoFilter) => void;
        onSavedSearchSelect?: (id: string) => void;
        onSavedSearchDelete?: (id: string) => void;
        onSmartCollectionSelect?: (id: string | null) => void;
        onSmartCollectionsTitleClick?: () => void;
    }

    let {
        photos,
        allPhotos,
        filter = {},
        savedSearches = [],
        activeSavedSearchId = null,
        smartCollections = [],
        activeSmartCollectionId = null,
        smartCollectionsEnabled = false,
        smartCollectionsIndexing = false,
        visualIndexProgress = { current: 0, total: 0 },
        onFilter,
        onSavedSearchSelect = () => {},
        onSavedSearchDelete = () => {},
        onSmartCollectionSelect = () => {},
        onSmartCollectionsTitleClick = () => {},
    }: Props = $props();

    let activeFilter = $state<PhotoFilter>({});
    let showFilters = $state(false);
    let showAddFilter = $state(false);
    let tagFilterInput = $state("");
    let lastExternalFilter = $state("");

    const pickedCount = $derived(allPhotos.filter((photo) => photo.flag === "pick").length);
    const rejectedCount = $derived(allPhotos.filter((photo) => photo.flag === "reject").length);
    const ratedCount = $derived(allPhotos.filter((photo) => (photo.rating ?? 0) > 0).length);
    const reviewedCount = $derived(
        allPhotos.filter((photo) => photo.flag === "pick" || photo.flag === "reject" || (photo.rating ?? 0) > 0).length,
    );
    const reviewPct = $derived(allPhotos.length ? Math.round((reviewedCount / allPhotos.length) * 100) : 0);

    const selectFields: { exifKey: keyof ExifData; label: string; filterKey: keyof PhotoFilter }[] = [
        { exifKey: "camera_model", label: "Camera Model", filterKey: "camera_model" },
        { exifKey: "camera_make", label: "Camera Make", filterKey: "camera_make" },
        { exifKey: "lens_model", label: "Lens Model", filterKey: "lens_model" },
        { exifKey: "shutter_speed", label: "Shutter Speed", filterKey: "shutter_speed" },
        { exifKey: "exposure_mode", label: "Exposure Mode", filterKey: "exposure_mode" },
        { exifKey: "flash", label: "Flash", filterKey: "flash" },
        { exifKey: "white_balance", label: "White Balance", filterKey: "white_balance" },
    ];

    const fileTypeOptions = $derived(
        Array.from(new Set(allPhotos.map((photo) => photo.file_type).filter(Boolean))).sort(),
    );

    const availableSelectFilters = $derived(
        selectFields
            .map((field) => ({
                ...field,
                options: Array.from(
                    new Set(allPhotos.map((photo) => photo.exif[field.exifKey] as string | undefined).filter(Boolean)),
                ).sort() as string[],
            }))
            .filter((field) => field.options.length > 0),
    );

    const rangeFields: {
        label: string;
        filterKey: "iso_range" | "aperture_range" | "focal_length_range";
        step: number;
        prefix: string;
        exifKey: keyof ExifData;
    }[] = [
        { label: "ISO", filterKey: "iso_range", step: 1, prefix: "", exifKey: "iso" },
        { label: "Aperture", filterKey: "aperture_range", step: 0.1, prefix: "f/", exifKey: "aperture" },
        { label: "Focal Length", filterKey: "focal_length_range", step: 1, prefix: "", exifKey: "focal_length" },
    ];

    const availableRangeFilters = $derived(
        rangeFields.filter((field) => allPhotos.some((photo) => photo.exif[field.exifKey] != null)),
    );
    const hasDateData = $derived(allPhotos.some((photo) => photo.exif.date_taken));

    let addedFilterKeys = $state<Set<string>>(new Set(["camera_model", "lens_model", "file_type"]));

    const allFilterOptions = $derived([
        ...availableSelectFilters.map((field) => ({ key: field.filterKey, label: field.label, kind: "select" as const })),
        { key: "file_type", label: "File Type", kind: "select" as const },
        ...availableRangeFilters.map((field) => ({ key: field.filterKey, label: `${field.label} Range`, kind: "range" as const })),
        ...(hasDateData ? [{ key: "date_range", label: "Date Range", kind: "date-range" as const }] : []),
        { key: "tags", label: "Tags", kind: "tags" as const },
    ]);

    const unaddedFilters = $derived(allFilterOptions.filter((field) => !addedFilterKeys.has(field.key)));

    const activeFilterCount = $derived(
        Object.entries(activeFilter).filter(([key, value]) => {
            if (key === "search" || key === "rating_gte" || key === "flag") return false;
            if (value == null || value === "") return false;
            if (Array.isArray(value) && value.every((item: any) => item == null || item === "")) return false;
            return true;
        }).length,
    );

    const inputClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40";

    $effect(() => {
        const key = JSON.stringify(filter ?? {});
        if (key === lastExternalFilter) return;
        lastExternalFilter = key;
        activeFilter = { ...(filter ?? {}) };
        const keys = Object.keys(activeFilter).filter((key) => !["search", "rating_gte", "flag"].includes(key));
        if (keys.length > 0) {
            addedFilterKeys = new Set([...addedFilterKeys, ...keys]);
        }
    });

    async function importFolder() {
        const folderPath = await HologramAPI.selectFolder();
        if (folderPath) {
            try {
                photoStore.setLoading(true);
                const result = await HologramAPI.scanFolder(
                    folderPath,
                    (data: ThumbnailReady) => {
                        photoStore.setThumbnail(data.id, data.thumbnail, data.embedded_jpeg_preview);
                    },
                );
                photoStore.setPhotos(result.photos);
                photoStore.setStats(result.stats);
                photoStore.loadMetadata(result.photos.map((photo) => photo.id));
            } catch (error) {
                console.error("Failed to import folder:", error);
            } finally {
                photoStore.setLoading(false);
            }
        }
    }

    function addFilter(key: string) {
        addedFilterKeys = new Set([...addedFilterKeys, key]);
        showAddFilter = false;
    }

    function removeFilter(key: string) {
        addedFilterKeys = new Set([...addedFilterKeys].filter((value) => value !== key));
        const updated = { ...activeFilter };
        delete (updated as any)[key];
        activeFilter = updated;
        onFilter(activeFilter);
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

    function handleTagFilterKeydown(event: KeyboardEvent) {
        if (event.key === "Enter" && tagFilterInput.trim()) {
            event.preventDefault();
            const newTag = tagFilterInput.trim().toLowerCase();
            const currentTags = activeFilter.tags ?? [];
            if (!currentTags.includes(newTag)) {
                activeFilter = { ...activeFilter, tags: [...currentTags, newTag] };
                onFilter(activeFilter);
            }
            tagFilterInput = "";
        }
    }

    function removeTagFilter(tag: string) {
        const updated = (activeFilter.tags ?? []).filter((item) => item !== tag);
        if (updated.length === 0) {
            const copy = { ...activeFilter };
            delete copy.tags;
            activeFilter = copy;
        } else {
            activeFilter = { ...activeFilter, tags: updated };
        }
        onFilter(activeFilter);
    }

    function formatNumber(num: number): string {
        return new Intl.NumberFormat().format(num);
    }

    function progressWidth(percent: number): string {
        return `${Math.max(0, Math.min(100, percent))}%`;
    }

    // Active advanced filters, summarized as removable chips for the deck header.
    const activeFilterChips = $derived(
        Object.entries(activeFilter).flatMap(([key, value]) => {
            if (["search", "rating_gte", "flag"].includes(key)) return [];
            if (value == null || value === "") return [];
            if (Array.isArray(value)) {
                if (key === "tags") {
                    return (value as string[]).map((tag) => ({ key: `tags:${tag}`, label: `#${tag}` }));
                }
                const [min, max] = value as (number | string | undefined)[];
                if ((min == null || min === "") && (max == null || max === "")) return [];
                const name = key.replace(/_range$/, "").replace(/_/g, " ");
                const range = `${min ?? "…"}–${max ?? "…"}`;
                return [{ key, label: `${name} ${range}` }];
            }
            return [{ key, label: String(value) }];
        }),
    );

    function removeFilterChip(chipKey: string) {
        if (chipKey.startsWith("tags:")) {
            removeTagFilter(chipKey.slice(5));
        } else {
            removeFilter(chipKey);
        }
    }

    const redundantRawCount = $derived($stats?.raw_count ?? 0);
</script>

{#snippet deckLabel(text: string)}
    <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">{text}</div>
{/snippet}

<aside class="flex h-full w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-card text-foreground">
    <div class="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-[14px_14px_16px]">
        <!-- LIBRARY -->
        <section>
            {@render deckLabel("Library")}
            <div class="text-[13px] font-semibold text-foreground">
                {allPhotos.length > 0 ? "Current library" : "No library"}
            </div>
            {#if $stats}
                <div class="mt-1 font-mono text-[11px] text-muted-foreground">
                    {formatNumber($stats.total_photos)} photos · {formatNumber($stats.paired_count)} RAW+JPEG pairs
                </div>
                {#if redundantRawCount > 0}
                    <div class="mt-[6px] rounded-md border border-border bg-background p-[7px_8px] font-mono text-[10px] leading-[1.5] text-subtle">
                        ◈ {formatNumber(redundantRawCount)} RAW files carry embedded JPEG previews — Hologram reads them for instant thumbnails.
                    </div>
                {/if}
            {/if}
            <button
                class="mt-[8px] flex h-8 w-full items-center justify-center gap-2 rounded-md border border-primary/40 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10"
                onclick={importFolder}
            >
                <FolderOpen size={14} />
                {allPhotos.length > 0 ? "Import another folder" : "Import photos"}
            </button>
        </section>

        <!-- SESSION -->
        {#if allPhotos.length > 0}
            <section>
                <div class="mb-2 flex items-baseline justify-between">
                    {@render deckLabel("Session")}
                    <span class="font-mono text-[10px] font-semibold text-muted-foreground">{reviewPct}% reviewed</span>
                </div>
                <div class="h-1 overflow-hidden rounded-full bg-secondary">
                    <div class="h-full rounded-full bg-primary" style:width={progressWidth(reviewPct)}></div>
                </div>
                <div class="mt-[10px] grid grid-cols-3 gap-[6px] font-mono text-[11px]">
                    <div class="rounded-md bg-secondary p-2">
                        <div class="flex items-center gap-1 text-pick"><Check size={12} />pick</div>
                        <div class="mt-[2px] text-[15px] font-semibold tabular-nums text-foreground">{pickedCount}</div>
                    </div>
                    <div class="rounded-md bg-secondary p-2">
                        <div class="flex items-center gap-1 text-reject"><X size={12} />rej</div>
                        <div class="mt-[2px] text-[15px] font-semibold tabular-nums text-foreground">{rejectedCount}</div>
                    </div>
                    <div class="rounded-md bg-secondary p-2">
                        <div class="text-rating">★ rated</div>
                        <div class="mt-[2px] text-[15px] font-semibold tabular-nums text-foreground">{ratedCount}</div>
                    </div>
                </div>
            </section>
        {/if}

        <!-- FILTERS -->
        <section>
            <div class="mb-2 flex items-center justify-between">
                {@render deckLabel("Filters")}
                {#if activeFilterCount > 0}
                    <button class="font-mono text-[10px] text-subtle hover:text-foreground" onclick={clearFilter}>clear</button>
                {/if}
            </div>
            <div class="flex flex-wrap gap-[5px]">
                {#each activeFilterChips as chip (chip.key)}
                    <span class="inline-flex items-center gap-1 rounded-full border border-primary/40 px-2 py-[3px] font-mono text-[10px] text-primary">
                        {chip.label}
                        <button onclick={() => removeFilterChip(chip.key)} class="hover:text-foreground" aria-label="Remove filter">✕</button>
                    </span>
                {/each}
                <button
                    class="inline-flex items-center gap-1 rounded-full border border-dashed border-white/20 px-2 py-[3px] font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    onclick={() => (showFilters = !showFilters)}
                >
                    <Plus size={11} />{showFilters ? "done" : "add filter"}
                </button>
            </div>

            {#if showFilters}
                <div class="mt-3 space-y-3">
                    {#each availableSelectFilters.filter((field) => addedFilterKeys.has(field.filterKey)) as filter (filter.filterKey)}
                        <div class="space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <label for="filter-{filter.filterKey}" class="text-xs font-semibold text-foreground">{filter.label}</label>
                                <button class="text-muted-foreground hover:text-foreground" onclick={() => removeFilter(filter.filterKey)} title="Remove filter">
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

                    {#if addedFilterKeys.has("file_type") && fileTypeOptions.length > 0}
                        <div class="space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <label for="filter-file_type" class="text-xs font-semibold text-foreground">File Type</label>
                                <button class="text-muted-foreground hover:text-foreground" onclick={() => removeFilter("file_type")} title="Remove filter">
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

                    {#each availableRangeFilters.filter((field) => addedFilterKeys.has(field.filterKey)) as range (range.filterKey)}
                        <div class="space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <div class="text-xs font-semibold text-foreground">{range.label} Range</div>
                                <button class="text-muted-foreground hover:text-foreground" onclick={() => removeFilter(range.filterKey)} title="Remove filter">
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
                                    onchange={(event) => setRangeMin(range.filterKey, (event.target as HTMLInputElement).value)}
                                />
                                <input
                                    class={inputClass}
                                    type="number"
                                    step={range.step}
                                    placeholder="Max {range.prefix}"
                                    value={activeFilter[range.filterKey]?.[1] ?? ""}
                                    onchange={(event) => setRangeMax(range.filterKey, (event.target as HTMLInputElement).value)}
                                />
                            </div>
                        </div>
                    {/each}

                    {#if addedFilterKeys.has("date_range") && hasDateData}
                        <div class="space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <div class="text-xs font-semibold text-foreground">Date Range</div>
                                <button class="text-muted-foreground hover:text-foreground" onclick={() => removeFilter("date_range")} title="Remove filter">
                                    <X size={12} />
                                </button>
                            </div>
                            <div class="grid grid-cols-2 gap-2">
                                <input
                                    class={inputClass}
                                    type="date"
                                    value={activeFilter.date_range?.[0] ?? ""}
                                    onchange={(event) => setDateMin((event.target as HTMLInputElement).value)}
                                />
                                <input
                                    class={inputClass}
                                    type="date"
                                    value={activeFilter.date_range?.[1] ?? ""}
                                    onchange={(event) => setDateMax((event.target as HTMLInputElement).value)}
                                />
                            </div>
                        </div>
                    {/if}

                    {#if addedFilterKeys.has("tags")}
                        <div class="space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                                <div class="text-xs font-semibold text-foreground">Tags</div>
                                <button class="text-muted-foreground hover:text-foreground" onclick={() => removeFilter("tags")} title="Remove filter">
                                    <X size={12} />
                                </button>
                            </div>
                            <div class="flex min-h-6 flex-wrap gap-1">
                                {#each (activeFilter.tags ?? []) as tag}
                                    <span class="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-xs text-primary">
                                        {tag}
                                        <button onclick={() => removeTagFilter(tag)} class="hover:text-reject" aria-label="Remove tag filter">
                                            <X size={10} />
                                        </button>
                                    </span>
                                {/each}
                            </div>
                            <input
                                type="text"
                                placeholder="Tag, then Enter"
                                class={inputClass}
                                bind:value={tagFilterInput}
                                onkeydown={handleTagFilterKeydown}
                            />
                        </div>
                    {/if}

                    {#if unaddedFilters.length > 0}
                        <div class="relative">
                            <button
                                class="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-secondary text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                onclick={() => (showAddFilter = !showAddFilter)}
                            >
                                <Plus size={13} />
                                Add Filter
                            </button>
                            {#if showAddFilter}
                                <div class="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
                                    {#each unaddedFilters as opt}
                                        <button
                                            class="w-full px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
                                            onclick={() => addFilter(opt.key)}
                                        >
                                            {opt.label}
                                        </button>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    {/if}

                </div>
            {/if}
        </section>

        <!-- SAVED SEARCHES -->
        {#if savedSearches.length > 0}
            <section>
                {@render deckLabel("Saved searches")}
                <div class="flex flex-col gap-[2px]">
                    {#each savedSearches as saved (saved.id)}
                        <div class="group flex items-center gap-1">
                            <button
                                class="min-w-0 flex-1 rounded-[5px] px-2 py-[6px] text-left text-[12px] font-medium transition-colors {activeSavedSearchId === saved.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                                onclick={() => onSavedSearchSelect(saved.id)}
                                title={saved.name}
                            >
                                <span class="block truncate">{saved.name}</span>
                            </button>
                            <button
                                class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-subtle opacity-0 transition-opacity hover:text-reject group-hover:opacity-100"
                                onclick={() => onSavedSearchDelete(saved.id)}
                                title="Delete saved search"
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}

        <!-- SMART COLLECTIONS -->
        {#if allPhotos.length > 0}
            <section>
                <div class="mb-2 flex items-baseline justify-between">
                    {@render deckLabel("Smart collections")}
                    {#if smartCollectionsEnabled && smartCollectionsIndexing}
                        <span class="font-mono text-[10px] text-info">
                            {visualIndexProgress.total ? Math.round((visualIndexProgress.current / visualIndexProgress.total) * 100) : 0}%
                        </span>
                    {/if}
                </div>

                {#if !smartCollectionsEnabled}
                    <button
                        class="w-full rounded-md border border-dashed border-white/15 p-[9px_10px] text-left font-sans text-[11px] leading-[1.5] text-subtle transition-colors hover:border-primary/50"
                        onclick={onSmartCollectionsTitleClick}
                    >
                        <Lock size={11} class="mb-[3px] inline text-subtle" /> Locked — enable local visual indexing to group by scene &amp; similarity.
                        <span class="text-primary">Set up…</span>
                    </button>
                {:else}
                    {#if smartCollectionsIndexing}
                        <div class="mb-2 h-1 overflow-hidden rounded-full bg-secondary">
                            <div
                                class="h-full rounded-full bg-info"
                                style:width={progressWidth(visualIndexProgress.total ? (visualIndexProgress.current / visualIndexProgress.total) * 100 : 0)}
                            ></div>
                        </div>
                    {/if}
                    <div class="flex flex-col gap-[2px]">
                        <button
                            class="flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-[6px] text-[12px] font-medium transition-colors {activeSmartCollectionId == null ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                            onclick={() => onSmartCollectionSelect(null)}
                        >
                            <span class="truncate">All photos</span>
                            <span class="font-mono text-[10px] tabular-nums text-subtle">{allPhotos.length}</span>
                        </button>
                        {#each smartCollections.slice(0, 12) as collection (collection.id)}
                            <button
                                class="flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-[6px] text-[12px] font-medium transition-colors {activeSmartCollectionId === collection.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                                onclick={() => onSmartCollectionSelect(collection.id)}
                                title={collection.detail}
                            >
                                <span class="min-w-0 truncate">{collection.name}</span>
                                <span class="shrink-0 font-mono text-[10px] tabular-nums text-subtle">{collection.photo_ids.length}</span>
                            </button>
                        {/each}
                        {#if !smartCollectionsIndexing && smartCollections.length === 0}
                            <div class="px-2 py-[6px] font-mono text-[10px] text-subtle">No visual collections yet.</div>
                        {/if}
                    </div>
                {/if}
            </section>
        {/if}

        <!-- TOP CAMERAS -->
        {#if $stats && Object.keys($stats.cameras).length > 0}
            <section>
                {@render deckLabel("Top cameras")}
                <div class="flex flex-col gap-[6px] font-mono text-[11px]">
                    {#each Object.entries($stats.cameras)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 4) as [camera, count]}
                        <div class="flex items-center justify-between gap-3">
                            <span class="truncate text-muted-foreground">{camera}</span>
                            <span class="tabular-nums text-foreground">{count}</span>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}
    </div>
</aside>
