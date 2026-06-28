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
    import TimelineView from "../lib/components/TimelineView.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import { HologramAPI } from "../lib/api.ts";
    import { buildSmartCollections } from "../lib/collections.ts";
    import type { CullFlag, Photo, PhotoFilter, SavedSearch, ThumbnailReady } from "../lib/types.ts";
    import {
        Bookmark,
        CalendarRange,
        Check,
        Circle,
        FolderOpen,
        Grid,
        Keyboard,
        Loader2,
        Search,
        Save,
        SlidersHorizontal,
        Star,
        XCircle,
    } from "@lucide/svelte";

    type CullFilter = "all" | CullFlag;
    type Density = "compact" | "balanced" | "large";
    type LibraryView = "grid" | "timeline";

    let searchQuery = $state("");
    let sidebarFilter = $state<PhotoFilter>({});
    let cullFilter = $state<CullFilter>("all");
    let minRating = $state(0);
    let hideRejects = $state(false);
    let density = $state<Density>("balanced");
    let libraryView = $state<LibraryView>("grid");
    let savedSearches = $state<SavedSearch[]>([]);
    let activeSavedSearchId = $state<string | null>(null);
    let savedSearchName = $state("");
    let activeSmartCollectionId = $state<string | null>(null);
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    const searchCache = new Map<string, { key: string; text: string }>();

    const hasLibrary = $derived($photos.length > 0);
    const cursorPhoto = $derived($displayPhotos[$selectedIndex]);
    const pickedCount = $derived($displayPhotos.filter((photo) => photo.flag === "pick").length);
    const rejectedCount = $derived($displayPhotos.filter((photo) => photo.flag === "reject").length);
    const unmarkedCount = $derived(
        $displayPhotos.filter((photo) => (photo.flag ?? "none") === "none" && (photo.rating ?? 0) === 0).length,
    );
    const smartCollections = $derived(buildSmartCollections($photos));

    onMount(() => {
        loadSavedSearches();
        if (import.meta.env.DEV) {
            (window as any).__photoStore__ = photoStore;
            const seedHandler = ((e: CustomEvent) => {
                const { photos: seedPhotos, stats: seedStats } = e.detail;
                photoStore.setPhotos(seedPhotos);
                photoStore.setStats(seedStats);
                photoStore.loadMetadata(seedPhotos.map((photo: Photo) => photo.id));
            }) as EventListener;
            window.addEventListener("__hologram_seed__", seedHandler);
            return () => window.removeEventListener("__hologram_seed__", seedHandler);
        }
    });

    $effect(() => {
        const count = $displayPhotos.length;
        const index = $selectedIndex;
        if (count > 0 && index >= count) {
            photoStore.setSelectedIndex(count - 1);
        }
    });

    function handleSidebarFilter(filter: PhotoFilter) {
        sidebarFilter = filter;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function handleSearchInput() {
        if (searchTimer) clearTimeout(searchTimer);
        activeSavedSearchId = null;
        searchTimer = setTimeout(applyAllFilters, 140);
    }

    function setCullFilter(next: CullFilter) {
        cullFilter = next;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function setMinRating(next: number) {
        minRating = next;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function toggleHideRejects() {
        hideRejects = !hideRejects;
        activeSavedSearchId = null;
        applyAllFilters();
    }

    function loadSavedSearches() {
        try {
            const raw = localStorage.getItem("hologram.savedSearches");
            savedSearches = raw ? JSON.parse(raw) : [];
        } catch {
            savedSearches = [];
        }
    }

    function persistSavedSearches(next: SavedSearch[]) {
        savedSearches = next;
        localStorage.setItem("hologram.savedSearches", JSON.stringify(next));
    }

    function saveCurrentSearch() {
        const now = new Date().toISOString();
        const existing = activeSavedSearchId ? savedSearches.find((search) => search.id === activeSavedSearchId) : undefined;
        const name = savedSearchName.trim() || searchQuery.trim() || existing?.name || `Search ${savedSearches.length + 1}`;
        const saved: SavedSearch = {
            id: existing?.id ?? crypto.randomUUID(),
            name,
            filter: sidebarFilter,
            search: searchQuery,
            cull_filter: cullFilter,
            min_rating: minRating,
            hide_rejects: hideRejects,
            created_at: existing?.created_at ?? now,
            updated_at: now,
        };
        persistSavedSearches([saved, ...savedSearches.filter((item) => item.id !== saved.id)]);
        activeSavedSearchId = saved.id;
        savedSearchName = saved.name;
    }

    function selectSavedSearch(id: string) {
        const saved = savedSearches.find((item) => item.id === id);
        if (!saved) return;
        activeSavedSearchId = saved.id;
        savedSearchName = saved.name;
        sidebarFilter = { ...saved.filter };
        searchQuery = saved.search;
        cullFilter = saved.cull_filter;
        minRating = saved.min_rating;
        hideRejects = saved.hide_rejects;
        applyAllFilters();
    }

    function deleteSavedSearch(id: string) {
        persistSavedSearches(savedSearches.filter((item) => item.id !== id));
        if (activeSavedSearchId === id) {
            activeSavedSearchId = null;
            savedSearchName = "";
        }
    }

    function selectSmartCollection(id: string | null) {
        activeSmartCollectionId = id;
        applyAllFilters();
    }

    async function importFolder() {
        const folderPath = await HologramAPI.selectFolder();
        if (!folderPath) return;

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

    function applyAllFilters() {
        const filter: PhotoFilter = {
            ...sidebarFilter,
            search: searchQuery.trim() || undefined,
            rating_gte: minRating > 0 ? minRating : undefined,
            flag: cullFilter !== "all" ? cullFilter : undefined,
        };
        const allPhotos = photoStore.photos || [];
        const activeCollection = activeSmartCollectionId
            ? smartCollections.find((collection) => collection.id === activeSmartCollectionId)
            : null;
        const smartPhotoIds = activeCollection ? new Set(activeCollection.photo_ids) : null;
        photoStore.setFilter(filter);

        const filtered = allPhotos.filter((photo) => {
            const flag = photo.flag ?? "none";
            const rating = photo.rating ?? 0;

            if (smartPhotoIds && !smartPhotoIds.has(photo.id) && !(photo.paired_with && smartPhotoIds.has(photo.paired_with))) return false;
            if (hideRejects && filter.flag !== "reject" && flag === "reject") return false;
            if (filter.flag && flag !== filter.flag) return false;
            if (filter.rating_gte && rating < filter.rating_gte) return false;

            if (filter.search) {
                const q = filter.search.toLowerCase();
                if (!getSearchText(photo).includes(q)) return false;
            }

            if (filter.camera_make && (!photo.exif.camera_make || !photo.exif.camera_make.includes(filter.camera_make))) return false;
            if (filter.camera_model && (!photo.exif.camera_model || !photo.exif.camera_model.includes(filter.camera_model))) return false;
            if (filter.lens_model && (!photo.exif.lens_model || !photo.exif.lens_model.includes(filter.lens_model))) return false;
            if (filter.file_type && photo.file_type !== filter.file_type) return false;
            if (filter.shutter_speed && photo.exif.shutter_speed !== filter.shutter_speed) return false;
            if (filter.exposure_mode && photo.exif.exposure_mode !== filter.exposure_mode) return false;
            if (filter.flash && photo.exif.flash !== filter.flash) return false;
            if (filter.white_balance && photo.exif.white_balance !== filter.white_balance) return false;

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
            if (filter.tags && filter.tags.length > 0) {
                const photoTags = photo.tags ?? [];
                if (!filter.tags.every((tag) => photoTags.includes(tag))) return false;
            }
            return true;
        });

        photoStore.setFilteredPhotos(filtered);
        if (filtered.length > 0) {
            photoStore.setSelectedIndex(0);
        }
    }

    function getSearchText(photo: Photo): string {
        const key = [
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
            (photo.tags ?? []).join(" "),
            photo.notes,
            photo.rating,
            photo.flag,
        ].filter(Boolean).join("\u0001");
        const cached = searchCache.get(photo.id);
        if (cached?.key === key) return cached.text;
        const text = key.toLowerCase();
        searchCache.set(photo.id, { key, text });
        return text;
    }

    function segmentClass(active: boolean): string {
        return [
            "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors",
            active
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
        ].join(" ");
    }

    function iconButtonClass(active: boolean): string {
        return [
            "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-xs font-semibold transition-colors",
            active
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
        ].join(" ");
    }

    function formatAperture(value?: number): string {
        if (!value) return "";
        return `f/${value.toFixed(value % 1 === 0 ? 0 : 1)}`;
    }

    function formatFocalLength(value?: number): string {
        if (!value) return "";
        return `${Math.round(value)}mm`;
    }

    function exposureSummary(photo: Photo): string {
        return [
            formatAperture(photo.exif.aperture),
            photo.exif.shutter_speed,
            photo.exif.iso ? `ISO ${photo.exif.iso}` : "",
            formatFocalLength(photo.exif.focal_length),
        ].filter(Boolean).join("  ");
    }
</script>

<svelte:head>
    <title>Hologram - Lighttable</title>
</svelte:head>

<div class="flex h-screen overflow-hidden bg-background text-foreground">
    <Sidebar
        photos={$displayPhotos}
        allPhotos={$photos}
        filter={sidebarFilter}
        savedSearches={savedSearches}
        activeSavedSearchId={activeSavedSearchId}
        smartCollections={smartCollections}
        activeSmartCollectionId={activeSmartCollectionId}
        onFilter={handleSidebarFilter}
        onSavedSearchSelect={selectSavedSearch}
        onSavedSearchDelete={deleteSavedSearch}
        onSmartCollectionSelect={selectSmartCollection}
    />

    {#if !hasLibrary}
        <main class="flex min-w-0 flex-1 flex-col">
            <div class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/70 px-5">
                <div>
                    <div class="text-[10px] font-bold uppercase text-primary">Hologram</div>
                    <h1 class="text-sm font-semibold tracking-normal text-foreground">Lighttable</h1>
                </div>
            </div>

            <section class="grid min-h-0 flex-1 place-items-center px-8">
                <div class="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
                    <div class="mb-5 flex items-center gap-3">
                        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                            <FolderOpen size={22} />
                        </div>
                        <div>
                            <h2 class="text-base font-semibold tracking-normal text-foreground">No library loaded</h2>
                        </div>
                    </div>
                    <button
                        class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                        onclick={importFolder}
                    >
                        <FolderOpen size={18} />
                        Import Photos
                    </button>
                </div>
            </section>
        </main>
    {:else}
        <main class="flex min-w-0 flex-1 flex-col">
            {#if $isLoading}
                <div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                    <Loader2 size={32} class="animate-spin" />
                    <p class="mt-4 text-sm">Scanning photos...</p>
                </div>
            {:else}
                <div class="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-card/80 px-5">
                    <div class="min-w-[9rem]">
                        <div class="text-[10px] font-bold uppercase text-primary">Lighttable</div>
                        <h1 class="truncate text-sm font-semibold tracking-normal text-foreground">
                            {$displayPhotos.length} visible
                            <span class="text-muted-foreground">/ {$photos.length} files</span>
                        </h1>
                    </div>

                    <div class="relative min-w-[15rem] max-w-xl flex-1">
                        <Search size={16} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search filename, camera, lens, tags"
                            class="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                            bind:value={searchQuery}
                            oninput={handleSearchInput}
                        />
                    </div>

                    <div class="hidden items-center gap-1 lg:flex" aria-label="View mode">
                        <button class={segmentClass(libraryView === "grid")} onclick={() => (libraryView = "grid")}>
                            <Grid size={14} />
                            Grid
                        </button>
                        <button class={segmentClass(libraryView === "timeline")} onclick={() => (libraryView = "timeline")}>
                            <CalendarRange size={14} />
                            Timeline
                        </button>
                    </div>

                    <div class="hidden min-w-[14rem] items-center gap-1 2xl:flex" aria-label="Saved search">
                        <Bookmark size={14} class="shrink-0 text-muted-foreground" />
                        <input
                            class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                            placeholder="Search name"
                            bind:value={savedSearchName}
                        />
                        <button class={iconButtonClass(false)} onclick={saveCurrentSearch} title="Save search">
                            <Save size={14} />
                        </button>
                    </div>

                    <div class="hidden items-center gap-1 lg:flex" aria-label="Cull status filters">
                        <button class={segmentClass(cullFilter === "all")} onclick={() => setCullFilter("all")}>
                            <Grid size={14} />
                            All
                        </button>
                        <button class={segmentClass(cullFilter === "pick")} onclick={() => setCullFilter("pick")}>
                            <Check size={14} />
                            Picks
                        </button>
                        <button class={segmentClass(cullFilter === "reject")} onclick={() => setCullFilter("reject")}>
                            <XCircle size={14} />
                            Rejects
                        </button>
                        <button class={segmentClass(cullFilter === "none")} onclick={() => setCullFilter("none")}>
                            <Circle size={14} />
                            Unmarked
                        </button>
                    </div>

                    <div class="hidden items-center gap-1 xl:flex" aria-label="Minimum rating">
                        {#each [0, 1, 3, 5] as rating}
                            <button
                                class={iconButtonClass(minRating === rating)}
                                onclick={() => setMinRating(rating)}
                                title={rating === 0 ? "Any rating" : `${rating}+ stars`}
                            >
                                {#if rating === 0}
                                    Any
                                {:else}
                                    {rating}<Star size={12} fill="currentColor" />
                                {/if}
                            </button>
                        {/each}
                    </div>

                    <div class="hidden items-center gap-1 2xl:flex" aria-label="Thumbnail density">
                        {#each ["compact", "balanced", "large"] as size}
                            <button
                                class={iconButtonClass(density === size)}
                                onclick={() => (density = size as Density)}
                                title={`${size} thumbnails`}
                            >
                                {size === "compact" ? "S" : size === "balanced" ? "M" : "L"}
                            </button>
                        {/each}
                    </div>

                    <button
                        class={segmentClass(hideRejects)}
                        onclick={toggleHideRejects}
                        title="Hide rejected photos"
                    >
                        <XCircle size={14} />
                        Hide Rejects
                    </button>
                </div>

                {#if $displayPhotos.length === 0}
                    <div class="grid flex-1 place-items-center px-8 text-center">
                        <div class="max-w-sm rounded-lg border border-border bg-card p-6">
                            <h2 class="text-sm font-semibold uppercase text-foreground">No frames match</h2>
                            <p class="mt-2 text-sm text-muted-foreground">Relax the search, rating, flag, or EXIF filters.</p>
                        </div>
                    </div>
                {:else}
                    <div class="min-h-0 flex-1 overflow-y-auto bg-background">
                        {#if libraryView === "timeline"}
                            <TimelineView photos={$displayPhotos} density={density} />
                        {:else}
                            <PhotoGrid photos={$displayPhotos} density={density} />
                        {/if}
                    </div>

                    <div class="flex h-12 shrink-0 items-center justify-between gap-4 border-t border-border bg-card/80 px-5">
                        <div class="flex min-w-0 items-center gap-3">
                            {#if cursorPhoto}
                                <span class="truncate text-sm font-semibold text-foreground">{cursorPhoto.file_name}</span>
                                <span class="hidden truncate text-xs text-muted-foreground md:inline">
                                    {cursorPhoto.exif.camera_model ?? "Unknown camera"}
                                </span>
                                <span class="hidden truncate text-xs text-muted-foreground lg:inline">
                                    {exposureSummary(cursorPhoto)}
                                </span>
                            {/if}
                        </div>
                        <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                            <span class="tabular-nums">{pickedCount} picks</span>
                            <span class="tabular-nums">{rejectedCount} rejects</span>
                            <span class="tabular-nums">{unmarkedCount} unmarked</span>
                        </div>
                    </div>
                {/if}
            {/if}
        </main>
    {/if}

    {#if $viewMode === "viewer"}
        <PhotoViewer photos={$displayPhotos} allPhotos={$filteredPhotos} startIndex={$selectedIndex} />
    {/if}
</div>
