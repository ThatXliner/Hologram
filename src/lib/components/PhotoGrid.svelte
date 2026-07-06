<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";
    import { photoStore, selectedIndex } from "../stores/photoStore.ts";
    import type { CullFlag, Photo } from "../types.ts";
    import { Check, FileImage, Info, Star, XCircle } from "@lucide/svelte";
    import PhotoPreview from "./PhotoPreview.svelte";

    type GridDetails = "image" | "essentials" | "metadata";
    const DEFAULT_TILE_MIN_WIDTH = 220;

    interface Props {
        photos: Photo[];
        tileMinWidth?: number;
        detailMode?: GridDetails;
    }

    let { photos, tileMinWidth = DEFAULT_TILE_MIN_WIDTH, detailMode = "metadata" }: Props = $props();

    let visibleCount = $state(initialVisibleCount(tileMinWidth));
    let sentinel: HTMLDivElement | undefined = $state();
    let gridEl: HTMLDivElement | undefined = $state();
    let lastPhotoSetKey = $state("");
    let observer: IntersectionObserver | undefined;

    type EmbeddedPreview = NonNullable<Photo["embedded_jpeg_preview"]>;

    const visiblePhotos = $derived(photos.slice(0, visibleCount));
    const normalizedTileMinWidth = $derived(Math.max(120, Math.min(520, Math.round(tileMinWidth))));

    $effect(() => {
        const firstId = photos[0]?.id ?? "";
        const lastId = photos[photos.length - 1]?.id ?? "";
        const photoSetKey = `${normalizedTileMinWidth}:${photos.length}:${firstId}:${lastId}`;
        if (photoSetKey !== lastPhotoSetKey) {
            lastPhotoSetKey = photoSetKey;
            visibleCount = initialVisibleCount(normalizedTileMinWidth);
        }
    });

    onMount(() => {
        observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && visibleCount < photos.length) {
                    visibleCount = Math.min(visibleCount + batchSize(normalizedTileMinWidth), photos.length);
                }
            },
            { rootMargin: "700px" },
        );
    });

    $effect(() => {
        if (sentinel && observer) {
            observer.observe(sentinel);
            return () => observer!.unobserve(sentinel!);
        }
    });

    onDestroy(() => observer?.disconnect());

    function selectPhoto(index: number) {
        photoStore.setSelectedIndex(index);
    }

    function openPhoto(index: number) {
        photoStore.setSelectedIndex(index);
        photoStore.setViewMode("viewer");
    }

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

    function relatedIds(photo: Photo): string[] {
        return [photo.id, photo.paired_with].filter(Boolean) as string[];
    }

    function setRating(photo: Photo, rating: number) {
        for (const id of relatedIds(photo)) {
            photoStore.setPhotoRating(id, rating);
        }
    }

    function setFlag(photo: Photo, flag: CullFlag) {
        for (const id of relatedIds(photo)) {
            photoStore.setPhotoFlag(id, flag);
        }
    }

    function toggleFlag(photo: Photo, flag: CullFlag) {
        setFlag(photo, photo.flag === flag ? "none" : flag);
    }

    function handleRatingClick(event: MouseEvent, photo: Photo, rating: number) {
        event.stopPropagation();
        setRating(photo, photo.rating === rating ? 0 : rating);
    }

    function handleFlagClick(event: MouseEvent, photo: Photo, flag: CullFlag) {
        event.stopPropagation();
        toggleFlag(photo, flag);
    }

    function initialVisibleCount(tileWidth: number): number {
        if (tileWidth <= 150) return 144;
        if (tileWidth <= 220) return 96;
        if (tileWidth <= 340) return 60;
        if (tileWidth <= 430) return 40;
        return 28;
    }

    function batchSize(tileWidth: number): number {
        if (tileWidth <= 150) return 96;
        if (tileWidth <= 220) return 72;
        if (tileWidth <= 340) return 48;
        return 24;
    }

    function estimateColumns(): number {
        if (!gridEl) return 1;
        const firstCard = gridEl.querySelector<HTMLElement>("[data-photo-card]");
        if (!firstCard) return 1;
        const gap = normalizedTileMinWidth <= 150 ? 8 : normalizedTileMinWidth >= 430 ? 16 : 12;
        return Math.max(1, Math.floor((gridEl.clientWidth + gap) / (firstCard.offsetWidth + gap)));
    }

    async function moveCursor(delta: number) {
        if (photos.length === 0) return;
        const next = Math.max(0, Math.min(photos.length - 1, $selectedIndex + delta));
        photoStore.setSelectedIndex(next);
        if (next >= visibleCount - 8) {
            visibleCount = Math.min(photos.length, next + batchSize(normalizedTileMinWidth));
        }
        await tick();
        gridEl?.querySelector(`[data-photo-index="${next}"]`)?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
        });
    }

    function handleKeydown(event: KeyboardEvent) {
        const target = event.target as HTMLElement;
        if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;

        const current = photos[$selectedIndex];
        if (!current) return;

        if (event.key === "ArrowRight") {
            event.preventDefault();
            void moveCursor(1);
            return;
        }
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            void moveCursor(-1);
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            void moveCursor(estimateColumns());
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            void moveCursor(-estimateColumns());
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPhoto($selectedIndex);
            return;
        }
        if (/^[0-5]$/.test(event.key)) {
            event.preventDefault();
            const rating = Number(event.key);
            setRating(current, rating);
            if (rating > 0) void moveCursor(1);
            return;
        }
        if (event.key === "p" || event.key === "P") {
            event.preventDefault();
            setFlag(current, "pick");
            void moveCursor(1);
            return;
        }
        if (event.key === "x" || event.key === "X") {
            event.preventDefault();
            setFlag(current, "reject");
            void moveCursor(1);
            return;
        }
        if (event.key === "u" || event.key === "U") {
            event.preventDefault();
            setFlag(current, "none");
            setRating(current, 0);
        }
    }

    function handleTileKeydown(event: KeyboardEvent, index: number) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPhoto(index);
        }
    }

    function gridClass(): string {
        if (normalizedTileMinWidth <= 150) return "grid grid-cols-[repeat(auto-fill,minmax(var(--grid-tile-min),1fr))] gap-2 p-3";
        if (normalizedTileMinWidth >= 430) return "grid grid-cols-[repeat(auto-fill,minmax(var(--grid-tile-min),1fr))] gap-4 p-4";
        if (normalizedTileMinWidth >= 270) return "grid grid-cols-[repeat(auto-fill,minmax(var(--grid-tile-min),1fr))] gap-3 p-4";
        return "grid grid-cols-[repeat(auto-fill,minmax(var(--grid-tile-min),1fr))] gap-2.5 p-3";
    }

    function bottomPanelClass(): string {
        return [
            "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-2",
            detailMode === "essentials" ? "pt-10" : "pt-12",
        ].join(" ");
    }

    function tileClass(photo: Photo, index: number): string {
        const selected = index === $selectedIndex;
        const rejected = photo.flag === "reject";
        return [
            "photo-tile group relative overflow-hidden rounded-lg border bg-black text-left shadow-sm outline-none transition-[border-color,box-shadow,opacity,filter,transform]",
            "hover:border-ring hover:shadow-md",
            selected ? "border-primary shadow-[0_0_0_2px_var(--color-primary)]" : "border-border",
            rejected ? "opacity-45 grayscale hover:opacity-80" : "opacity-100",
        ].join(" ");
    }

    function ratingClass(active: boolean): string {
        return [
            "grid h-6 w-6 place-items-center rounded-md transition-colors",
            active ? "bg-rating text-black" : "bg-black/45 text-white/60 hover:text-rating",
        ].join(" ");
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
    class="h-full overflow-y-auto scroll-pt-16"
    bind:this={gridEl}
    role="grid"
    aria-label="Photo lighttable"
>
    <div class={gridClass()} style={`--grid-tile-min: ${normalizedTileMinWidth}px`}>
        {#each visiblePhotos as photo, i (photo.id)}
            {@const embeddedPreview = embeddedPreviewInfo(photo)}
            <div
                class={tileClass(photo, i)}
                data-photo-card
                data-photo-index={i}
                role="button"
                tabindex="-1"
                aria-current={i === $selectedIndex}
                onclick={() => selectPhoto(i)}
                ondblclick={() => openPhoto(i)}
                onkeydown={(event) => handleTileKeydown(event, i)}
            >
                <div class="relative aspect-[3/2] overflow-hidden bg-black">
                    <PhotoPreview photo={photo} fit="contain" eager={i < 30} iconSize={34} />

                    {#if detailMode === "metadata"}
                        <div class="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
                            <div class="flex min-w-0 flex-wrap gap-1">
                                {#if photo.paired_with}
                                    <span class="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                                        <FileImage size={11} />
                                        Pair
                                    </span>
                                {/if}
                                {#if embeddedPreview && i === $selectedIndex}
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
                            <span class="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold uppercase text-white/85">
                                {photo.file_type}
                            </span>
                        </div>
                    {/if}

                    {#if detailMode !== "image"}
                        <div class={bottomPanelClass()}>
                            <div class="mb-1 min-w-0">
                                <div class="truncate text-xs font-semibold text-white">{photo.file_name}</div>
                                {#if detailMode === "metadata"}
                                    <div class="mt-0.5 truncate text-[11px] text-white/65">
                                        {photo.exif.camera_model ?? "Unknown camera"}
                                        {#if exposureSummary(photo)}
                                            <span class="text-white/35"> / </span>{exposureSummary(photo)}
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                            <div class="flex items-center {detailMode === 'metadata' ? 'justify-between' : 'justify-start'} gap-2">
                                <div class="flex items-center gap-0.5">
                                    {#each [1, 2, 3, 4, 5] as rating}
                                        <button
                                            type="button"
                                            class={ratingClass((photo.rating ?? 0) >= rating)}
                                            onclick={(event) => handleRatingClick(event, photo, rating)}
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
                                            onclick={(event) => handleFlagClick(event, photo, "pick")}
                                            title="Pick"
                                            aria-label="Pick"
                                        >
                                            <Check size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            class="grid h-6 w-6 place-items-center rounded-md bg-black/45 text-white/60 transition-colors hover:bg-reject hover:text-white"
                                            onclick={(event) => handleFlagClick(event, photo, "reject")}
                                            title="Reject"
                                            aria-label="Reject"
                                        >
                                            <XCircle size={13} />
                                        </button>
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        {/each}
    </div>

    {#if visibleCount < photos.length}
        <div bind:this={sentinel} class="h-px"></div>
    {/if}
</div>
