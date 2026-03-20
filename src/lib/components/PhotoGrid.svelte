<script lang="ts">
    import { photoStore } from "../stores/photoStore.ts";
    import type { Photo } from "../types.ts";
    import { Camera, Image, Calendar, Aperture } from "@lucide/svelte";
    import { onMount, onDestroy } from "svelte";

    interface Props {
        photos: Photo[];
    }

    let { photos }: Props = $props();

    // Virtualization: only render photos that are near the viewport
    let visibleCount = $state(60);
    const BATCH_SIZE = 40;
    let sentinel: HTMLDivElement | undefined = $state();
    let observer: IntersectionObserver | undefined;

    const visiblePhotos = $derived(photos.slice(0, visibleCount));

    // Reset visible count when photos change (e.g. filter applied)
    $effect(() => {
        photos; // track
        visibleCount = 60;
    });

    onMount(() => {
        observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && visibleCount < photos.length) {
                    visibleCount = Math.min(visibleCount + BATCH_SIZE, photos.length);
                }
            },
            { rootMargin: "400px" },
        );
    });

    $effect(() => {
        if (sentinel && observer) {
            observer.observe(sentinel);
            return () => observer!.unobserve(sentinel!);
        }
    });

    onDestroy(() => observer?.disconnect());

    function selectPhoto(photo: Photo, index: number) {
        photoStore.setSelectedIndex(index);
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

<div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 p-4">
    {#each visiblePhotos as photo, i (photo.id)}
        <button
            type="button"
            class="photo-card bg-card rounded-lg border border-border cursor-pointer text-left w-full p-0 overflow-hidden"
            onclick={() => selectPhoto(photo, i)}
            onkeydown={(e) => e.key === "Enter" && selectPhoto(photo, i)}
        >
            <div class="relative aspect-[3/2] overflow-hidden rounded-t-lg">
                <img
                    src={getThumbnailSrc(photo)}
                    alt={photo.file_name}
                    class="w-full h-full object-cover bg-muted"
                    loading="lazy"
                    decoding="async"
                />
                {#if photo.paired_with}
                    <div
                        class="absolute top-2 right-2 bg-primary text-primary-foreground text-xs font-medium px-2 py-0.5 rounded-full"
                    >
                        RAW+JPEG
                    </div>
                {/if}
            </div>

            <div class="p-3">
                <div class="flex justify-between items-start mb-2">
                    <h3 class="text-sm font-semibold text-foreground truncate flex-1 mr-2 tracking-tight">
                        {photo.file_name}
                    </h3>
                    <span
                        class="text-xs font-medium text-secondary-foreground bg-secondary px-2 py-0.5 rounded-full"
                    >{photo.file_type}</span>
                </div>

                <div class="flex flex-col gap-1">
                    {#if photo.exif.camera_model}
                        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Camera size={14} />
                            <span>{photo.exif.camera_model}</span>
                        </div>
                    {/if}

                    {#if photo.exif.aperture && photo.exif.focal_length}
                        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Aperture size={14} />
                            <span>{formatAperture(photo.exif.aperture)} • {formatFocalLength(
                                    photo.exif.focal_length,
                                )}</span>
                        </div>
                    {/if}

                    {#if photo.exif.iso}
                        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Image size={14} />
                            <span>ISO {photo.exif.iso}</span>
                        </div>
                    {/if}

                    <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Calendar size={14} />
                        <span>{formatFileSize(photo.file_size)}</span>
                    </div>
                </div>
            </div>
        </button>
    {/each}
</div>

<!-- Sentinel element for infinite scroll -->
{#if visibleCount < photos.length}
    <div bind:this={sentinel} class="h-px"></div>
{/if}
