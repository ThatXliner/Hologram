<script lang="ts">
    import { LayoutGrid, RotateCcw, Settings, Sparkles } from "@lucide/svelte";

    type GridDetails = "image" | "essentials" | "metadata";

    interface Props {
        gridZoomLevel: number;
        maxGridZoomLevel: number;
        gridTileSize: number;
        gridDetailMode: GridDetails;
        smartCollectionsEnabled: boolean;
        onGridZoomChange: (level: number) => void;
        onGridDetailChange: (mode: GridDetails) => void;
        onSmartCollectionsChange: (enabled: boolean) => void;
        onResetGridPreferences: () => void;
    }

    let {
        gridZoomLevel,
        maxGridZoomLevel,
        gridTileSize,
        gridDetailMode,
        smartCollectionsEnabled,
        onGridZoomChange,
        onGridDetailChange,
        onSmartCollectionsChange,
        onResetGridPreferences,
    }: Props = $props();

    const detailOptions: { value: GridDetails; label: string; description: string }[] = [
        { value: "image", label: "Images only", description: "Show the largest possible previews." },
        { value: "essentials", label: "Essentials", description: "Show filenames and ratings." },
        { value: "metadata", label: "Full metadata", description: "Show filenames, ratings, and exposure details." },
    ];
</script>

<main class="min-w-0 flex-1 overflow-y-auto bg-background">
    <header class="flex h-14 items-center gap-3 border-b border-border bg-card/70 px-5">
        <Settings size={18} class="text-primary" />
        <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.1em] text-primary">Hologram</div>
            <h1 class="text-sm font-semibold text-foreground">Settings</h1>
        </div>
    </header>

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
        <section class="rounded-lg border border-border bg-card">
            <div class="flex items-start gap-3 border-b border-border p-4">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                    <LayoutGrid size={17} />
                </div>
                <div>
                    <h2 class="text-sm font-semibold text-foreground">Grid appearance</h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">These choices are saved automatically.</p>
                </div>
            </div>

            <div class="space-y-5 p-4">
                <label class="block">
                    <span class="flex items-center justify-between text-xs font-medium text-foreground">
                        Thumbnail size
                        <span class="font-mono text-[11px] text-subtle">{gridTileSize}px</span>
                    </span>
                    <input
                        class="grid-zoom-slider mt-3 h-6 w-full"
                        type="range"
                        min="0"
                        max={maxGridZoomLevel}
                        step="1"
                        value={gridZoomLevel}
                        oninput={(event) => onGridZoomChange(Number(event.currentTarget.value))}
                    />
                </label>

                <fieldset>
                    <legend class="mb-2 text-xs font-medium text-foreground">Card details</legend>
                    <div class="grid gap-2 sm:grid-cols-3">
                        {#each detailOptions as option (option.value)}
                            <button
                                class="rounded-md border p-3 text-left transition-colors {gridDetailMode === option.value ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-secondary'}"
                                onclick={() => onGridDetailChange(option.value)}
                                aria-pressed={gridDetailMode === option.value}
                            >
                                <span class="block text-xs font-semibold text-foreground">{option.label}</span>
                                <span class="mt-1 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                            </button>
                        {/each}
                    </div>
                </fieldset>

                <button
                    class="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onclick={onResetGridPreferences}
                >
                    <RotateCcw size={13} />
                    Restore grid defaults
                </button>
            </div>
        </section>

        <section class="rounded-lg border border-border bg-card p-4">
            <div class="flex items-center gap-3">
                <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-info/15 text-info">
                    <Sparkles size={17} />
                </div>
                <div class="min-w-0 flex-1">
                    <h2 class="text-sm font-semibold text-foreground">Smart Collections</h2>
                    <p class="mt-0.5 text-xs text-muted-foreground">Analyze previews locally to create visual collections.</p>
                </div>
                <button
                    class="relative h-6 w-11 shrink-0 rounded-full transition-colors {smartCollectionsEnabled ? 'bg-primary' : 'bg-secondary'}"
                    onclick={() => onSmartCollectionsChange(!smartCollectionsEnabled)}
                    role="switch"
                    aria-checked={smartCollectionsEnabled}
                    aria-label="Smart Collections"
                >
                    <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all {smartCollectionsEnabled ? 'left-6' : 'left-1'}"></span>
                </button>
            </div>
        </section>
    </div>
</main>
