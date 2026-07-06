<script lang="ts">
    import { ImageOff } from "@lucide/svelte";
    import { photoPreviewSrc } from "../photoPreview.ts";
    import type { Photo } from "../types.ts";

    interface Props {
        photo: Photo;
        fit?: "contain" | "cover";
        eager?: boolean;
        iconSize?: number;
        fallbackLabel?: string;
    }

    let {
        photo,
        fit = "contain",
        eager = false,
        iconSize = 34,
        fallbackLabel = "No preview",
    }: Props = $props();

    let failedPhotoId = $state<string | null>(null);
    const src = $derived(failedPhotoId === photo.id ? "" : photoPreviewSrc(photo));
    const fitClass = $derived(fit === "cover" ? "object-cover" : "object-contain");

    $effect(() => {
        photo.id;
        failedPhotoId = null;
    });

    function markFailed() {
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
