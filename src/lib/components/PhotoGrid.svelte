<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";
    import { photoStore, selectedIndex } from "../stores/photoStore.ts";
    import type { CullFlag, Photo } from "../types.ts";
    import PhotoPreviewCard from "./PhotoPreviewCard.svelte";

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
                <PhotoPreviewCard
                    {photo}
                    {detailMode}
                    eager={i < 30}
                    selected={i === $selectedIndex}
                    onRating={setRating}
                    onFlag={toggleFlag}
                />
            </div>
        {/each}
    </div>

    {#if visibleCount < photos.length}
        <div bind:this={sentinel} class="h-px"></div>
    {/if}
</div>
