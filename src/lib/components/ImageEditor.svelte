<script lang="ts">
    import { HologramAPI } from "../api.ts";
    import {
        Sun,
        Contrast,
        Droplets,
        Thermometer,
        CircleDot,
        RotateCcw,
        Save,
        Loader2,
    } from "@lucide/svelte";

    interface Props {
        imageSrc: string;
        filePath: string;
        onFilterStyle: (style: string) => void;
    }

    let { imageSrc, filePath, onFilterStyle }: Props = $props();

    // Adjustment values (all centered at 0, range -100 to 100 unless noted)
    let exposure = $state(0);
    let contrast = $state(0);
    let saturation = $state(0);
    let temperature = $state(0); // warm/cool
    let highlights = $state(0);
    let shadows = $state(0);

    // Tone curve control points (simple 3-point: shadows, midtones, highlights)
    let curveShadows = $state(0);
    let curveMidtones = $state(0);
    let curveHighlights = $state(0);

    let isSaving = $state(false);
    let saveMessage = $state<string | null>(null);

    // Convert slider values to CSS filter string
    const filterStyle = $derived.by(() => {
        // Exposure maps to brightness (1 = normal, range 0.5-2.0)
        const brightness = 1 + exposure / 100;
        // Contrast (1 = normal, range 0.5-2.0)
        const contrastVal = 1 + contrast / 100;
        // Saturation (1 = normal, range 0-3.0)
        const saturationVal = 1 + saturation / 100;

        // Temperature: approximate via sepia + hue-rotate
        // Warm = slight sepia, Cool = hue-rotate toward blue
        let tempFilters = "";
        if (temperature > 0) {
            tempFilters = `sepia(${temperature / 100 * 0.3}) hue-rotate(-${temperature * 0.1}deg)`;
        } else if (temperature < 0) {
            tempFilters = `hue-rotate(${Math.abs(temperature) * 0.6}deg)`;
        }

        // Highlights/shadows via additional brightness tweaks are hard in CSS alone,
        // so we approximate: highlights -> slight brightness boost, shadows -> contrast shift
        const highlightBrightness = 1 + highlights / 400;
        const shadowContrast = 1 + shadows / 200;

        // Tone curve approximation via brightness/contrast micro-adjustments
        const curveBrightness = 1 + (curveMidtones / 200) + (curveHighlights / 400) + (curveShadows / 400);
        const curveContrast = 1 + (curveHighlights - curveShadows) / 400;

        const totalBrightness = brightness * highlightBrightness * curveBrightness;
        const totalContrast = contrastVal * shadowContrast * curveContrast;

        let style = `brightness(${totalBrightness}) contrast(${totalContrast}) saturate(${saturationVal})`;
        if (tempFilters) {
            style += ` ${tempFilters}`;
        }

        return style;
    });

    // Push filter style to parent whenever it changes
    $effect(() => {
        onFilterStyle(filterStyle);
    });

    function resetAll() {
        exposure = 0;
        contrast = 0;
        saturation = 0;
        temperature = 0;
        highlights = 0;
        shadows = 0;
        curveShadows = 0;
        curveMidtones = 0;
        curveHighlights = 0;
    }

    async function saveImage() {
        if (!imageSrc || isSaving) return;
        isSaving = true;
        saveMessage = null;

        try {
            // Load the image into a canvas and apply filters
            const img = new Image();
            img.crossOrigin = "anonymous";

            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("Failed to load image"));
                img.src = imageSrc;
            });

            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            const ctx = canvas.getContext("2d")!;
            ctx.filter = filterStyle;
            ctx.drawImage(img, 0, 0);

            // Export as JPEG
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(
                    (b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))),
                    "image/jpeg",
                    0.92,
                );
            });

            const buffer = await blob.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buffer));

            const savedPath = await HologramAPI.saveEditedImage(filePath, bytes);
            saveMessage = `Saved to ${savedPath.split("/").pop()}`;
            setTimeout(() => (saveMessage = null), 3000);
        } catch (err) {
            saveMessage = `Error: ${err}`;
            setTimeout(() => (saveMessage = null), 4000);
        } finally {
            isSaving = false;
        }
    }

    interface Slider {
        label: string;
        icon: typeof Sun;
        value: () => number;
        set: (v: number) => void;
        min: number;
        max: number;
        step: number;
    }

    const sliders: Slider[] = [
        { label: "Exposure", icon: Sun, value: () => exposure, set: (v) => (exposure = v), min: -100, max: 100, step: 1 },
        { label: "Contrast", icon: Contrast, value: () => contrast, set: (v) => (contrast = v), min: -100, max: 100, step: 1 },
        { label: "Saturation", icon: Droplets, value: () => saturation, set: (v) => (saturation = v), min: -100, max: 100, step: 1 },
        { label: "Temperature", icon: Thermometer, value: () => temperature, set: (v) => (temperature = v), min: -100, max: 100, step: 1 },
        { label: "Highlights", icon: Sun, value: () => highlights, set: (v) => (highlights = v), min: -100, max: 100, step: 1 },
        { label: "Shadows", icon: CircleDot, value: () => shadows, set: (v) => (shadows = v), min: -100, max: 100, step: 1 },
    ];

    const curveSliders: Slider[] = [
        { label: "Shadows", icon: CircleDot, value: () => curveShadows, set: (v) => (curveShadows = v), min: -100, max: 100, step: 1 },
        { label: "Midtones", icon: CircleDot, value: () => curveMidtones, set: (v) => (curveMidtones = v), min: -100, max: 100, step: 1 },
        { label: "Highlights", icon: Sun, value: () => curveHighlights, set: (v) => (curveHighlights = v), min: -100, max: 100, step: 1 },
    ];
</script>

<div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
        <h3 class="text-xs font-semibold text-amber-800 uppercase tracking-wide" style="margin: 0;">
            Adjustments
        </h3>
        <button
            class="text-xs text-amber-600 hover:text-amber-800 transition-colors flex items-center gap-1"
            onclick={resetAll}
        >
            <RotateCcw size={12} />
            Reset
        </button>
    </div>

    <!-- Basic Sliders -->
    {#each sliders as slider}
        <div class="space-y-1">
            <div class="flex items-center justify-between text-xs text-amber-700">
                <div class="flex items-center gap-1.5">
                    <slider.icon size={12} class="shrink-0" />
                    <span>{slider.label}</span>
                </div>
                <span class="font-mono text-amber-500 min-w-[2.5rem] text-right">
                    {slider.value() > 0 ? "+" : ""}{slider.value()}
                </span>
            </div>
            <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={slider.value()}
                oninput={(e) => slider.set(Number(e.currentTarget.value))}
                class="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-600 bg-amber-200"
            />
        </div>
    {/each}

    <!-- Tone Curve -->
    <div class="pt-2 border-t border-amber-200">
        <h3 class="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-3" style="margin: 0;">
            Tone Curve
        </h3>
        {#each curveSliders as slider}
            <div class="space-y-1 mb-2">
                <div class="flex items-center justify-between text-xs text-amber-700">
                    <span>{slider.label}</span>
                    <span class="font-mono text-amber-500 min-w-[2.5rem] text-right">
                        {slider.value() > 0 ? "+" : ""}{slider.value()}
                    </span>
                </div>
                <input
                    type="range"
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    value={slider.value()}
                    oninput={(e) => slider.set(Number(e.currentTarget.value))}
                    class="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-600 bg-amber-200"
                />
            </div>
        {/each}
    </div>

    <!-- Save Button -->
    <div class="pt-2 border-t border-amber-200">
        <button
            class="w-full flex items-center justify-center gap-2 px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onclick={saveImage}
            disabled={isSaving}
        >
            {#if isSaving}
                <Loader2 size={14} class="animate-spin" />
                Saving...
            {:else}
                <Save size={14} />
                Save as JPEG
            {/if}
        </button>
        {#if saveMessage}
            <p class="text-xs mt-1.5 text-center {saveMessage.startsWith('Error') ? 'text-red-600' : 'text-green-700'}">
                {saveMessage}
            </p>
        {/if}
    </div>
</div>
