<script lang="ts">
    import { convertFileSrc } from "@tauri-apps/api/core";
    import { photoStore, stats } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type {
        ExifData,
        ObjectDetectionModelManifest,
        ObjectDetectionModelState,
        Photo,
        PhotoFilter,
        SavedSearch,
        SmartCollection,
        ThumbnailReady,
        VisualIndexProgress,
    } from "../types.ts";
    import ExportPanel from "./ExportPanel.svelte";
    import {
        BarChart3,
        Bookmark,
        Bug,
        Camera,
        Check,
        Download,
        Filter,
        FolderOpen,
        Plus,
        Power,
        ScanSearch,
        ShieldCheck,
        Sparkles,
        Star,
        Trash2,
        X,
        XCircle,
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
        objectDetectionModelState?: ObjectDetectionModelState;
        objectDetectionModelManifest?: ObjectDetectionModelManifest;
        onFilter: (filter: PhotoFilter) => void;
        onSavedSearchSelect?: (id: string) => void;
        onSavedSearchDelete?: (id: string) => void;
        onSmartCollectionSelect?: (id: string | null) => void;
        onSmartCollectionsTitleClick?: () => void;
        onSmartCollectionDebug?: (id: string) => void;
        onSmartCollectionsDisable?: () => void;
        onObjectDetectionModelDelete?: () => void;
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
        objectDetectionModelState,
        objectDetectionModelManifest,
        onFilter,
        onSavedSearchSelect = () => {},
        onSavedSearchDelete = () => {},
        onSmartCollectionSelect = () => {},
        onSmartCollectionsTitleClick = () => {},
        onSmartCollectionDebug = () => {},
        onSmartCollectionsDisable = () => {},
        onObjectDetectionModelDelete = () => {},
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
    const modelReady = $derived(objectDetectionModelState?.status === "ready");
    const modelStatusText = $derived(
        objectDetectionModelState?.status === "ready"
            ? "Local model ready"
            : objectDetectionModelState?.status === "downloading"
                ? "Downloading model"
                : objectDetectionModelState?.status === "error"
                    ? "Model needs attention"
                    : "Model not downloaded",
    );

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
                        photoStore.setThumbnail(data.id, data.thumbnail);
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

    function previewSrc(photo: Photo | undefined): string {
        if (!photo) return "";
        if (photo.thumbnail) {
            const mime = photo.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
            return `data:${mime};base64,${photo.thumbnail}`;
        }
        if (["JPEG", "JPG", "PNG", "WEBP", "GIF"].includes(photo.file_type.toUpperCase())) {
            try {
                return convertFileSrc(photo.file_path);
            } catch {
                return "";
            }
        }
        return "";
    }

    function collectionPreviewPhotos(collection: SmartCollection): Photo[] {
        const ids = collection.cover_photo_ids?.length ? collection.cover_photo_ids : collection.photo_ids;
        return ids.map((id) => allPhotos.find((photo) => photo.id === id)).filter(Boolean).slice(0, 4) as Photo[];
    }

    function kindLabel(kind: SmartCollection["kind"]): string {
        if (kind === "memory") return "Memory";
        if (kind === "object") return "Objects";
        if (kind === "scene") return "Scenes";
        return "Looks";
    }

    function collectionGradientClass(kind: SmartCollection["kind"]): string {
        if (kind === "memory") return "bg-gradient-to-br from-rose-500 to-amber-400";
        if (kind === "object") return "bg-gradient-to-br from-sky-500 to-cyan-400";
        if (kind === "scene") return "bg-gradient-to-br from-emerald-500 to-teal-400";
        return "bg-gradient-to-br from-violet-500 to-fuchsia-400";
    }
</script>

<aside class="flex h-screen w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <div class="border-b border-sidebar-border p-4">
        <button
            class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onclick={importFolder}
        >
            <FolderOpen size={18} />
            Import Photos
        </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
        {#if $stats}
            <section class="border-b border-sidebar-border p-4">
                <div class="mb-3 flex items-center gap-2">
                    <BarChart3 size={14} class="text-primary" />
                    <h2 class="text-xs font-bold uppercase text-foreground">Session</h2>
                    <span class="ml-auto text-xs tabular-nums text-muted-foreground">{formatNumber(photos.length)} visible</span>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div class="rounded-lg border border-border bg-card p-3">
                        <span class="block text-lg font-semibold tabular-nums text-foreground">{formatNumber($stats.total_photos)}</span>
                        <span class="text-xs text-muted-foreground">Total</span>
                    </div>
                    <div class="rounded-lg border border-border bg-card p-3">
                        <span class="block text-lg font-semibold tabular-nums text-foreground">{formatNumber($stats.paired_count)}</span>
                        <span class="text-xs text-muted-foreground">Pairs</span>
                    </div>
                    <div class="rounded-lg border border-border bg-card p-3">
                        <span class="block text-lg font-semibold tabular-nums text-foreground">{formatNumber($stats.raw_count)}</span>
                        <span class="text-xs text-muted-foreground">RAW</span>
                    </div>
                    <div class="rounded-lg border border-border bg-card p-3">
                        <span class="block text-lg font-semibold tabular-nums text-foreground">{formatNumber($stats.jpeg_count)}</span>
                        <span class="text-xs text-muted-foreground">JPEG</span>
                    </div>
                </div>

            </section>
        {/if}

        {#if allPhotos.length > 0}
            <section class="border-b border-sidebar-border p-4">
                <div class="mb-3 flex items-center gap-2">
                    <Star size={14} class="text-rating" fill="currentColor" />
                    <h2 class="text-xs font-bold uppercase text-foreground">Cull Progress</h2>
                    <span class="ml-auto text-xs font-semibold tabular-nums text-muted-foreground">{reviewPct}%</span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div class="h-full rounded-full bg-primary" style:width={progressWidth(reviewPct)}></div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2">
                    <div class="rounded-lg border border-border bg-card p-2">
                        <div class="flex items-center gap-1.5 text-xs text-pick">
                            <Check size={13} />
                            Picks
                        </div>
                        <div class="mt-1 text-base font-semibold tabular-nums text-foreground">{pickedCount}</div>
                    </div>
                    <div class="rounded-lg border border-border bg-card p-2">
                        <div class="flex items-center gap-1.5 text-xs text-reject">
                            <XCircle size={13} />
                            Reject
                        </div>
                        <div class="mt-1 text-base font-semibold tabular-nums text-foreground">{rejectedCount}</div>
                    </div>
                    <div class="rounded-lg border border-border bg-card p-2">
                        <div class="flex items-center gap-1.5 text-xs text-rating">
                            <Star size={13} fill="currentColor" />
                            Rated
                        </div>
                        <div class="mt-1 text-base font-semibold tabular-nums text-foreground">{ratedCount}</div>
                    </div>
                </div>
            </section>
        {/if}

        {#if allPhotos.length > 0}
            <section class="border-b border-sidebar-border p-4">
                <div class="mb-3 flex items-center gap-2">
                    <Sparkles size={14} class="text-primary" />
                    <button
                        class="text-left text-xs font-bold uppercase text-foreground transition-colors hover:text-primary"
                        onclick={onSmartCollectionsTitleClick}
                    >
                        Smart Collections
                    </button>
                    {#if !smartCollectionsEnabled}
                        <span class="ml-auto rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">Off</span>
                    {:else if smartCollectionsIndexing}
                        <span class="ml-auto text-xs tabular-nums text-muted-foreground">
                            {visualIndexProgress.total ? Math.round((visualIndexProgress.current / visualIndexProgress.total) * 100) : 0}%
                        </span>
                    {/if}
                </div>

                {#if !smartCollectionsEnabled}
                    <button
                        class="group w-full overflow-hidden rounded-lg border border-dashed border-border bg-card text-left transition-colors hover:border-primary"
                        onclick={onSmartCollectionsTitleClick}
                    >
                        <div class="flex items-center gap-3 p-3">
                            <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                                <Download size={16} />
                            </div>
                            <div class="min-w-0">
                                <div class="text-xs font-semibold text-foreground">Download local detector</div>
                                <div class="truncate text-[10px] text-muted-foreground">{objectDetectionModelManifest?.name ?? "Object detector"} / {modelStatusText}</div>
                            </div>
                        </div>
                    </button>
                {:else}
                    {#if smartCollectionsIndexing}
                        <div class="mb-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                            <div
                                class="h-full rounded-full bg-primary"
                                style:width={progressWidth(visualIndexProgress.total ? (visualIndexProgress.current / visualIndexProgress.total) * 100 : 0)}
                            ></div>
                        </div>
                    {/if}

                    <div class="mb-3 rounded-lg border border-border bg-card p-3">
                        <div class="flex items-center gap-2">
                            <ShieldCheck size={14} class={modelReady ? "text-pick" : "text-muted-foreground"} />
                            <div class="min-w-0 flex-1">
                                <div class="truncate text-xs font-semibold text-foreground">{modelStatusText}</div>
                                <div class="truncate text-[10px] text-muted-foreground">{objectDetectionModelManifest?.name ?? "Object detector"}</div>
                            </div>
                            <button
                                class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                onclick={onSmartCollectionsTitleClick}
                                title="Manage Smart Collections"
                            >
                                <ScanSearch size={13} />
                            </button>
                        </div>
                        <div class="mt-2 flex gap-1">
                            <button
                                class="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-secondary px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                onclick={onSmartCollectionsDisable}
                                title="Disable Smart Collections"
                            >
                                <Power size={11} />
                                Disable
                            </button>
                            <button
                                class="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-secondary px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-reject"
                                onclick={onObjectDetectionModelDelete}
                                title="Delete local detector state"
                            >
                                <Trash2 size={11} />
                                Delete
                            </button>
                        </div>
                    </div>

                    <div class="space-y-1">
                        <button
                            class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors {activeSmartCollectionId == null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                            onclick={() => onSmartCollectionSelect(null)}
                        >
                            <span class="truncate font-semibold">All Photos</span>
                            <span class="tabular-nums">{allPhotos.length}</span>
                        </button>
                        {#each smartCollections.slice(0, 12) as collection (collection.id)}
                            {@const previews = collectionPreviewPhotos(collection)}
                            <div class="group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/60">
                                <button
                                    class="relative block h-24 w-full overflow-hidden text-left"
                                    onclick={() => onSmartCollectionSelect(collection.id)}
                                    title={collection.detail}
                                >
                                    {#if previews.length > 0}
                                        <div class="grid h-full grid-cols-2 grid-rows-2">
                                            {#each previews as photo (photo.id)}
                                                {#if previewSrc(photo)}
                                                    <img class="h-full w-full object-cover" src={previewSrc(photo)} alt={photo.file_name} loading="lazy" />
                                                {:else}
                                                    <div class="bg-secondary"></div>
                                                {/if}
                                            {/each}
                                        </div>
                                    {:else}
                                        <div class={`h-full ${collectionGradientClass(collection.kind)}`}></div>
                                    {/if}
                                    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent"></div>
                                    <div class="absolute inset-x-0 bottom-0 p-2 text-white">
                                        <div class="flex items-end justify-between gap-2">
                                            <div class="min-w-0">
                                                <div class="truncate text-xs font-bold">{collection.name}</div>
                                                <div class="truncate text-[10px] text-white/75">{kindLabel(collection.kind)} / {collection.detail}</div>
                                            </div>
                                            <span class="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">{collection.photo_ids.length}</span>
                                        </div>
                                    </div>
                                    {#if activeSmartCollectionId === collection.id}
                                        <div class="absolute inset-0 rounded-lg ring-2 ring-primary"></div>
                                    {/if}
                                </button>
                                <div class="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
                                    <span class="truncate text-[10px] text-muted-foreground">{collection.label ?? kindLabel(collection.kind)}</span>
                                    <button
                                        class="inline-flex h-6 items-center gap-1 rounded-md bg-secondary px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                        onclick={() => onSmartCollectionDebug(collection.id)}
                                        title="Show detection boxes"
                                    >
                                        <Bug size={11} />
                                        Boxes
                                    </button>
                                </div>
                            </div>
                        {/each}
                        {#if !smartCollectionsIndexing && smartCollections.length === 0}
                            <div class="rounded-md bg-card px-3 py-2 text-xs text-muted-foreground">
                                No object collections yet.
                            </div>
                        {/if}
                    </div>
                {/if}
            </section>
        {/if}

        {#if savedSearches.length > 0}
            <section class="border-b border-sidebar-border p-4">
                <div class="mb-3 flex items-center gap-2">
                    <Bookmark size={14} class="text-primary" />
                    <h2 class="text-xs font-bold uppercase text-foreground">Saved Searches</h2>
                </div>
                <div class="space-y-1">
                    {#each savedSearches as saved (saved.id)}
                        <div class="flex items-center gap-1">
                            <button
                                class="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-xs transition-colors {activeSavedSearchId === saved.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                                onclick={() => onSavedSearchSelect(saved.id)}
                                title={saved.name}
                            >
                                <span class="block truncate font-semibold">{saved.name}</span>
                                <span class="block truncate text-[10px] opacity-75">{saved.search || "Filtered set"}</span>
                            </button>
                            <button
                                class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-reject"
                                onclick={() => onSavedSearchDelete(saved.id)}
                                title="Delete saved search"
                            >
                                <Trash2 size={13} />
                            </button>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}

        {#if photos.length > 0}
            <ExportPanel photos={photos} allPhotos={allPhotos} />
        {/if}

        {#if $stats && Object.keys($stats.cameras).length > 0}
            <section class="border-b border-sidebar-border p-4">
                <div class="mb-3 flex items-center gap-2">
                    <Camera size={14} class="text-primary" />
                    <h2 class="text-xs font-bold uppercase text-foreground">Top Cameras</h2>
                </div>
                <div class="space-y-2">
                    {#each Object.entries($stats.cameras)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 4) as [camera, count]}
                        <div class="flex items-center justify-between gap-3 text-sm">
                            <span class="truncate text-muted-foreground">{camera}</span>
                            <span class="font-semibold tabular-nums text-foreground">{count}</span>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}

        <section class="p-4">
            <div class="mb-3 flex items-center gap-2">
                <Filter size={14} class="text-primary" />
                <h2 class="text-xs font-bold uppercase text-foreground">Advanced Filters</h2>
                {#if activeFilterCount > 0}
                    <span class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">{activeFilterCount}</span>
                {/if}
                <button
                    class="ml-auto grid h-7 w-7 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onclick={() => (showFilters = !showFilters)}
                    title={showFilters ? "Collapse filters" : "Expand filters"}
                >
                    {#if showFilters}
                        <X size={14} />
                    {:else}
                        <Plus size={14} />
                    {/if}
                </button>
            </div>

            {#if showFilters}
                <div class="space-y-3">
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

                    {#if activeFilterCount > 0}
                        <button
                            class="h-8 w-full rounded-md bg-secondary px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            onclick={clearFilter}
                        >
                            Clear Advanced Filters
                        </button>
                    {/if}
                </div>
            {/if}
        </section>
    </div>
</aside>
