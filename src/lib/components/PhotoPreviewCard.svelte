<script lang="ts">
    import { Check, FileImage, Info, Star, XCircle } from "@lucide/svelte";
    import type { CullFlag, Photo } from "../types.ts";
    import PhotoPreview from "./PhotoPreview.svelte";

    type GridDetails = "image" | "essentials" | "metadata";
    type PreviewQuality = "thumbnail" | "display";
    type EmbeddedPreview = NonNullable<Photo["embedded_jpeg_preview"]>;

    interface Props {
        photo: Photo;
        detailMode?: GridDetails;
        eager?: boolean;
        fit?: "contain" | "cover";
        iconSize?: number;
        previewQuality?: PreviewQuality;
        selected?: boolean;
        showControls?: boolean;
        containerClass?: string;
        onRating?: (photo: Photo, rating: number) => void;
        onFlag?: (photo: Photo, flag: CullFlag) => void;
    }

    let {
        photo,
        detailMode = "metadata",
        eager = false,
        fit = "contain",
        iconSize = 34,
        previewQuality = "thumbnail",
        selected = false,
        showControls = true,
        containerClass = "",
        onRating = () => {},
        onFlag = () => {},
    }: Props = $props();

    function formatAperture(aperture?: number): string {
        if (!aperture) return "";
        return `f/${aperture.toFixed(aperture % 1 === 0 ? 0 : 1)}`;
    }

    function exposureSummary(photo: Photo): string {
        return [
            formatAperture(photo.exif.aperture),
            photo.exif.shutter_speed,
            photo.exif.iso ? `ISO ${photo.exif.iso}` : "",
        ].filter(Boolean).join("  ");
    }

    function embeddedPreviewInfo(photo: Photo): EmbeddedPreview | null {
        return photo.embedded_jpeg_preview ?? photo.paired_raw_embedded_jpeg_preview ?? null;
    }

    function embeddedPreviewTitle(preview: EmbeddedPreview): string {
        const dimensions = preview.width && preview.height ? `${preview.width} x ${preview.height}` : "JPEG";
        return `RAW includes an embedded JPEG preview (${dimensions}). Consider shooting RAW only instead of RAW+JPEG.`;
    }

    function bottomPanelClass(): string {
        return [
            "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-2",
            detailMode === "essentials" ? "pt-10" : "pt-12",
        ].join(" ");
    }

    function ratingClass(active: boolean): string {
        return [
            "grid h-6 w-6 place-items-center rounded-md transition-colors",
            active ? "bg-rating text-black" : "bg-black/45 text-white/60 hover:text-rating",
        ].join(" ");
    }

    function handleRatingClick(event: MouseEvent, rating: number) {
        event.stopPropagation();
        onRating(photo, (photo.rating ?? 0) === rating ? 0 : rating);
    }

    function handleFlagClick(event: MouseEvent, flag: CullFlag) {
        event.stopPropagation();
        onFlag(photo, photo.flag === flag ? "none" : flag);
    }
</script>

<div class="relative aspect-[3/2] overflow-hidden bg-black {containerClass}">
    <PhotoPreview {photo} {fit} {eager} {iconSize} quality={previewQuality} />

    {#if detailMode === "metadata"}
        {@const embeddedPreview = embeddedPreviewInfo(photo)}
        <div class="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
            <div class="flex min-w-0 flex-wrap gap-1">
                {#if photo.paired_with}
                    <span class="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                        <FileImage size={11} />
                        Pair
                    </span>
                {/if}
                {#if embeddedPreview && selected}
                    <span
                        class="grid h-5 w-5 place-items-center rounded-full bg-primary/90 text-primary-foreground shadow-sm"
                        title={embeddedPreviewTitle(embeddedPreview)}
                        aria-label="RAW includes embedded JPEG preview"
                    >
                        <Info size={12} />
                    </span>
                {/if}
                {#if photo.flag === "pick"}
                    <span class="inline-flex items-center gap-1 rounded-full bg-pick px-2 py-0.5 text-[10px] font-bold uppercase text-black">
                        <Check size={11} />
                        Pick
                    </span>
                {:else if photo.flag === "reject"}
                    <span class="inline-flex items-center gap-1 rounded-full bg-reject px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                        <XCircle size={11} />
                        Reject
                    </span>
                {/if}
            </div>
            <span class="rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white/85">
                {photo.file_type}
            </span>
        </div>
    {/if}

    {#if detailMode !== "image"}
        <div class={bottomPanelClass()}>
            <div class="mb-1 min-w-0">
                <div class="truncate font-mono text-xs font-semibold text-white">{photo.file_name}</div>
                {#if detailMode === "metadata"}
                    <div class="mt-0.5 truncate font-mono text-[11px] text-white/65">
                        {photo.exif.camera_model ?? "Unknown camera"}
                        {#if exposureSummary(photo)}
                            <span class="text-white/35"> / </span>{exposureSummary(photo)}
                        {/if}
                    </div>
                {/if}
            </div>
            {#if showControls}
                <div class="flex items-center {detailMode === 'metadata' ? 'justify-between' : 'justify-start'} gap-2">
                    <div class="flex items-center gap-0.5">
                        {#each [1, 2, 3, 4, 5] as rating}
                            <button
                                type="button"
                                class={ratingClass((photo.rating ?? 0) >= rating)}
                                onclick={(event) => handleRatingClick(event, rating)}
                                title={`${rating} stars`}
                                aria-label={`${rating} stars`}
                            >
                                <Star size={13} fill="currentColor" />
                            </button>
                        {/each}
                    </div>
                    {#if detailMode === "metadata"}
                        <div class="flex items-center gap-1 opacity-75 transition-opacity group-hover:opacity-100">
                            <button
                                type="button"
                                class="grid h-6 w-6 place-items-center rounded-md bg-black/45 text-white/60 transition-colors hover:bg-pick hover:text-black"
                                onclick={(event) => handleFlagClick(event, "pick")}
                                title="Pick"
                                aria-label="Pick"
                            >
                                <Check size={13} />
                            </button>
                            <button
                                type="button"
                                class="grid h-6 w-6 place-items-center rounded-md bg-black/45 text-white/60 transition-colors hover:bg-reject hover:text-white"
                                onclick={(event) => handleFlagClick(event, "reject")}
                                title="Reject"
                                aria-label="Reject"
                            >
                                <XCircle size={13} />
                            </button>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    {/if}
</div>
