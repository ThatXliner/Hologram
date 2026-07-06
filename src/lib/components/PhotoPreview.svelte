<script lang="ts">
    import { ImageOff } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import { HologramAPI } from "../api.ts";
    import { photoPreviewSrc } from "../photoPreview.ts";
    import type { Photo } from "../types.ts";

    type PreviewQuality = "thumbnail" | "display";
    const MAX_DISPLAY_PREVIEW_CACHE_SIZE = 12;
    const displayPreviewUrlCache = new Map<string, string>();

    interface Props {
        photo: Photo;
        fit?: "contain" | "cover";
        eager?: boolean;
        iconSize?: number;
        fallbackLabel?: string;
        quality?: PreviewQuality;
    }

    let {
        photo,
        fit = "contain",
        eager = false,
        iconSize = 34,
        fallbackLabel = "No preview",
        quality = "thumbnail",
    }: Props = $props();

    let failedPhotoId = $state<string | null>(null);
    let displaySrc = $state("");
    let displayPhotoId = $state<string | null>(null);
    let failedDisplayPhotoId = $state<string | null>(null);
    let loadingDisplayPhotoId = $state<string | null>(null);
    let displayRequestId = 0;

    const fallbackSrc = $derived(failedPhotoId === photo.id ? "" : photoPreviewSrc(photo));
    const src = $derived(
        quality === "display" && displayPhotoId === photo.id && failedDisplayPhotoId !== photo.id
            ? displaySrc || fallbackSrc
            : fallbackSrc,
    );
    const fitClass = $derived(fit === "cover" ? "object-cover" : "object-contain");
    const isLoadingDisplaySrc = $derived(
        quality === "display" && loadingDisplayPhotoId === photo.id && displayPhotoId !== photo.id,
    );

    $effect(() => {
        const photoId = photo.id;
        const filePath = photo.file_path;
        const fileType = photo.file_type;
        const cacheKey = displayPreviewCacheKey(photo);
        const shouldLoadDisplay = quality === "display";
        failedPhotoId = null;
        failedDisplayPhotoId = null;

        if (!shouldLoadDisplay) {
            clearDisplayPreview();
            return;
        }

        void loadDisplayPreview(photoId, filePath, fileType, cacheKey);
    });

    onDestroy(() => {
        displayRequestId += 1;
        clearDisplayPreview();
    });

    function getFullResMime(fileType: string): string {
        const type = fileType.toUpperCase();
        if (type === "PNG") return "image/png";
        if (type === "WEBP") return "image/webp";
        if (type === "GIF") return "image/gif";
        if (type === "TIF" || type === "TIFF") return "image/tiff";
        return "image/jpeg";
    }

    function displayPreviewCacheKey(item: Photo): string {
        return `${item.id}:${item.modified_at}:${item.file_size}`;
    }

    function clearDisplayPreview() {
        displaySrc = "";
        displayPhotoId = null;
        loadingDisplayPhotoId = null;
    }

    function setDisplayPreview(photoId: string, url: string) {
        displaySrc = url;
        displayPhotoId = photoId;
        loadingDisplayPhotoId = null;
    }

    function cacheDisplayPreview(cacheKey: string, url: string) {
        const existing = displayPreviewUrlCache.get(cacheKey);
        if (existing) URL.revokeObjectURL(existing);
        displayPreviewUrlCache.set(cacheKey, url);

        while (displayPreviewUrlCache.size > MAX_DISPLAY_PREVIEW_CACHE_SIZE) {
            const oldestKey = displayPreviewUrlCache.keys().next().value;
            if (!oldestKey) break;
            const oldestUrl = displayPreviewUrlCache.get(oldestKey);
            if (oldestUrl) URL.revokeObjectURL(oldestUrl);
            displayPreviewUrlCache.delete(oldestKey);
        }
    }

    async function loadDisplayPreview(photoId: string, filePath: string, fileType: string, cacheKey: string) {
        const requestId = ++displayRequestId;
        const cachedUrl = displayPreviewUrlCache.get(cacheKey);
        if (cachedUrl) {
            setDisplayPreview(photoId, cachedUrl);
            return;
        }

        loadingDisplayPhotoId = photoId;
        try {
            const imageData = await HologramAPI.loadFullResolutionImage(filePath);
            if (requestId !== displayRequestId || photo.id !== photoId || quality !== "display") return;
            if (imageData.byteLength === 0) {
                failedDisplayPhotoId = photoId;
                loadingDisplayPhotoId = null;
                clearDisplayPreview();
                return;
            }

            const blob = new Blob([new Uint8Array(imageData)], { type: getFullResMime(fileType) });
            const nextUrl = URL.createObjectURL(blob);
            if (requestId !== displayRequestId || photo.id !== photoId || quality !== "display") {
                URL.revokeObjectURL(nextUrl);
                return;
            }
            cacheDisplayPreview(cacheKey, nextUrl);
            setDisplayPreview(photoId, nextUrl);
        } catch {
            if (requestId === displayRequestId && photo.id === photoId) {
                failedDisplayPhotoId = photoId;
                loadingDisplayPhotoId = null;
                clearDisplayPreview();
            }
        }
    }

    function markFailed(event: Event) {
        const image = event.currentTarget as HTMLImageElement | null;
        const failedSrc = image?.currentSrc || image?.src || "";
        if (failedSrc && failedSrc === displaySrc && displayPhotoId === photo.id) {
            failedDisplayPhotoId = photo.id;
            clearDisplayPreview();
            return;
        }
        if (!photo.thumbnail) failedPhotoId = photo.id;
    }
</script>

{#if src}
    <div class="relative h-full w-full bg-black">
        <img
            src={src}
            alt={photo.file_name}
            class="photo-preview-image h-full w-full bg-black {fitClass}"
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            onerror={markFailed}
        />
        {#if isLoadingDisplaySrc}
            <div class="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-black/40">
                <div class="h-full w-1/2 animate-pulse rounded-full bg-primary"></div>
            </div>
        {/if}
    </div>
{:else}
    <div class="grid h-full w-full place-items-center bg-secondary">
        <div class="flex flex-col items-center gap-2 text-muted-foreground">
            <ImageOff size={iconSize} />
            {#if fallbackLabel}
                <span class="text-xs">{fallbackLabel}</span>
            {/if}
        </div>
        <img src="/placeholder-image.svg" alt="" class="hidden" />
    </div>
{/if}
