<script lang="ts">
    import { Archive, Check, Download, FolderDown, Loader2 } from "@lucide/svelte";
    import { HologramAPI } from "../api.ts";
    import type { ExportOptions, ExportResult, Photo } from "../types.ts";

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
    let result = $state<ExportResult | null>(null);
    let error = $state<string | null>(null);

    const selectClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/40";

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
</script>

<section class="border-b border-sidebar-border p-4">
    <div class="mb-3 flex items-center gap-2">
        <FolderDown size={14} class="text-primary" />
        <h2 class="text-xs font-bold uppercase text-foreground">Export</h2>
        <span class="ml-auto text-xs tabular-nums text-muted-foreground">{photos.length} visible</span>
    </div>

    <div class="space-y-3">
        <div class="grid grid-cols-2 gap-2">
            <label class="space-y-1">
                <span class="text-[11px] font-semibold text-muted-foreground">Format</span>
                <select class={selectClass} bind:value={mode}>
                    <option value="folder">Folder</option>
                    <option value="zip">Zip</option>
                    <option value="lightroom">Lightroom</option>
                </select>
            </label>
            <label class="space-y-1">
                <span class="text-[11px] font-semibold text-muted-foreground">Pairs</span>
                <select class={selectClass} bind:value={pairMode}>
                    <option value="visible">Visible</option>
                    <option value="both">RAW + JPEG</option>
                    <option value="raw">RAW only</option>
                    <option value="jpeg">JPEG only</option>
                </select>
            </label>
        </div>

        <label class="space-y-1">
            <span class="text-[11px] font-semibold text-muted-foreground">Organize</span>
            <select class={selectClass} bind:value={organizeBy}>
                <option value="flat">Flat</option>
                <option value="date">Date folders</option>
                <option value="camera">Camera folders</option>
            </select>
        </label>

        <label class="space-y-1">
            <span class="text-[11px] font-semibold text-muted-foreground">Rename</span>
            <input
                class={selectClass}
                placeholder="date-index-name"
                bind:value={renamePattern}
            />
        </label>

        <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" bind:checked={includeMetadata} class="accent-primary" />
            Metadata sidecar
        </label>

        <button
            class="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isExporting || photos.length === 0}
            onclick={exportVisible}
        >
            {#if isExporting}
                <Loader2 size={15} class="animate-spin" />
                Exporting
            {:else if mode === "zip"}
                <Archive size={15} />
                Export
            {:else}
                <Download size={15} />
                Export
            {/if}
        </button>

        {#if result}
            <div class="rounded-md border border-border bg-card p-2 text-xs text-muted-foreground">
                <div class="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
                    <Check size={13} class="text-pick" />
                    {result.exported_count} exported
                </div>
                <div class="truncate">{result.output_path}</div>
                {#if result.skipped_count > 0}
                    <div class="mt-1 text-reject">{result.skipped_count} skipped</div>
                {/if}
            </div>
        {:else if error}
            <div class="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
        {/if}
    </div>
</section>
