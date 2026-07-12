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
    import AutoCullView from "../lib/components/AutoCullView.svelte";
    import TimelineView from "../lib/components/TimelineView.svelte";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import PhotoViewer from "../lib/components/PhotoViewer.svelte";
    import ExportPanel from "../lib/components/ExportPanel.svelte";
    import SettingsPanel from "../lib/components/SettingsPanel.svelte";
    import { HologramAPI } from "../lib/api.ts";
    import { buildSmartCollections } from "../lib/collections.ts";
    import { indexPhotoVisuals } from "../lib/visualIndex.ts";
    import { photoPreviewSrc } from "../lib/photoPreview.ts";
    import type { CullFlag, Photo, PhotoFilter, SavedSearch, ThumbnailReady, VisualIndexEntry, VisualIndexProgress } from "../lib/types.ts";
    import {
        Check,
        Circle,
        Download,
        FolderOpen,
        Image as ImageIcon,
        LayoutGrid,
        Loader2,
        Minus,
        Plus,
        Rows3,
        Save,
        Search,
        Settings,
        Sparkles,
        Star,
        XCircle,
    } from "@lucide/svelte";

    type CullFilter = "all" | CullFlag;
    type LegacyDensity = "compact" | "balanced" | "large" | "lightbox";
    type GridDetails = "image" | "essentials" | "metadata";
    type LibraryView = "grid" | "timeline";
    type RailView = "library" | "autocull" | "export" | "settings";
    const GRID_PREFERENCES_KEY = "hologram.gridPreferences";
    const GRID_ZOOM_STEPS = [120, 150, 180, 220, 270, 340, 430, 520] as const;
    const DEFAULT_GRID_ZOOM_LEVEL = 3;

    let searchQuery = $state("");
    let sidebarFilter = $state<PhotoFilter>({});
    let cullFilter = $state<CullFilter>("all");
    let minRating = $state(0);
    let hideRejects = $state(false);
    let gridZoomLevel = $state(DEFAULT_GRID_ZOOM_LEVEL);
    let gridDetailMode = $state<GridDetails>("metadata");
    let libraryView = $state<LibraryView>("grid");
    let railView = $state<RailView>("library");
    let searchInput = $state<HTMLInputElement>();
    let savedSearches = $state<SavedSearch[]>([]);
    let activeSavedSearchId = $state<string | null>(null);
    let savedSearchName = $state("");
    let activeSmartCollectionId = $state<string | null>(null);
    let didLoadGridPreferences = $state(false);
    let smartCollectionsEnabled = $state(false);
    let showSmartCollectionsModal = $state(false);
    let isVisualIndexing = $state(false);
    let visualIndex = $state<Record<string, VisualIndexEntry>>({});
    let visualIndexProgress = $state<VisualIndexProgress>({ current: 0, total: 0 });
    let visualIndexLibraryKey = $state("");
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    const searchCache = new Map<string, { key: string; text: string }>();

    const hasLibrary = $derived($photos.length > 0);
    const cursorPhoto = $derived($displayPhotos[$selectedIndex]);
    const smartCollections = $derived(
        smartCollectionsEnabled ? buildSmartCollections($photos, visualIndex) : [],
    );
    const gridTileSize = $derived(GRID_ZOOM_STEPS[gridZoomLevel] ?? GRID_ZOOM_STEPS[DEFAULT_GRID_ZOOM_LEVEL]);
    const maxGridZoomLevel = GRID_ZOOM_STEPS.length - 1;

    // Session totals are library-wide (independent of the active filter), for the HUD.
    const sessionPicks = $derived($photos.filter((photo) => photo.flag === "pick").length);
    const sessionRejects = $derived($photos.filter((photo) => photo.flag === "reject").length);
    const reviewedCount = $derived(
        $photos.filter((photo) => photo.flag === "pick" || photo.flag === "reject" || (photo.rating ?? 0) > 0).length,
    );
    const reviewPct = $derived($photos.length ? Math.round((reviewedCount / $photos.length) * 100) : 0);
    const effectiveRail = $derived<RailView>(hasLibrary || railView === "settings" ? railView : "library");
    const RATING_STEPS = [0, 1, 3, 5] as const;

    let previewScopeIds = $state<string[] | null>(null);
    let previewStartIndex = $state(0);
    let previewConfirmCluster = $state<(() => void) | null>(null);
    let previewPreloadIds = $state<string[]>([]);
    const previewPhotos = $derived(
        previewScopeIds
            ? previewScopeIds
                  .map((id) => $displayPhotos.find((photo) => photo.id === id))
                  .filter((photo): photo is Photo => Boolean(photo))
            : $displayPhotos,
    );
    const previewPreloadPhotos = $derived(
        previewPreloadIds
            .map((id) => $displayPhotos.find((photo) => photo.id === id))
            .filter((photo): photo is Photo => Boolean(photo)),
    );

    function openScopedPreview(
        photoIds: string[],
        selectedPhotoId: string,
        onConfirmCluster?: () => void,
        preloadPhotoIds: string[] = [],
    ) {
        previewScopeIds = photoIds;
        previewStartIndex = Math.max(0, photoIds.indexOf(selectedPhotoId));
        previewConfirmCluster = onConfirmCluster ?? null;
        previewPreloadIds = preloadPhotoIds;
        photoStore.setViewMode("viewer");
    }

    $effect(() => {
        if ($viewMode !== "viewer") {
            previewScopeIds = null;
            previewConfirmCluster = null;
            previewPreloadIds = [];
        }
    });

    function cycleMinRating() {
        const idx = RATING_STEPS.indexOf(minRating as (typeof RATING_STEPS)[number]);
        setMinRating(RATING_STEPS[(idx + 1) % RATING_STEPS.length]);
    }

    onMount(() => {
        loadSavedSearches();
        loadSmartCollectionState();
        loadGridPreferences();
        didLoadGridPreferences = true;
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
        if (!didLoadGridPreferences) return;
        localStorage.setItem(
            GRID_PREFERENCES_KEY,
            JSON.stringify({ zoomLevel: gridZoomLevel, detailMode: gridDetailMode }),
        );
    });

    $effect(() => {
        const ids = $photos.map((photo) => photo.id).join("|");
        if (!smartCollectionsEnabled || !ids || isVisualIndexing || ids === visualIndexLibraryKey) return;
        visualIndexLibraryKey = ids;
        void startVisualIndexing($photos);
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

    function setGridZoomLevel(next: number) {
        gridZoomLevel = Math.max(0, Math.min(maxGridZoomLevel, Math.round(next)));
    }

    function adjustGridZoom(delta: number) {
        setGridZoomLevel(gridZoomLevel + delta);
    }

    function setGridDetailMode(next: GridDetails) {
        gridDetailMode = next;
    }

    function resetGridPreferences() {
        gridZoomLevel = DEFAULT_GRID_ZOOM_LEVEL;
        gridDetailMode = "metadata";
    }

    function isLegacyDensity(value: unknown): value is LegacyDensity {
        return value === "compact" || value === "balanced" || value === "large" || value === "lightbox";
    }

    function isGridDetails(value: unknown): value is GridDetails {
        return value === "image" || value === "essentials" || value === "metadata";
    }

    function zoomLevelFromDensity(value: unknown): number | null {
        if (!isLegacyDensity(value)) return null;
        if (value === "compact") return 1;
        if (value === "large") return 4;
        if (value === "lightbox") return maxGridZoomLevel;
        return DEFAULT_GRID_ZOOM_LEVEL;
    }

    function loadGridPreferences() {
        try {
            const raw = localStorage.getItem(GRID_PREFERENCES_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw) as { zoomLevel?: unknown; density?: unknown; detailMode?: unknown };
            if (typeof saved.zoomLevel === "number") {
                setGridZoomLevel(saved.zoomLevel);
            } else {
                const migratedZoomLevel = zoomLevelFromDensity(saved.density);
                if (migratedZoomLevel != null) setGridZoomLevel(migratedZoomLevel);
            }
            if (isGridDetails(saved.detailMode)) gridDetailMode = saved.detailMode;
        } catch {
            gridZoomLevel = DEFAULT_GRID_ZOOM_LEVEL;
            gridDetailMode = "metadata";
        }
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
        if (!smartCollectionsEnabled) {
            showSmartCollectionsModal = true;
            return;
        }
        activeSmartCollectionId = id;
        applyAllFilters();
    }

    function loadSmartCollectionState() {
        smartCollectionsEnabled = localStorage.getItem("hologram.smartCollections.enabled") === "true";
        try {
            const raw = localStorage.getItem("hologram.visualIndex");
            visualIndex = raw ? JSON.parse(raw) : {};
        } catch {
            visualIndex = {};
        }
    }

    function persistVisualIndex(entries: Record<string, VisualIndexEntry>) {
        visualIndex = entries;
        localStorage.setItem("hologram.visualIndex", JSON.stringify(entries));
    }

    function openSmartCollectionsModal() {
        if (smartCollectionsEnabled) return;
        showSmartCollectionsModal = true;
    }

    function enableSmartCollections() {
        smartCollectionsEnabled = true;
        localStorage.setItem("hologram.smartCollections.enabled", "true");
        showSmartCollectionsModal = false;
        activeSmartCollectionId = null;
        if ($photos.length > 0) {
            visualIndexLibraryKey = $photos.map((photo) => photo.id).join("|");
            void startVisualIndexing($photos);
        }
    }

    function setSmartCollectionsEnabled(enabled: boolean) {
        if (enabled) {
            enableSmartCollections();
            return;
        }
        smartCollectionsEnabled = false;
        activeSmartCollectionId = null;
        localStorage.setItem("hologram.smartCollections.enabled", "false");
        applyAllFilters();
    }

    async function startVisualIndexing(items: Photo[]) {
        if (isVisualIndexing || items.length === 0) return;
        isVisualIndexing = true;
        visualIndexProgress = { current: 0, total: items.length };
        try {
            const entries = await indexPhotoVisuals(
                items,
                (progress) => {
                    visualIndexProgress = progress;
                },
                visualIndex,
            );
            persistVisualIndex(entries);
        } finally {
            isVisualIndexing = false;
        }
    }

    async function importFolder() {
        const folderPath = await HologramAPI.selectFolder();
        if (!folderPath) return;

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

    function displaySegmentClass(active: boolean): string {
        return [
            "grid h-8 w-9 place-items-center border-r border-border text-xs transition-colors last:border-r-0",
            active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
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

{#snippet railBtn(Icon: any, active: boolean, label: string, onclick: () => void, dot = false)}
    <button
        class="relative grid h-9 w-9 place-items-center rounded-lg transition-colors {active ? 'bg-secondary' : 'hover:bg-secondary/60'}"
        {onclick}
        title={label}
        aria-label={label}
        aria-pressed={active}
    >
        <Icon size={16} class={active ? "text-primary" : "text-muted-foreground"} />
        {#if dot}<span class="absolute right-1.5 top-1.5 h-[7px] w-[7px] rounded-full bg-info"></span>{/if}
    </button>
{/snippet}

<div class="flex h-screen overflow-hidden bg-background text-foreground">
    <!-- ICON RAIL -->
    <nav class="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-border bg-rail py-3">
        <div class="mb-3.5 h-5 w-5 rotate-45 rounded border-2 border-primary" title="Hologram"></div>
        {@render railBtn(LayoutGrid, effectiveRail === "library", "Grid", () => (railView = "library"))}
        {@render railBtn(Sparkles, effectiveRail === "autocull", "AutoCull", () => { if (hasLibrary) railView = "autocull"; }, isVisualIndexing)}
        {@render railBtn(Download, effectiveRail === "export", "Export", () => { if (hasLibrary) railView = "export"; })}
        <div class="flex-1"></div>
        {@render railBtn(Settings, effectiveRail === "settings", "Settings", () => (railView = "settings"))}
    </nav>

    {#if effectiveRail === "settings"}
        <SettingsPanel
            {gridZoomLevel}
            {maxGridZoomLevel}
            {gridTileSize}
            gridDetailMode={gridDetailMode}
            {smartCollectionsEnabled}
            onGridZoomChange={setGridZoomLevel}
            onGridDetailChange={setGridDetailMode}
            onSmartCollectionsChange={setSmartCollectionsEnabled}
            onResetGridPreferences={resetGridPreferences}
        />
    {:else if effectiveRail === "autocull"}
        <div class="min-w-0 flex-1 overflow-y-auto bg-background">
            <AutoCullView photos={$displayPhotos} allPhotos={$photos} onOpenPreview={openScopedPreview} />
        </div>
    {:else if effectiveRail === "export"}
        <div class="min-w-0 flex-1 overflow-y-auto bg-background">
            <ExportPanel photos={$displayPhotos} allPhotos={$photos} />
        </div>
    {:else}
    <Sidebar
        photos={$displayPhotos}
        allPhotos={$photos}
        filter={sidebarFilter}
        savedSearches={savedSearches}
        activeSavedSearchId={activeSavedSearchId}
        smartCollections={smartCollections}
        activeSmartCollectionId={activeSmartCollectionId}
        smartCollectionsEnabled={smartCollectionsEnabled}
        smartCollectionsIndexing={isVisualIndexing}
        visualIndexProgress={visualIndexProgress}
        onFilter={handleSidebarFilter}
        onSavedSearchSelect={selectSavedSearch}
        onSavedSearchDelete={deleteSavedSearch}
        onSmartCollectionSelect={selectSmartCollection}
        onSmartCollectionsTitleClick={openSmartCollectionsModal}
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
                <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
                    <!-- search -->
                    <div class="relative w-[300px] shrink-0">
                        <Search size={13} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
                        <input
                            bind:this={searchInput}
                            type="text"
                            placeholder="Search filename, EXIF, tags…"
                            class="h-8 w-full rounded-md border border-border bg-popover pl-8 pr-8 text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                            bind:value={searchQuery}
                            oninput={handleSearchInput}
                        />
                        <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-[5px] py-px font-mono text-[10px] text-subtle">/</span>
                    </div>

                    <!-- cull status -->
                    <div class="flex overflow-hidden rounded-md border border-border font-sans text-[11px] font-medium">
                        <button class="px-[11px] py-[6px] transition-colors {cullFilter === 'all' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => setCullFilter("all")}>All</button>
                        <button class="px-[11px] py-[6px] transition-colors {cullFilter === 'pick' ? 'bg-secondary text-pick' : 'text-pick/80 hover:text-pick'}" onclick={() => setCullFilter("pick")}>Picks {sessionPicks}</button>
                        <button class="px-[11px] py-[6px] transition-colors {cullFilter === 'reject' ? 'bg-secondary text-reject' : 'text-reject/80 hover:text-reject'}" onclick={() => setCullFilter("reject")}>Rejects {sessionRejects}</button>
                        <button class="px-[11px] py-[6px] transition-colors {cullFilter === 'none' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => setCullFilter("none")}>Unmarked</button>
                    </div>

                    <!-- rating -->
                    <button
                        class="rounded-md border border-border px-[10px] py-[6px] font-sans text-[11px] font-medium whitespace-nowrap transition-colors hover:text-foreground {minRating > 0 ? 'text-foreground' : 'text-muted-foreground'}"
                        onclick={cycleMinRating}
                        title="Minimum rating filter"
                    >
                        <span class="text-rating">★</span> {minRating === 0 ? "any" : `${minRating}+`}
                    </button>

                    <!-- hide rejects switch -->
                    <button class="flex items-center gap-1.5 whitespace-nowrap font-sans text-[11px] font-medium text-muted-foreground" onclick={toggleHideRejects} aria-pressed={hideRejects}>
                        <span class="relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors {hideRejects ? 'bg-primary' : 'bg-secondary'}">
                            <span class="absolute top-[2px] h-[11px] w-[11px] rounded-full transition-all {hideRejects ? 'right-[2px] bg-background' : 'left-[2px] bg-muted-foreground'}"></span>
                        </span>
                        Hide rejects
                    </button>

                    <div class="flex-1"></div>

                    <!-- indexing status -->
                    {#if isVisualIndexing}
                        <div class="flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-info">
                            <span class="h-1.5 w-1.5 rounded-full bg-info"></span>
                            indexing {visualIndexProgress.current}/{visualIndexProgress.total}
                        </div>
                    {/if}

                    <!-- view toggle -->
                    <div class="flex gap-2 font-mono text-[11px] font-medium">
                        <button class={libraryView === "grid" ? "text-foreground" : "text-subtle hover:text-muted-foreground"} onclick={() => (libraryView = "grid")}>GRID</button>
                        <button class={libraryView === "timeline" ? "text-foreground" : "text-subtle hover:text-muted-foreground"} onclick={() => (libraryView = "timeline")}>TIMELINE</button>
                    </div>

                    <!-- save search -->
                    <button class="grid h-7 w-7 place-items-center rounded-md text-subtle transition-colors hover:bg-secondary hover:text-foreground" onclick={saveCurrentSearch} title="Save current search">
                        <Save size={13} />
                    </button>

                    {#if libraryView === "grid"}
                        <div class="h-4 w-px bg-border"></div>
                        <div class="flex items-center gap-1.5 text-subtle" aria-label="Thumbnail zoom">
                            <button class="grid h-6 w-6 place-items-center rounded transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30" onclick={() => adjustGridZoom(-1)} disabled={gridZoomLevel === 0} aria-label="Zoom out"><Minus size={13} /></button>
                            <input class="grid-zoom-slider h-6 w-16" type="range" min="0" max={maxGridZoomLevel} step="1" value={gridZoomLevel} oninput={(event) => setGridZoomLevel(Number(event.currentTarget.value))} title={`Thumbnail size ${gridTileSize}px`} aria-label="Grid thumbnail size" />
                            <button class="grid h-6 w-6 place-items-center rounded transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30" onclick={() => adjustGridZoom(1)} disabled={gridZoomLevel === maxGridZoomLevel} aria-label="Zoom in"><Plus size={13} /></button>
                        </div>
                        <div class="inline-flex h-7 overflow-hidden rounded-md border border-border" aria-label="Grid details">
                            <button class={displaySegmentClass(gridDetailMode === "image")} onclick={() => setGridDetailMode("image")} title="Images only" aria-pressed={gridDetailMode === "image"}><ImageIcon size={13} /></button>
                            <button class={displaySegmentClass(gridDetailMode === "essentials")} onclick={() => setGridDetailMode("essentials")} title="Title and stars" aria-pressed={gridDetailMode === "essentials"}><Star size={13} fill={gridDetailMode === "essentials" ? "currentColor" : "none"} /></button>
                            <button class={displaySegmentClass(gridDetailMode === "metadata")} onclick={() => setGridDetailMode("metadata")} title="Full metadata" aria-pressed={gridDetailMode === "metadata"}><Rows3 size={13} /></button>
                        </div>
                    {/if}
                </div>

                {#if $displayPhotos.length === 0}
                    <div class="grid flex-1 place-items-center px-8 text-center">
                        <div class="max-w-sm rounded-lg border border-border bg-card p-6">
                            <div class="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">No results</div>
                            <h2 class="mt-1.5 text-sm font-semibold text-foreground">No frames match</h2>
                            <p class="mt-2 text-[13px] text-muted-foreground">Relax the search, rating, flag, or EXIF filters.</p>
                        </div>
                    </div>
                {:else}
                    <div class="min-h-0 flex-1 overflow-y-auto bg-background">
                        {#if libraryView === "timeline"}
                            <TimelineView photos={$displayPhotos} tileMinWidth={gridTileSize} />
                        {:else}
                            <PhotoGrid photos={$displayPhotos} tileMinWidth={gridTileSize} detailMode={gridDetailMode} />
                        {/if}
                    </div>

                    <!-- HUD -->
                    <div class="flex h-[58px] shrink-0 items-center gap-5 border-t border-border bg-card px-4">
                        {#if cursorPhoto}
                            <div class="flex min-w-0 items-center gap-3">
                                <div class="h-[38px] w-[38px] shrink-0 overflow-hidden rounded bg-secondary outline outline-[1.5px] outline-primary">
                                    {#if photoPreviewSrc(cursorPhoto)}
                                        <img src={photoPreviewSrc(cursorPhoto)} alt="" class="h-full w-full object-cover" />
                                    {/if}
                                </div>
                                <div class="min-w-0 whitespace-nowrap">
                                    <div class="truncate font-mono text-[12px] font-semibold text-foreground">
                                        {cursorPhoto.file_name}{#if cursorPhoto.paired_with}<span class="text-subtle"> + pair</span>{/if}
                                    </div>
                                    <div class="truncate font-mono text-[11px] text-muted-foreground">
                                        {cursorPhoto.exif.camera_model ?? "—"} · <span class="text-foreground">{exposureSummary(cursorPhoto) || "—"}</span>
                                    </div>
                                </div>
                            </div>
                        {/if}

                        <div class="flex-1"></div>

                        <div class="flex items-center gap-3.5 whitespace-nowrap font-mono text-[11px] font-medium">
                            <span class="text-muted-foreground">reviewed <span class="text-foreground">{reviewedCount}/{$photos.length}</span></span>
                            <span class="relative h-1 w-[120px] shrink-0 overflow-hidden rounded-full bg-secondary">
                                <span class="absolute left-0 top-0 h-full rounded-full bg-primary" style:width={`${reviewPct}%`}></span>
                            </span>
                            <span class="text-pick">✓ {sessionPicks}</span>
                            <span class="text-reject">✕ {sessionRejects}</span>
                        </div>

                        <div class="flex gap-1.5 whitespace-nowrap font-mono text-[10px] text-subtle">
                            <span class="rounded border border-border px-1.5 py-[3px]">P pick</span>
                            <span class="rounded border border-border px-1.5 py-[3px]">X reject</span>
                            <span class="rounded border border-border px-1.5 py-[3px]">␣ open</span>
                        </div>
                    </div>
                {/if}
            {/if}
        </main>
    {/if}
    {/if}

    {#if showSmartCollectionsModal}
        <div class="fixed inset-0 z-[90] grid place-items-center bg-black/60 px-4">
            <section class="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
                <div class="mb-4 flex items-start gap-3">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                        <Sparkles size={20} />
                    </div>
                    <div class="min-w-0">
                        <h2 class="text-base font-semibold text-foreground">Enable Smart Collections?</h2>
                        <p class="mt-1 text-sm text-muted-foreground">
                            Hologram will index previews locally in the background to build visual collections.
                        </p>
                    </div>
                </div>
                <div class="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
                    The current index uses local thumbnail analysis and existing content labels. A bundled object detector can plug into the same index later.
                </div>
                <div class="mt-5 flex justify-end gap-2">
                    <button
                        class="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onclick={() => (showSmartCollectionsModal = false)}
                    >
                        Cancel
                    </button>
                    <button
                        class="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                        onclick={enableSmartCollections}
                    >
                        <Sparkles size={15} />
                        Enable Indexing
                    </button>
                </div>
            </section>
        </div>
    {/if}

    {#if $viewMode === "viewer"}
        <PhotoViewer
            photos={previewPhotos}
            allPhotos={$filteredPhotos}
            startIndex={previewScopeIds ? previewStartIndex : $selectedIndex}
            onConfirmCluster={previewConfirmCluster}
            backgroundPreloadPhotos={previewPreloadPhotos}
        />
    {/if}
</div>
