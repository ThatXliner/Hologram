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
    } from "@lucide/svelte";
    import { onMount, onDestroy } from "svelte";

    interface Props {
        photos: Photo[];
    }

    let { photos }: Props = $props();

    let currentIndex = $state<number>(0);
    const photo = $derived(photos[currentIndex]);
    const hasPrevious = $derived(currentIndex > 0);
    const hasNext = $derived(currentIndex < photos.length - 1);

    let fullResolutionImage = $state<ArrayBuffer | null>(null);
    let isLoadingFullRes = $state(false);
    let loadError = $state<string | null>(null);

    // Cache blob URLs to avoid recreating them + enable cleanup
    let currentBlobUrl = $state<string | null>(null);
    // Preload cache: index -> blob URL
    const preloadCache = new Map<number, string>();
    // Track in-flight preloads to avoid duplicates
    const preloadingSet = new Set<number>();

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
            currentIndex--;
            loadCurrentPhoto();
        }
    }

    function navigateNext() {
        if (hasNext) {
            currentIndex++;
            loadCurrentPhoto();
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        switch (event.key) {
            case "Escape":
                closeViewer();
                break;
            case "ArrowLeft":
                navigatePrevious();
                break;
            case "ArrowRight":
                navigateNext();
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
        return "/placeholder-image.svg";
    }

    function getImageSrc(photo: Photo): string {
        if (currentBlobUrl && photo.file_type === "JPG") {
            return currentBlobUrl;
        }
        return getThumbnailSrc(photo);
    }

    async function loadImageForIndex(index: number): Promise<string | null> {
        const p = photos[index];
        if (!p) return null;
        try {
            const imageData = await HologramAPI.loadFullResolutionImage(p.file_path);
            const uint8Array = new Uint8Array(imageData);
            const blob = new Blob([uint8Array], { type: "image/jpeg" });
            return URL.createObjectURL(blob);
        } catch {
            return null;
        }
    }

    async function loadCurrentPhoto() {
        // Check preload cache first
        const cached = preloadCache.get(currentIndex);
        if (cached) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = cached;
            preloadCache.delete(currentIndex);
            fullResolutionImage = new ArrayBuffer(0); // truthy marker
            isLoadingFullRes = false;
            loadError = null;
            preloadAdjacent();
            return;
        }

        isLoadingFullRes = true;
        loadError = null;

        const blobUrl = await loadImageForIndex(currentIndex);
        if (blobUrl) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = blobUrl;
            fullResolutionImage = new ArrayBuffer(0);
        } else {
            loadError = "Failed to load high-quality image";
            fullResolutionImage = null;
        }
        isLoadingFullRes = false;

        preloadAdjacent();
    }

    function preloadAdjacent() {
        // Evict distant cache entries
        for (const [idx, url] of preloadCache) {
            if (Math.abs(idx - currentIndex) > 2) {
                URL.revokeObjectURL(url);
                preloadCache.delete(idx);
            }
        }

        const toPreload = [currentIndex + 1, currentIndex - 1].filter(
            (i) => i >= 0 && i < photos.length && !preloadCache.has(i) && !preloadingSet.has(i),
        );

        for (const idx of toPreload) {
            preloadingSet.add(idx);
            loadImageForIndex(idx).then((url) => {
                preloadingSet.delete(idx);
                if (url) {
                    // Only cache if still relevant
                    if (Math.abs(idx - currentIndex) <= 2) {
                        preloadCache.set(idx, url);
                    } else {
                        URL.revokeObjectURL(url);
                    }
                }
            });
        }
    }

    onMount(() => {
        loadCurrentPhoto();
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<div
    class="fixed top-0 left-0 right-0 bottom-0 bg-black/95 z-50 flex flex-col"
    onclick={closeViewer}
>
    <!-- Header -->
    <div class="flex items-center justify-between p-4 bg-black/50">
        <div class="flex items-center gap-4">
            <h2 class="text-white text-lg font-medium" style="margin: 0;">
                {photo.file_name}
            </h2>
            <span class="text-gray-300 text-sm"
                >{currentIndex + 1} of {photos.length}</span
            >
        </div>
        <button
            class="text-white hover:text-gray-300 transition-colors"
            onclick={closeViewer}
        >
            <X size={24} />
        </button>
    </div>

    <!-- Main Content -->
    <div class="flex-1 flex" onclick={(e) => e.stopPropagation()}>
        <!-- Image Display -->
        <div class="flex-1 flex items-center justify-center relative">
            {#if hasPrevious}
                <button
                    class="absolute top-1/2 transform -translate-y-1/2 text-white hover:text-gray-300 transition-colors z-10 bg-black/20 hover:bg-black/40 rounded-full p-2 left-4"
                    onclick={navigatePrevious}
                >
                    <ChevronLeft size={32} />
                </button>
            {/if}

            <div class="relative max-w-full max-h-full">
                {#if isLoadingFullRes}
                    <div
                        class="absolute inset-0 bg-black/20 flex items-center justify-center z-20"
                    >
                        <div
                            class="bg-black/60 text-white px-4 py-2 rounded-lg flex items-center gap-2"
                        >
                            <Loader2 size={16} class="animate-spin" />
                            Loading high-quality image...
                        </div>
                    </div>
                {/if}

                {#if loadError}
                    <div
                        class="absolute top-4 left-4 bg-red-500 text-white text-sm px-3 py-1 rounded-lg z-20"
                    >
                        {loadError}
                    </div>
                {/if}
                {#key photo.id}
                    <img
                        src={getImageSrc(photo)}
                        alt={photo.file_name}
                        class="max-w-full max-h-full object-contain transition-opacity duration-300"
                        class:opacity-75={isLoadingFullRes}
                    />
                {/key}

                <div class="absolute top-4 right-4 flex flex-col gap-2">
                    {#if photo.paired_with}
                        <div
                            class="bg-amber-600 text-white text-sm px-3 py-1 rounded-full flex items-center gap-2"
                        >
                            <FileImage size={16} />
                            RAW+JPEG Pair
                        </div>
                    {/if}

                    {#if fullResolutionImage}
                        <div
                            class="bg-green-600 text-white text-xs px-2 py-1 rounded-full"
                        >
                            High Quality
                        </div>
                    {/if}
                </div>
            </div>

            {#if hasNext}
                <button
                    class="absolute top-1/2 transform -translate-y-1/2 text-white hover:text-gray-300 transition-colors z-10 bg-black/20 hover:bg-black/40 rounded-full p-2 right-4"
                    onclick={navigateNext}
                >
                    <ChevronRight size={32} />
                </button>
            {/if}
        </div>

        <!-- Metadata Panel -->
        <div
            class="w-80 bg-amber-50 border-l border-amber-200 overflow-y-auto p-4 space-y-6"
        >
            <div class="space-y-3">
                <h3
                    class="text-sm font-semibold text-amber-900 mb-3"
                    style="margin: 0;"
                >
                    File Information
                </h3>
                <div class="space-y-3">
                    <div class="flex items-start gap-3">
                        <FileImage size={16} />
                        <div>
                            <div class="text-xs text-amber-600 font-medium">
                                File Type
                            </div>
                            <div class="text-sm text-amber-900">
                                {photo.file_type}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-start gap-3">
                        <Monitor size={16} />
                        <div>
                            <div class="text-xs text-amber-600 font-medium">
                                File Size
                            </div>
                            <div class="text-sm text-amber-900">
                                {formatFileSize(photo.file_size)}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-start gap-3">
                        <Calendar size={16} />
                        <div>
                            <div class="text-xs text-amber-600 font-medium">
                                Modified
                            </div>
                            <div class="text-sm text-amber-900">
                                {formatDate(photo.modified_at)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {#if photo.exif.camera_model || photo.exif.camera_make}
                <div class="space-y-3">
                    <h3
                        class="text-sm font-semibold text-amber-900 mb-3"
                        style="margin: 0;"
                    >
                        Camera Information
                    </h3>
                    <div class="space-y-3">
                        {#if photo.exif.camera_make}
                            <div class="flex items-start gap-3">
                                <Camera size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Camera Make
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.camera_make}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.camera_model}
                            <div class="flex items-start gap-3">
                                <Camera size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Camera Model
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.camera_model}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.lens_model}
                            <div class="flex items-start gap-3">
                                <Aperture size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Lens
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.lens_model}
                                    </div>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if photo.exif.aperture || photo.exif.shutter_speed || photo.exif.iso || photo.exif.focal_length}
                <div class="space-y-3">
                    <h3
                        class="text-sm font-semibold text-amber-900 mb-3"
                        style="margin: 0;"
                    >
                        Exposure Settings
                    </h3>
                    <div class="space-y-3">
                        {#if photo.exif.aperture}
                            <div class="flex items-start gap-3">
                                <Aperture size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Aperture
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        f/{photo.exif.aperture}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.shutter_speed}
                            <div class="flex items-start gap-3">
                                <Clock size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Shutter Speed
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.shutter_speed}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.iso}
                            <div class="flex items-start gap-3">
                                <Image size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        ISO
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.iso}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.focal_length}
                            <div class="flex items-start gap-3">
                                <Aperture size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Focal Length
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.focal_length}mm
                                    </div>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if photo.exif.width || photo.exif.height}
                <div class="space-y-3">
                    <h3
                        class="text-sm font-semibold text-amber-900 mb-3"
                        style="margin: 0;"
                    >
                        Image Properties
                    </h3>
                    <div class="space-y-3">
                        {#if photo.exif.width && photo.exif.height}
                            <div class="flex items-start gap-3">
                                <Monitor size={16} />
                                <div>
                                    <div
                                        class="text-xs text-amber-600 font-medium"
                                    >
                                        Dimensions
                                    </div>
                                    <div class="text-sm text-amber-900">
                                        {photo.exif.width} × {photo.exif.height}
                                    </div>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
    </div>
</div>
