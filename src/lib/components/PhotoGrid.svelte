<script lang="ts">
    import { photoStore } from "../stores/photoStore.ts";
    import type { Photo } from "../types.ts";
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

<div
    style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; padding: 1rem;"
>
    {#each photos as photo (photo.id)}
        <button
            type="button"
            class="bg-white dark:bg-gray-800 rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer border border-gray-200 dark:border-gray-700 text-left w-full p-0"
            onclick={() => selectPhoto(photo)}
            onkeydown={(e) => e.key === "Enter" && selectPhoto(photo)}
        >
            <div
                style="position: relative; aspect-ratio: 3/2; overflow: hidden; border-radius: 0.5rem 0.5rem 0 0;"
            >
                <img
                    src={getThumbnailSrc(photo)}
                    alt={photo.file_name}
                    class="bg-gray-100 dark:bg-gray-700"
                    style="width: 100%; height: 100%; object-fit: cover;"
                    loading="lazy"
                />
                {#if photo.paired_with}
                    <div
                        class="bg-blue-500 text-white text-xs px-2 py-1 rounded-full"
                        style="position: absolute; top: 0.5rem; right: 0.5rem;"
                    >
                        <span style="font-weight: 500;">RAW+JPEG</span>
                    </div>
                {/if}
            </div>

            <div style="padding: 0.75rem;">
                <div
                    style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;"
                >
                    <h3
                        class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
                        style="margin: 0; flex: 1; margin-right: 0.5rem;"
                    >
                        {photo.file_name}
                    </h3>
                    <span
                        class="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
                        style="font-weight: 500;">{photo.file_type}</span
                    >
                </div>

                <div
                    style="display: flex; flex-direction: column; gap: 0.25rem;"
                >
                    {#if photo.exif.camera_model}
                        <div
                            class="text-xs text-gray-600 dark:text-gray-300"
                            style="display: flex; align-items: center; gap: 0.375rem;"
                        >
                            <Camera size={14} />
                            <span style="line-height: 1;"
                                >{photo.exif.camera_model}</span
                            >
                        </div>
                    {/if}

                    {#if photo.exif.aperture && photo.exif.focal_length}
                        <div
                            class="text-xs text-gray-600 dark:text-gray-300"
                            style="display: flex; align-items: center; gap: 0.375rem;"
                        >
                            <Aperture size={14} />
                            <span style="line-height: 1;"
                                >{formatAperture(photo.exif.aperture)} • {formatFocalLength(
                                    photo.exif.focal_length,
                                )}</span
                            >
                        </div>
                    {/if}

                    {#if photo.exif.iso}
                        <div
                            class="text-xs text-gray-600 dark:text-gray-300"
                            style="display: flex; align-items: center; gap: 0.375rem;"
                        >
                            <Image size={14} />
                            <span style="line-height: 1;"
                                >ISO {photo.exif.iso}</span
                            >
                        </div>
                    {/if}

                    <div class="metadata-item">
                        <Calendar size={14} />
                        <span style="line-height: 1;"
                            >{formatFileSize(photo.file_size)}</span
                        >
                    </div>
                </div>
            </div>
        </button>
    {/each}
</div>
