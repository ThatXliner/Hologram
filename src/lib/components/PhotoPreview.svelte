<script lang="ts">
    import { ImageOff } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import { HologramAPI } from "../api.ts";
    import { photoPreviewSrc } from "../photoPreview.ts";
    import type { Photo } from "../types.ts";

    type PreviewQuality = "thumbnail" | "display";

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
    let displayRequestId = 0;
    let displayObjectUrl: string | null = null;

    const fallbackSrc = $derived(failedPhotoId === photo.id ? "" : photoPreviewSrc(photo));
    const src = $derived(
        quality === "display" && displayPhotoId === photo.id && failedDisplayPhotoId !== photo.id
            ? displaySrc || fallbackSrc
            : fallbackSrc,
    );
    const fitClass = $derived(fit === "cover" ? "object-cover" : "object-contain");

    $effect(() => {
        const photoId = photo.id;
        const filePath = photo.file_path;
        const fileType = photo.file_type;
        const shouldLoadDisplay = quality === "display";
        failedPhotoId = null;
        failedDisplayPhotoId = null;

        if (!shouldLoadDisplay) {
            clearDisplayPreview();
            return;
        }

        void loadDisplayPreview(photoId, filePath, fileType);
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

    function clearDisplayPreview() {
        displayRequestId += 1;
        if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl);
        displayObjectUrl = null;
        displaySrc = "";
        displayPhotoId = null;
    }

    function setDisplayPreview(photoId: string, url: string) {
        if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl);
        displayObjectUrl = url;
        displaySrc = url;
        displayPhotoId = photoId;
    }

    async function loadDisplayPreview(photoId: string, filePath: string, fileType: string) {
        const requestId = ++displayRequestId;
        try {
            const imageData = await HologramAPI.loadFullResolutionImage(filePath);
            if (requestId !== displayRequestId || photo.id !== photoId || quality !== "display") return;
            if (imageData.byteLength === 0) {
                failedDisplayPhotoId = photoId;
                clearDisplayPreview();
                return;
            }

            const blob = new Blob([new Uint8Array(imageData)], { type: getFullResMime(fileType) });
            const nextUrl = URL.createObjectURL(blob);
            if (requestId !== displayRequestId || photo.id !== photoId || quality !== "display") {
                URL.revokeObjectURL(nextUrl);
                return;
            }
            setDisplayPreview(photoId, nextUrl);
        } catch {
            if (requestId === displayRequestId && photo.id === photoId) {
                failedDisplayPhotoId = photoId;
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
    <img
        src={src}
        alt={photo.file_name}
        class="photo-preview-image h-full w-full bg-black {fitClass}"
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onerror={markFailed}
    />
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
