<script lang="ts">
    import { CalendarDays, Check, FileImage, Info, XCircle } from "@lucide/svelte";
    import { photoStore, selectedIndex } from "../stores/photoStore.ts";
    import type { Photo } from "../types.ts";
    import PhotoPreview from "./PhotoPreview.svelte";

    interface Props {
        photos: Photo[];
        tileMinWidth?: number;
    }

    let { photos, tileMinWidth = 220 }: Props = $props();

    type EmbeddedPreview = NonNullable<Photo["embedded_jpeg_preview"]>;

    const timelineTileMinWidth = $derived(Math.max(112, Math.min(240, Math.round(tileMinWidth * 0.55))));

    const groupedPhotos = $derived(groupByDay(photos));

    function groupByDay(items: Photo[]) {
        const groups = new Map<string, Photo[]>();
        for (const photo of items) {
            const date = photo.exif.date_taken ?? photo.modified_at ?? photo.created_at;
            const key = new Date(date).toISOString().slice(0, 10);
            groups.set(key, [...(groups.get(key) ?? []), photo]);
        }
        return Array.from(groups.entries())
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([key, items]) => ({
                key,
                label: formatDay(key),
                items,
            }));
    }

    function formatDay(key: string): string {
        return new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
        }).format(new Date(`${key}T12:00:00`));
    }

    function embeddedPreviewInfo(photo: Photo): EmbeddedPreview | null {
        return photo.embedded_jpeg_preview ?? photo.paired_raw_embedded_jpeg_preview ?? null;
    }

    function embeddedPreviewTitle(preview: EmbeddedPreview): string {
        const dimensions = preview.width && preview.height ? `${preview.width} x ${preview.height}` : "JPEG";
        return `RAW includes an embedded JPEG preview (${dimensions}). Consider shooting RAW only instead of RAW+JPEG.`;
    }

    function globalIndex(photo: Photo): number {
        return photos.findIndex((item) => item.id === photo.id);
    }

    function selectPhoto(photo: Photo) {
        const index = globalIndex(photo);
        if (index >= 0) photoStore.setSelectedIndex(index);
    }

    function openPhoto(photo: Photo) {
        const index = globalIndex(photo);
        if (index < 0) return;
        photoStore.setSelectedIndex(index);
        photoStore.setViewMode("viewer");
    }
</script>

<div class="h-full overflow-y-auto px-5 py-4">
    <div class="mx-auto flex max-w-7xl flex-col gap-6">
        {#each groupedPhotos as group (group.key)}
            <section class="min-w-0">
                <div class="sticky top-0 z-10 mb-3 flex items-center gap-3 border-b border-border bg-background/95 py-2 backdrop-blur">
                    <CalendarDays size={16} class="text-primary" />
                    <h2 class="text-sm font-semibold text-foreground">{group.label}</h2>
                    <span class="text-xs tabular-nums text-muted-foreground">{group.items.length} frames</span>
                </div>

                <div
                    class="grid grid-cols-[repeat(auto-fill,minmax(var(--timeline-tile-min),1fr))] gap-3"
                    style={`--timeline-tile-min: ${timelineTileMinWidth}px`}
                >
                    {#each group.items as photo (photo.id)}
                        {@const embeddedPreview = embeddedPreviewInfo(photo)}
                        {@const index = globalIndex(photo)}
                        <button
                            class="photo-tile group relative overflow-hidden rounded-lg border bg-card text-left transition-colors {index === $selectedIndex ? 'border-primary' : 'border-border hover:border-primary/60'}"
                            onclick={() => selectPhoto(photo)}
                            ondblclick={() => openPhoto(photo)}
                            title={photo.file_name}
                        >
                            <div class="relative aspect-[3/2] bg-black">
                                <PhotoPreview {photo} fit="contain" iconSize={28} />

                                <div class="absolute right-2 top-2 flex gap-1">
                                    {#if photo.paired_with}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                                            <FileImage size={12} />
                                        </span>
                                    {/if}
                                    {#if embeddedPreview && index === $selectedIndex}
                                        <span
                                            class="grid h-5 w-5 place-items-center rounded-full bg-primary/90 text-primary-foreground"
                                            title={embeddedPreviewTitle(embeddedPreview)}
                                            aria-label="RAW includes embedded JPEG preview"
                                        >
                                            <Info size={12} />
                                        </span>
                                    {/if}
                                    {#if photo.flag === "pick"}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-pick text-black">
                                            <Check size={12} />
                                        </span>
                                    {:else if photo.flag === "reject"}
                                        <span class="grid h-5 w-5 place-items-center rounded-full bg-reject text-white">
                                            <XCircle size={12} />
                                        </span>
                                    {/if}
                                </div>
                            </div>
                            <div class="min-w-0 px-2 py-2">
                                <div class="truncate text-xs font-semibold text-foreground">{photo.file_name}</div>
                                <div class="truncate text-[11px] text-muted-foreground">{photo.exif.camera_model ?? photo.file_type}</div>
                            </div>
                        </button>
                    {/each}
                </div>
            </section>
        {/each}
    </div>
</div>
