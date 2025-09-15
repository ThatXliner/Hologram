<script lang="ts">
    import { photoStore } from "../stores/photoStore.ts";
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
                <img
                    src={getImageSrc(photo)}
                    alt={photo.file_name}
                    class="max-w-full max-h-full object-contain"
                />
                {#if photo.paired_with}
                    <div
                        class="absolute top-4 right-4 bg-blue-500 text-white text-sm px-3 py-1 rounded-full flex items-center gap-2"
                    >
                        <FileImage size={16} />
                        RAW+JPEG Pair
                    </div>
                {/if}
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
                            <div
                                class="text-xs text-amber-600 font-medium"
                            >
                                File Type
                            </div>
                            <div
                                class="text-sm text-amber-900"
                            >
                                {photo.file_type}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-start gap-3">
                        <Monitor size={16} />
                        <div>
                            <div
                                class="text-xs text-amber-600 font-medium"
                            >
                                File Size
                            </div>
                            <div
                                class="text-sm text-amber-900"
                            >
                                {formatFileSize(photo.file_size)}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-start gap-3">
                        <Calendar size={16} />
                        <div>
                            <div
                                class="text-xs text-amber-600 font-medium"
                            >
                                Modified
                            </div>
                            <div
                                class="text-sm text-amber-900"
                            >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
                                    <div
                                        class="text-sm text-amber-900"
                                    >
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
