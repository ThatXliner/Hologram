<script lang="ts">
    import { Archive, Check, Download, Loader2, Upload, XCircle } from "@lucide/svelte";
    import { HologramAPI } from "../api.ts";
    import { photoStore } from "../stores/photoStore.ts";
    import PhotoPreviewCard from "./PhotoPreviewCard.svelte";
    import type { ExportOptions, ExportResult, Photo, XmpSidecarResult } from "../types.ts";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
    }

    let { photos, allPhotos }: Props = $props();

    let mode = $state<ExportOptions["mode"]>("folder");
    let pairMode = $state<ExportOptions["pair_mode"]>("visible");
    let organizeBy = $state<ExportOptions["organize_by"]>("flat");
    let includeMetadata = $state(true);
    let renamePattern = $state("");
    let isExporting = $state(false);
    let xmpBusy = $state<"export" | "import" | null>(null);
    let result = $state<ExportResult | null>(null);
    let xmpResult = $state<XmpSidecarResult | null>(null);
    let error = $state<string | null>(null);
    let xmpError = $state<string | null>(null);

    const selectClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/40";

    const exportAsOptions: { value: ExportOptions["mode"]; label: string }[] = [
        { value: "folder", label: "Plain folder" },
        { value: "zip", label: "Zip archive" },
        { value: "lightroom", label: "Lightroom-ready" },
    ];
    const pairOptions: { value: ExportOptions["pair_mode"]; label: string }[] = [
        { value: "visible", label: "Visible half" },
        { value: "both", label: "Both (RAW + JPEG)" },
        { value: "raw", label: "RAW only" },
        { value: "jpeg", label: "JPEG only" },
    ];
    const organizeOptions: { value: ExportOptions["organize_by"]; label: string }[] = [
        { value: "flat", label: "Flat" },
        { value: "date", label: "Date folders" },
        { value: "camera", label: "Camera folders" },
    ];

    function rowClass(active: boolean): string {
        return active
            ? "rounded-[5px] bg-secondary px-2 py-[6px] text-left text-[12px] font-medium text-foreground"
            : "rounded-[5px] px-2 py-[6px] text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
    }

    async function exportVisible() {
        const destination = await HologramAPI.selectExportFolder();
        if (!destination) return;

        isExporting = true;
        result = null;
        error = null;
        try {
            result = await HologramAPI.exportPhotos(photos, allPhotos, {
                destination_path: destination,
                mode,
                pair_mode: pairMode,
                organize_by: organizeBy,
                rename_pattern: renamePattern.trim() || undefined,
                include_metadata: includeMetadata,
            });
        } catch (err) {
            error = String(err);
        } finally {
            isExporting = false;
        }
    }

    async function exportOriginalXmp() {
        xmpBusy = "export";
        xmpResult = null;
        xmpError = null;
        try {
            xmpResult = await HologramAPI.exportXmpSidecars(allPhotos);
        } catch (err) {
            xmpError = String(err);
        } finally {
            xmpBusy = null;
        }
    }

    async function importOriginalXmp() {
        xmpBusy = "import";
        xmpResult = null;
        xmpError = null;
        try {
            xmpResult = await HologramAPI.importXmpSidecars(allPhotos);
            await photoStore.loadMetadata(allPhotos.map((photo) => photo.id));
        } catch (err) {
            xmpError = String(err);
        } finally {
            xmpBusy = null;
        }
    }
</script>

{#snippet deckLabel(text: string)}
    <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">{text}</div>
{/snippet}

<section class="flex h-full min-h-0 bg-background">
    <!-- CONFIG DECK -->
    <aside class="flex w-[248px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-card p-[16px_14px]">
        <section>
            {@render deckLabel("Export as")}
            <div class="flex flex-col gap-[2px]">
                {#each exportAsOptions as opt (opt.value)}
                    <button class={rowClass(mode === opt.value)} onclick={() => (mode = opt.value)}>{opt.label}</button>
                {/each}
            </div>
        </section>

        <section>
            {@render deckLabel("Pair handling")}
            <div class="flex flex-col gap-[2px]">
                {#each pairOptions as opt (opt.value)}
                    <button class={rowClass(pairMode === opt.value)} onclick={() => (pairMode = opt.value)}>{opt.label}</button>
                {/each}
            </div>
        </section>

        <section>
            {@render deckLabel("Organization")}
            <div class="flex flex-col gap-[2px]">
                {#each organizeOptions as opt (opt.value)}
                    <button class={rowClass(organizeBy === opt.value)} onclick={() => (organizeBy = opt.value)}>{opt.label}</button>
                {/each}
            </div>
        </section>

        <section>
            {@render deckLabel("Rename pattern")}
            <input class={selectClass} placeholder="date-index-name" bind:value={renamePattern} />
        </section>

        <section>
            {@render deckLabel("Sidecar")}
            <label class="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input type="checkbox" bind:checked={includeMetadata} class="accent-primary" />
                Write metadata sidecar
            </label>
            <div class="mt-2 grid grid-cols-2 gap-2">
                <button
                    class="flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary px-2 font-sans text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    disabled={xmpBusy !== null || allPhotos.length === 0}
                    onclick={exportOriginalXmp}
                    title="Write XMP sidecars beside originals"
                >
                    {#if xmpBusy === "export"}<Loader2 size={12} class="animate-spin" />{:else}<Download size={12} />{/if}
                    XMP out
                </button>
                <button
                    class="flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary px-2 font-sans text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    disabled={xmpBusy !== null || allPhotos.length === 0}
                    onclick={importOriginalXmp}
                    title="Read XMP sidecars beside originals"
                >
                    {#if xmpBusy === "import"}<Loader2 size={12} class="animate-spin" />{:else}<Upload size={12} />{/if}
                    XMP in
                </button>
            </div>
            {#if xmpResult}
                <div class="mt-2 font-mono text-[10px] text-pick">✓ {xmpResult.processed_count} sidecars{#if xmpResult.skipped_count > 0} · {xmpResult.skipped_count} skipped{/if}</div>
            {:else if xmpError}
                <div class="mt-2 font-mono text-[10px] text-reject">{xmpError}</div>
            {/if}
        </section>

        <button
            class="mt-auto flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isExporting || photos.length === 0}
            onclick={exportVisible}
        >
            {#if isExporting}
                <Loader2 size={15} class="animate-spin" /> Exporting…
            {:else if mode === "zip"}
                <Archive size={15} /> Export {photos.length}
            {:else}
                <Download size={15} /> Export {photos.length}
            {/if}
        </button>
    </aside>

    <!-- MAIN -->
    <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3.5">
            <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">Export set</span>
            <span class="font-mono text-[11px] text-muted-foreground">{photos.length} visible photos · {mode}</span>
        </div>

        {#if result}
            <div class="grid flex-1 place-items-center p-8">
                <div class="w-full max-w-md rounded-lg border border-pick/30 bg-card p-6 text-center">
                    <div class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-pick/15 text-pick"><Check size={24} /></div>
                    <div class="text-lg font-semibold text-foreground">{result.exported_count} exported</div>
                    <div class="mt-1 truncate font-mono text-[11px] text-muted-foreground">{result.output_path}</div>
                    {#if result.skipped_count > 0}
                        <div class="mt-2 font-mono text-[11px] text-maybe">{result.skipped_count} skipped</div>
                    {/if}
                    <button class="mt-4 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" onclick={() => (result = null)}>Export again</button>
                </div>
            </div>
        {:else if error}
            <div class="grid flex-1 place-items-center p-8">
                <div class="w-full max-w-md rounded-lg border border-reject/40 bg-reject/5 p-6 text-center">
                    <div class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-reject/15 text-reject"><XCircle size={24} /></div>
                    <div class="text-lg font-semibold text-foreground">Export failed</div>
                    <div class="mt-1 font-mono text-[11px] text-reject">{error}</div>
                    <button class="mt-4 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" onclick={() => (error = null)}>Dismiss</button>
                </div>
            </div>
        {:else if photos.length === 0}
            <div class="grid flex-1 place-items-center px-8 text-center">
                <div class="max-w-sm">
                    <div class="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">Nothing to export</div>
                    <p class="mt-2 text-[13px] text-muted-foreground">Adjust filters in the library to build the set you want to export.</p>
                </div>
            </div>
        {:else}
            <div class="min-h-0 flex-1 overflow-y-auto p-3.5">
                <div class="flex flex-wrap gap-2">
                    {#each photos.slice(0, 60) as item (item.id)}
                        <div class="h-[120px] w-[180px] shrink-0 overflow-hidden rounded-[4px] border border-border">
                            <PhotoPreviewCard photo={item} detailMode="image" fit="cover" iconSize={20} showControls={false} containerClass="h-full w-full aspect-auto" />
                        </div>
                    {/each}
                </div>
                {#if photos.length > 60}
                    <div class="mt-3 font-mono text-[11px] text-subtle">+ {photos.length - 60} more in this set</div>
                {/if}
            </div>
        {/if}
    </div>
</section>
