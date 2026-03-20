<script lang="ts">
    import { photoStore } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type { Photo } from "../types.ts";
    import {
        X,
        ChevronLeft,
        ChevronRight,
        Camera,
        Aperture,
        Clock,
        Image,
        Calendar,
        FileImage,
        Monitor,
        Loader2,
        ZoomIn,
        ZoomOut,
        Maximize2,
    } from "@lucide/svelte";
    import { onMount, onDestroy } from "svelte";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        startIndex?: number;
    }

    let { photos, allPhotos, startIndex = 0 }: Props = $props();

    let currentIndex = $state<number>(startIndex);
    const photo = $derived(photos[currentIndex]);
    const hasPrevious = $derived(currentIndex > 0);
    const hasNext = $derived(currentIndex < photos.length - 1);
    const isPaired = $derived(photo?.paired_with != null);

    // For paired RAW+JPEG, track which version we're viewing
    // Look up the pair in allPhotos (not displayPhotos, which collapses pairs)
    let viewingRaw = $state(false);
    const pairedPhoto = $derived(
        isPaired ? allPhotos.find((p) => p.id === photo.paired_with) : null,
    );
    const activePhoto = $derived(
        viewingRaw && pairedPhoto ? pairedPhoto : photo,
    );

    let fullResolutionImage = $state<ArrayBuffer | null>(null);
    let isLoadingFullRes = $state(false);
    let loadError = $state<string | null>(null);

    let currentBlobUrl = $state<string | null>(null);
    const preloadCache = new Map<string, string>();
    const preloadingSet = new Set<string>();

    // Zoom and pan state
    let zoomLevel = $state(1);
    let panX = $state(0);
    let panY = $state(0);
    let isPanning = $state(false);
    let panStartX = 0;
    let panStartY = 0;
    let imageContainer: HTMLDivElement | undefined = $state();

    const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
    const zoomPercent = $derived(Math.round(zoomLevel * 100));

    function resetZoom() {
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    }

    function zoomIn() {
        const nextIdx = ZOOM_STEPS.findIndex((z) => z > zoomLevel);
        if (nextIdx !== -1) {
            zoomLevel = ZOOM_STEPS[nextIdx];
        }
        if (zoomLevel <= 1) { panX = 0; panY = 0; }
    }

    function zoomOut() {
        const prevIdx = ZOOM_STEPS.slice().reverse().findIndex((z) => z < zoomLevel);
        if (prevIdx !== -1) {
            zoomLevel = ZOOM_STEPS[ZOOM_STEPS.length - 1 - prevIdx];
        }
        if (zoomLevel <= 1) { panX = 0; panY = 0; }
    }

    function handleWheel(e: WheelEvent) {
        e.preventDefault();
        if (e.deltaY < 0) {
            zoomIn();
        } else {
            zoomOut();
        }
    }

    function handlePointerDown(e: PointerEvent) {
        if (zoomLevel <= 1) return;
        isPanning = true;
        panStartX = e.clientX - panX;
        panStartY = e.clientY - panY;
        (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
    }

    function handlePointerMove(e: PointerEvent) {
        if (!isPanning) return;
        panX = e.clientX - panStartX;
        panY = e.clientY - panStartY;
    }

    function handlePointerUp() {
        isPanning = false;
    }

    function handleDoubleClick() {
        if (zoomLevel === 1) {
            zoomLevel = 3;
        } else {
            resetZoom();
        }
    }

    function revokeBlobUrl(url: string | null) {
        if (url) URL.revokeObjectURL(url);
    }

    onDestroy(() => {
        revokeBlobUrl(currentBlobUrl);
        for (const url of preloadCache.values()) {
            URL.revokeObjectURL(url);
        }
        preloadCache.clear();
    });

    function closeViewer() {
        photoStore.setViewMode("grid");
    }

    function navigatePrevious() {
        if (hasPrevious) {
            viewingRaw = false;
            resetZoom();
            currentIndex--;
            loadCurrentPhoto();
        }
    }

    function navigateNext() {
        if (hasNext) {
            viewingRaw = false;
            resetZoom();
            currentIndex++;
            loadCurrentPhoto();
        }
    }

    function toggleRawJpeg() {
        if (!isPaired) return;
        viewingRaw = !viewingRaw;
        loadPhotoByRef(activePhoto);
    }

    function handleKeydown(event: KeyboardEvent) {
        switch (event.key) {
            case "Escape":
                if (zoomLevel > 1) {
                    resetZoom();
                } else {
                    closeViewer();
                }
                break;
            case "ArrowLeft":
                navigatePrevious();
                break;
            case "ArrowRight":
                navigateNext();
                break;
            case "r":
            case "R":
                toggleRawJpeg();
                break;
            case "+":
            case "=":
                zoomIn();
                break;
            case "-":
                zoomOut();
                break;
            case "0":
                resetZoom();
                break;
        }
    }

    function formatFileSize(bytes: number): string {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    function formatDate(dateString: string): string {
        try {
            return new Date(dateString).toLocaleString();
        } catch {
            return dateString;
        }
    }

    function getThumbnailSrc(photo: Photo): string {
        if (photo.thumbnail) {
            return `data:image/jpeg;base64,${photo.thumbnail}`;
        }
        return "";
    }

    function getImageSrc(): string {
        if (currentBlobUrl) {
            return currentBlobUrl;
        }
        return getThumbnailSrc(activePhoto);
    }

    async function loadImageForPhoto(
        p: Photo,
    ): Promise<string | null> {
        if (!p) return null;
        try {
            const imageData = await HologramAPI.loadFullResolutionImage(
                p.file_path,
            );
            const uint8Array = new Uint8Array(imageData);
            const blob = new Blob([uint8Array], { type: "image/jpeg" });
            return URL.createObjectURL(blob);
        } catch {
            return null;
        }
    }

    async function loadPhotoByRef(p: Photo) {
        const cacheKey = p.id;
        const cached = preloadCache.get(cacheKey);
        if (cached) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = cached;
            preloadCache.delete(cacheKey);
            fullResolutionImage = new ArrayBuffer(0);
            isLoadingFullRes = false;
            loadError = null;
            return;
        }

        isLoadingFullRes = true;
        loadError = null;

        const blobUrl = await loadImageForPhoto(p);
        // Guard: user may have navigated away during load
        if (p.id !== activePhoto.id) {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            return;
        }
        if (blobUrl) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = blobUrl;
            fullResolutionImage = new ArrayBuffer(0);
        } else {
            loadError = "Failed to load image";
            fullResolutionImage = null;
        }
        isLoadingFullRes = false;
    }

    async function loadCurrentPhoto() {
        await loadPhotoByRef(activePhoto);
        preloadAdjacent();
    }

    function preloadAdjacent() {
        // Evict distant cache entries
        for (const [key, url] of preloadCache) {
            const idx = photos.findIndex((p) => p.id === key);
            if (idx === -1 || Math.abs(idx - currentIndex) > 2) {
                URL.revokeObjectURL(url);
                preloadCache.delete(key);
            }
        }

        const adjacentIndices = [currentIndex + 1, currentIndex - 1].filter(
            (i) => i >= 0 && i < photos.length,
        );

        for (const idx of adjacentIndices) {
            const p = photos[idx];
            if (
                !preloadCache.has(p.id) &&
                !preloadingSet.has(p.id)
            ) {
                preloadingSet.add(p.id);
                loadImageForPhoto(p).then((url) => {
                    preloadingSet.delete(p.id);
                    if (url) {
                        const currentIdx = photos.findIndex(
                            (pp) => pp.id === p.id,
                        );
                        if (Math.abs(currentIdx - currentIndex) <= 2) {
                            preloadCache.set(p.id, url);
                        } else {
                            URL.revokeObjectURL(url);
                        }
                    }
                });
            }
        }
    }

    onMount(() => {
        loadCurrentPhoto();
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
    class="fixed inset-0 bg-black z-[100] flex flex-col"
    role="dialog"
    onclick={closeViewer}
>
    <!-- Header -->
    <div
        class="flex items-center justify-between px-4 py-2 bg-black/80 border-b border-white/10 shrink-0"
    >
        <div class="flex items-center gap-4">
            <h2 class="text-white text-lg font-medium" style="margin: 0;">
                {activePhoto.file_name}
            </h2>
            <span class="text-gray-400 text-sm"
                >{currentIndex + 1} / {photos.length}</span
            >
            {#if isPaired}
                <button
                    class="text-xs px-3 py-1 rounded-full font-medium transition-colors {viewingRaw
                        ? 'bg-orange-600 text-white'
                        : 'bg-blue-600 text-white'}"
                    onclick={(e) => {
                        e.stopPropagation();
                        toggleRawJpeg();
                    }}
                >
                    {viewingRaw ? "RAW" : "JPEG"} — press R to toggle
                </button>
            {/if}
        </div>
        <button
            class="text-white/70 hover:text-white transition-colors p-1"
            onclick={closeViewer}
        >
            <X size={20} />
        </button>
    </div>

    <!-- Main Content -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="flex-1 flex min-h-0" onclick={(e) => e.stopPropagation()}>
        <!-- Image Display -->
        <div class="flex-1 flex items-center justify-center relative min-w-0 bg-black">
            {#if hasPrevious}
                <button
                    class="absolute left-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors z-10 bg-black/40 hover:bg-black/60 rounded-full p-2"
                    onclick={navigatePrevious}
                >
                    <ChevronLeft size={28} />
                </button>
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="w-full h-full flex items-center justify-center relative overflow-hidden"
                bind:this={imageContainer}
                onwheel={handleWheel}
                onpointerdown={handlePointerDown}
                onpointermove={handlePointerMove}
                onpointerup={handlePointerUp}
                ondblclick={handleDoubleClick}
                style="cursor: {zoomLevel > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default'};"
            >
                {#if isLoadingFullRes}
                    <div
                        class="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
                    >
                        <div
                            class="bg-black/70 text-white/90 px-4 py-2 rounded-lg flex items-center gap-2 text-sm"
                        >
                            <Loader2 size={16} class="animate-spin" />
                            Loading...
                        </div>
                    </div>
                {/if}

                {#if loadError && !currentBlobUrl}
                    <div class="text-white/50 text-center">
                        <div class="text-4xl mb-2">⚠️</div>
                        <p>{loadError}</p>
                    </div>
                {:else}
                    {#key activePhoto.id}
                        <img
                            src={getImageSrc()}
                            alt={activePhoto.file_name}
                            class="max-w-full max-h-full object-contain select-none"
                            class:opacity-50={isLoadingFullRes && !currentBlobUrl}
                            draggable="false"
                            style="transform: scale({zoomLevel}) translate({panX / zoomLevel}px, {panY / zoomLevel}px); transform-origin: center center; transition: {isPanning ? 'none' : 'transform 0.15s ease-out'};"
                        />
                    {/key}
                {/if}

                <!-- Zoom controls -->
                <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/60 rounded-full px-2 py-1 z-20">
                    <button
                        class="text-white/70 hover:text-white p-1 transition-colors"
                        onclick={(e) => { e.stopPropagation(); zoomOut(); }}
                    >
                        <ZoomOut size={16} />
                    </button>
                    <button
                        class="text-white/80 text-xs font-mono min-w-[3rem] text-center px-1 hover:text-white transition-colors"
                        onclick={(e) => { e.stopPropagation(); resetZoom(); }}
                    >
                        {zoomPercent}%
                    </button>
                    <button
                        class="text-white/70 hover:text-white p-1 transition-colors"
                        onclick={(e) => { e.stopPropagation(); zoomIn(); }}
                    >
                        <ZoomIn size={16} />
                    </button>
                    <button
                        class="text-white/70 hover:text-white p-1 transition-colors"
                        onclick={(e) => { e.stopPropagation(); resetZoom(); }}
                        title="Fit to screen (0)"
                    >
                        <Maximize2 size={16} />
                    </button>
                </div>

                <!-- Badges -->
                <div class="absolute top-4 right-4 flex flex-col gap-2 z-20">
                    {#if isPaired}
                        <div
                            class="bg-amber-600/90 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1"
                        >
                            <FileImage size={12} />
                            RAW+JPEG
                        </div>
                    {/if}
                    {#if fullResolutionImage}
                        <div
                            class="bg-green-600/90 text-white text-xs px-2 py-1 rounded-full"
                        >
                            Full Res
                        </div>
                    {/if}
                </div>
            </div>

            {#if hasNext}
                <button
                    class="absolute right-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors z-10 bg-black/40 hover:bg-black/60 rounded-full p-2"
                    onclick={navigateNext}
                >
                    <ChevronRight size={28} />
                </button>
            {/if}
        </div>

        <!-- Metadata Panel -->
        <div
            class="w-72 bg-amber-50 border-l border-amber-200 overflow-y-auto p-4 space-y-5 shrink-0"
        >
            <div class="space-y-2">
                <h3
                    class="text-xs font-semibold text-amber-800 uppercase tracking-wide"
                    style="margin: 0;"
                >
                    File Info
                </h3>
                <div class="space-y-2 text-sm">
                    <div class="flex items-center gap-2 text-amber-700">
                        <FileImage size={14} class="shrink-0" />
                        <span>{activePhoto.file_type} — {formatFileSize(activePhoto.file_size)}</span>
                    </div>
                    <div class="flex items-center gap-2 text-amber-700">
                        <Calendar size={14} class="shrink-0" />
                        <span>{formatDate(activePhoto.modified_at)}</span>
                    </div>
                </div>
            </div>

            {#if activePhoto.exif.camera_model || activePhoto.exif.camera_make}
                <div class="space-y-2">
                    <h3
                        class="text-xs font-semibold text-amber-800 uppercase tracking-wide"
                        style="margin: 0;"
                    >
                        Camera
                    </h3>
                    <div class="space-y-2 text-sm">
                        {#if activePhoto.exif.camera_model}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Camera size={14} class="shrink-0" />
                                <span>{activePhoto.exif.camera_make ?? ""} {activePhoto.exif.camera_model}</span>
                            </div>
                        {/if}
                        {#if activePhoto.exif.lens_model}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Aperture size={14} class="shrink-0" />
                                <span>{activePhoto.exif.lens_model}</span>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if activePhoto.exif.aperture || activePhoto.exif.shutter_speed || activePhoto.exif.iso || activePhoto.exif.focal_length}
                <div class="space-y-2">
                    <h3
                        class="text-xs font-semibold text-amber-800 uppercase tracking-wide"
                        style="margin: 0;"
                    >
                        Exposure
                    </h3>
                    <div class="space-y-2 text-sm">
                        {#if activePhoto.exif.aperture}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Aperture size={14} class="shrink-0" />
                                <span>f/{activePhoto.exif.aperture}</span>
                            </div>
                        {/if}
                        {#if activePhoto.exif.shutter_speed}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Clock size={14} class="shrink-0" />
                                <span>{activePhoto.exif.shutter_speed}</span>
                            </div>
                        {/if}
                        {#if activePhoto.exif.iso}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Image size={14} class="shrink-0" />
                                <span>ISO {activePhoto.exif.iso}</span>
                            </div>
                        {/if}
                        {#if activePhoto.exif.focal_length}
                            <div class="flex items-center gap-2 text-amber-700">
                                <Monitor size={14} class="shrink-0" />
                                <span>{activePhoto.exif.focal_length}mm</span>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if activePhoto.exif.width && activePhoto.exif.height}
                <div class="space-y-2">
                    <h3
                        class="text-xs font-semibold text-amber-800 uppercase tracking-wide"
                        style="margin: 0;"
                    >
                        Dimensions
                    </h3>
                    <div class="text-sm text-amber-700">
                        {activePhoto.exif.width} × {activePhoto.exif.height}
                    </div>
                </div>
            {/if}
        </div>
    </div>
</div>
