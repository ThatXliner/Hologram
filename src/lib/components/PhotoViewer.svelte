<script lang="ts">
    import { photoStore } from "../stores/photoStore.js";
    import type { Photo } from "../types.js";
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
    } from "@lucide/svelte";

    interface Props {
        photo: Photo;
        photos: Photo[];
    }

    let { photo, photos }: Props = $props();

    const currentIndex = $derived(photos.findIndex((p) => p.id === photo.id));
    const hasPrevious = $derived(currentIndex > 0);
    const hasNext = $derived(currentIndex < photos.length - 1);

    function closeViewer() {
        photoStore.setViewMode("grid");
        photoStore.setSelectedPhoto(undefined);
    }

    function navigatePrevious() {
        if (hasPrevious) {
            photoStore.setSelectedPhoto(photos[currentIndex - 1]);
        }
    }

    function navigateNext() {
        if (hasNext) {
            photoStore.setSelectedPhoto(photos[currentIndex + 1]);
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

    function getImageSrc(photo: Photo): string {
        // In a real app, this would load the full-resolution image
        // For now, we'll use the thumbnail as a placeholder
        if (photo.thumbnail) {
            return `data:image/jpeg;base64,${photo.thumbnail}`;
        }
        return "/placeholder-image.svg";
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="photo-viewer" onclick={closeViewer}>
    <!-- Header -->
    <div class="viewer-header">
        <div class="header-info">
            <h2 class="photo-title">{photo.file_name}</h2>
            <span class="photo-counter"
                >{currentIndex + 1} of {photos.length}</span
            >
        </div>
        <button class="close-button" onclick={closeViewer}>
            <X size={24} />
        </button>
    </div>

    <!-- Main Content -->
    <div class="viewer-content" onclick={(e) => e.stopPropagation()}>
        <!-- Image Display -->
        <div class="image-container">
            {#if hasPrevious}
                <button
                    class="nav-button nav-previous"
                    onclick={navigatePrevious}
                >
                    <ChevronLeft size={32} />
                </button>
            {/if}

            <div class="image-wrapper">
                <img
                    src={getImageSrc(photo)}
                    alt={photo.file_name}
                    class="main-image"
                />
                {#if photo.paired_with}
                    <div class="paired-indicator">
                        <FileImage size={16} />
                        RAW+JPEG Pair
                    </div>
                {/if}
            </div>

            {#if hasNext}
                <button class="nav-button nav-next" onclick={navigateNext}>
                    <ChevronRight size={32} />
                </button>
            {/if}
        </div>

        <!-- Metadata Panel -->
        <div class="metadata-panel">
            <div class="metadata-section">
                <h3 class="metadata-title">File Information</h3>
                <div class="metadata-grid">
                    <div class="metadata-item">
                        <FileImage size={16} />
                        <div>
                            <div class="metadata-label">File Type</div>
                            <div class="metadata-value">{photo.file_type}</div>
                        </div>
                    </div>
                    <div class="metadata-item">
                        <Monitor size={16} />
                        <div>
                            <div class="metadata-label">File Size</div>
                            <div class="metadata-value">
                                {formatFileSize(photo.file_size)}
                            </div>
                        </div>
                    </div>
                    <div class="metadata-item">
                        <Calendar size={16} />
                        <div>
                            <div class="metadata-label">Modified</div>
                            <div class="metadata-value">
                                {formatDate(photo.modified_at)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {#if photo.exif.camera_model || photo.exif.camera_make}
                <div class="metadata-section">
                    <h3 class="metadata-title">Camera Information</h3>
                    <div class="metadata-grid">
                        {#if photo.exif.camera_make}
                            <div class="metadata-item">
                                <Camera size={16} />
                                <div>
                                    <div class="metadata-label">
                                        Camera Make
                                    </div>
                                    <div class="metadata-value">
                                        {photo.exif.camera_make}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.camera_model}
                            <div class="metadata-item">
                                <Camera size={16} />
                                <div>
                                    <div class="metadata-label">
                                        Camera Model
                                    </div>
                                    <div class="metadata-value">
                                        {photo.exif.camera_model}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.lens_model}
                            <div class="metadata-item">
                                <Aperture size={16} />
                                <div>
                                    <div class="metadata-label">Lens</div>
                                    <div class="metadata-value">
                                        {photo.exif.lens_model}
                                    </div>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if photo.exif.aperture || photo.exif.shutter_speed || photo.exif.iso || photo.exif.focal_length}
                <div class="metadata-section">
                    <h3 class="metadata-title">Exposure Settings</h3>
                    <div class="metadata-grid">
                        {#if photo.exif.aperture}
                            <div class="metadata-item">
                                <Aperture size={16} />
                                <div>
                                    <div class="metadata-label">Aperture</div>
                                    <div class="metadata-value">
                                        f/{photo.exif.aperture}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.shutter_speed}
                            <div class="metadata-item">
                                <Clock size={16} />
                                <div>
                                    <div class="metadata-label">
                                        Shutter Speed
                                    </div>
                                    <div class="metadata-value">
                                        {photo.exif.shutter_speed}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.iso}
                            <div class="metadata-item">
                                <Image size={16} />
                                <div>
                                    <div class="metadata-label">ISO</div>
                                    <div class="metadata-value">
                                        {photo.exif.iso}
                                    </div>
                                </div>
                            </div>
                        {/if}
                        {#if photo.exif.focal_length}
                            <div class="metadata-item">
                                <Aperture size={16} />
                                <div>
                                    <div class="metadata-label">
                                        Focal Length
                                    </div>
                                    <div class="metadata-value">
                                        {photo.exif.focal_length}mm
                                    </div>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if photo.exif.width || photo.exif.height}
                <div class="metadata-section">
                    <h3 class="metadata-title">Image Properties</h3>
                    <div class="metadata-grid">
                        {#if photo.exif.width && photo.exif.height}
                            <div class="metadata-item">
                                <Monitor size={16} />
                                <div>
                                    <div class="metadata-label">Dimensions</div>
                                    <div class="metadata-value">
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

<style>
    @reference "../../app.css";

    .photo-viewer {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        @apply bg-black/95 z-50 flex flex-col;
    }

    .viewer-header {
        @apply flex items-center justify-between p-4 bg-black/50;
    }

    .header-info {
        @apply flex items-center gap-4;
    }

    .photo-title {
        @apply text-white text-lg font-medium;
        margin: 0;
    }

    .photo-counter {
        @apply text-gray-300 text-sm;
    }

    .close-button {
        @apply text-white hover:text-gray-300 transition-colors;
    }

    .viewer-content {
        @apply flex-1 flex;
    }

    .image-container {
        @apply flex-1 flex items-center justify-center relative;
    }

    .nav-button {
        @apply absolute top-1/2 transform -translate-y-1/2 text-white hover:text-gray-300 transition-colors z-10 bg-black/20 hover:bg-black/40 rounded-full p-2;
    }

    .nav-previous {
        @apply left-4;
    }

    .nav-next {
        @apply right-4;
    }

    .image-wrapper {
        @apply relative max-w-full max-h-full;
    }

    .main-image {
        @apply max-w-full max-h-full object-contain;
    }

    .paired-indicator {
        @apply absolute top-4 right-4 bg-blue-500 text-white text-sm px-3 py-1 rounded-full flex items-center gap-2;
    }

    .metadata-panel {
        @apply w-80 bg-gray-500 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 overflow-y-auto p-4 space-y-6;
    }

    .metadata-section {
        @apply space-y-3;
    }

    .metadata-title {
        @apply text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3;
        margin: 0;
    }

    .metadata-grid {
        @apply space-y-3;
    }

    .metadata-item {
        @apply flex items-start gap-3;
    }

    .metadata-label {
        @apply text-xs text-gray-500 dark:text-gray-400 font-medium;
    }

    .metadata-value {
        @apply text-sm text-gray-900 dark:text-gray-100;
    }
</style>
