<script lang="ts">
    import { convertFileSrc } from "@tauri-apps/api/core";
    import { Bug, ImageOff, ScanSearch, X } from "@lucide/svelte";
    import type { ObjectDetectionBox, Photo, SmartCollection, VisualIndexEntry, VisualIndexLabel } from "../types.ts";

    interface Props {
        collection: SmartCollection;
        photos: Photo[];
        visualIndex: Record<string, VisualIndexEntry>;
        onClose: () => void;
    }

    let { collection, photos, visualIndex, onClose }: Props = $props();
    let activePhotoId = $state(collection.photo_ids[0] ?? "");

    const collectionPhotos = $derived(collection.photo_ids.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]);
    const activePhoto = $derived(collectionPhotos.find((photo) => photo.id === activePhotoId) ?? collectionPhotos[0]);
    const activeEntry = $derived(activePhoto ? visualIndex[activePhoto.id] : undefined);
    const activeBoxes = $derived(filteredBoxes(activeEntry?.detections ?? [], collection));
    const activeLabels = $derived(filteredLabels(activeEntry?.labels ?? [], collection));

    function previewSrc(photo: Photo | undefined): string {
        if (!photo) return "";
        if (photo.thumbnail) {
            const mime = photo.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
            return `data:${mime};base64,${photo.thumbnail}`;
        }
        if (["JPEG", "JPG", "PNG", "WEBP", "GIF"].includes(photo.file_type.toUpperCase())) {
            try {
                return convertFileSrc(photo.file_path);
            } catch {
                return "";
            }
        }
        return "";
    }

    function filteredBoxes(boxes: ObjectDetectionBox[], item: SmartCollection): ObjectDetectionBox[] {
        if (item.kind !== "object" || !item.label) return boxes;
        return boxes.filter((box) => box.label.toLowerCase() === item.label!.toLowerCase());
    }

    function filteredLabels(labels: VisualIndexLabel[], item: SmartCollection): VisualIndexLabel[] {
        if (item.kind === "object" && item.label) {
            return labels.filter((label) => label.label.toLowerCase() === item.label!.toLowerCase());
        }
        return labels.filter((label) => label.source === "model" || label.kind === item.kind).slice(0, 6);
    }

    function confidence(value: number): string {
        return `${Math.round(value * 100)}%`;
    }
</script>

<div class="fixed inset-0 z-[100] bg-black/80 p-3 text-white backdrop-blur-md md:p-5">
    <section class="mx-auto grid h-full max-w-7xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-white/15 bg-zinc-950 shadow-2xl">
        <header class="flex items-center gap-3 border-b border-white/10 bg-white/[0.04] px-4 py-3">
            <div class="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-cyan-200">
                <ScanSearch size={18} />
            </div>
            <div class="min-w-0">
                <div class="text-[10px] font-bold uppercase tracking-normal text-cyan-200">Detection Map</div>
                <h2 class="truncate text-sm font-semibold">{collection.name}</h2>
            </div>
            <div class="ml-auto hidden text-xs text-white/55 sm:block">
                {collectionPhotos.length} frames / {activeBoxes.length} visible boxes
            </div>
            <button
                class="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                onclick={onClose}
                aria-label="Close detection debug view"
                title="Close"
            >
                <X size={16} />
            </button>
        </header>

        <div class="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div class="min-h-0 overflow-auto bg-black p-4">
                <div class="flex min-h-full items-center justify-center">
                    {#if activePhoto && previewSrc(activePhoto)}
                        <div class="relative inline-block max-h-full max-w-full">
                            <img
                                class="block max-h-[calc(100vh-9rem)] max-w-full rounded-lg object-contain shadow-2xl"
                                src={previewSrc(activePhoto)}
                                alt={activePhoto.file_name}
                            />
                            {#each activeBoxes as box (box.id)}
                                <div
                                    class="pointer-events-none absolute rounded-md border-2 border-cyan-300 bg-cyan-300/10 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                                    style={`left:${box.box.x}%;top:${box.box.y}%;width:${box.box.width}%;height:${box.box.height}%`}
                                >
                                    <span class="absolute left-0 top-0 -translate-y-full rounded-t-md bg-cyan-300 px-1.5 py-0.5 text-[10px] font-bold text-black shadow-sm">
                                        {box.label} {confidence(box.confidence)}
                                    </span>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <div class="grid h-64 w-full max-w-lg place-items-center rounded-xl border border-white/10 bg-white/[0.03] text-white/50">
                            <div class="flex flex-col items-center gap-2">
                                <ImageOff size={30} />
                                <span class="text-sm">No preview available</span>
                            </div>
                        </div>
                    {/if}
                </div>
            </div>

            <aside class="min-h-0 overflow-y-auto border-l border-white/10 bg-white/[0.04] p-4">
                <div class="mb-4">
                    <div class="mb-2 flex items-center gap-2 text-xs font-bold uppercase text-white/70">
                        <Bug size={14} />
                        Why It Matched
                    </div>
                    {#if activeLabels.length > 0}
                        <div class="space-y-2">
                            {#each activeLabels as label}
                                <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                                    <div class="flex items-center justify-between gap-2">
                                        <span class="text-sm font-semibold">{label.label}</span>
                                        <span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/75">{confidence(label.confidence)}</span>
                                    </div>
                                    {#if label.reason}
                                        <p class="mt-1 text-xs leading-5 text-white/60">{label.reason}</p>
                                    {/if}
                                    {#if label.evidence?.length}
                                        <div class="mt-2 flex flex-wrap gap-1">
                                            {#each label.evidence as evidence}
                                                <span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/65">{evidence}</span>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <div class="rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-5 text-white/60">
                            No detector boxes were stored for this frame yet. Re-index the library after the local model finishes downloading.
                        </div>
                    {/if}
                </div>

                <div class="mb-3 text-xs font-bold uppercase text-white/70">Frames</div>
                <div class="grid grid-cols-3 gap-2">
                    {#each collectionPhotos as photo (photo.id)}
                        <button
                            class="relative aspect-square overflow-hidden rounded-md border transition-colors {photo.id === activePhoto?.id ? 'border-cyan-300' : 'border-white/10 hover:border-white/35'}"
                            onclick={() => (activePhotoId = photo.id)}
                            title={photo.file_name}
                        >
                            {#if previewSrc(photo)}
                                <img class="h-full w-full object-cover" src={previewSrc(photo)} alt={photo.file_name} loading="lazy" />
                            {:else}
                                <div class="grid h-full w-full place-items-center bg-white/5 text-white/35">
                                    <ImageOff size={16} />
                                </div>
                            {/if}
                            {#if (visualIndex[photo.id]?.detections?.length ?? 0) > 0}
                                <span class="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-bold text-cyan-200">
                                    {visualIndex[photo.id]?.detections?.length}
                                </span>
                            {/if}
                        </button>
                    {/each}
                </div>
            </aside>
        </div>
    </section>
</div>
