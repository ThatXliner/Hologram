<script lang="ts">
    import { photoStore } from "../stores/photoStore.js";
    import type { Photo } from "../types.js";
    import { Camera, Image, Calendar, Aperture } from "@lucide/svelte";

    interface Props {
        photos: Photo[];
    }

    let { photos }: Props = $props();

    function selectPhoto(photo: Photo) {
        photoStore.setSelectedPhoto(photo);
        photoStore.setViewMode("viewer");
    }

    function formatFileSize(bytes: number): string {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    function formatAperture(aperture: number): string {
        return `f/${aperture.toFixed(1)}`;
    }

    function formatFocalLength(focal: number): string {
        return `${focal.toFixed(0)}mm`;
    }

    function getThumbnailSrc(photo: Photo): string {
        if (photo.thumbnail) {
            return `data:image/jpeg;base64,${photo.thumbnail}`;
        }
        return "/placeholder-image.svg";
    }
</script>

<div class="photo-grid">
    {#each photos as photo (photo.id)}
        <button
            type="button"
            class="photo-card"
            onclick={() => selectPhoto(photo)}
            onkeydown={(e) => e.key === 'Enter' && selectPhoto(photo)}
        >
            <div class="photo-thumbnail">
                <img
                    src={getThumbnailSrc(photo)}
                    alt={photo.file_name}
                    class="thumbnail-image"
                    loading="lazy"
                />
                {#if photo.paired_with}
                    <div class="paired-badge">
                        <span class="paired-text">RAW+JPEG</span>
                    </div>
                {/if}
            </div>

            <div class="photo-info">
                <div class="photo-header">
                    <h3 class="photo-title">{photo.file_name}</h3>
                    <span class="file-type">{photo.file_type}</span>
                </div>

                <div class="photo-metadata">
                    {#if photo.exif.camera_model}
                        <div class="metadata-item">
                            <Camera size={14} />
                            <span>{photo.exif.camera_model}</span>
                        </div>
                    {/if}

                    {#if photo.exif.aperture && photo.exif.focal_length}
                        <div class="metadata-item">
                            <Aperture size={14} />
                            <span
                                >{formatAperture(photo.exif.aperture)} • {formatFocalLength(
                                    photo.exif.focal_length,
                                )}</span
                            >
                        </div>
                    {/if}

                    {#if photo.exif.iso}
                        <div class="metadata-item">
                            <Image size={14} />
                            <span>ISO {photo.exif.iso}</span>
                        </div>
                    {/if}

                    <div class="metadata-item">
                        <Calendar size={14} />
                        <span>{formatFileSize(photo.file_size)}</span>
                    </div>
                </div>
            </div>
        </button>
    {/each}
</div>

<style>
    @reference "../../app.css";

    .photo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 1rem;
        padding: 1rem;
    }

    .photo-card {
        @apply bg-white dark:bg-gray-800 rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer border border-gray-200 dark:border-gray-700 text-left w-full p-0;
    }

    .photo-thumbnail {
        position: relative;
        aspect-ratio: 3/2;
        overflow: hidden;
        border-radius: 0.5rem 0.5rem 0 0;
    }

    .thumbnail-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        @apply bg-gray-100 dark:bg-gray-700;
    }

    .paired-badge {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        @apply bg-blue-500 text-white text-xs px-2 py-1 rounded-full;
    }

    .paired-text {
        font-weight: 500;
    }

    .photo-info {
        padding: 0.75rem;
    }

    .photo-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 0.5rem;
    }

    .photo-title {
        @apply text-sm font-medium text-gray-900 dark:text-gray-100 truncate;
        margin: 0;
        flex: 1;
        margin-right: 0.5rem;
    }

    .file-type {
        @apply text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded;
        font-weight: 500;
    }

    .photo-metadata {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .metadata-item {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        @apply text-xs text-gray-600 dark:text-gray-300;
    }

    .metadata-item span {
        line-height: 1;
    }
</style>
