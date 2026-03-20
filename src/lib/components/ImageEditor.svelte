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
        Trash2,
    } from "@lucide/svelte";

    interface Props {
        imageSrc: string;
        filePath: string;
        onPreview: (blobUrl: string | null) => void;
    }

    let { imageSrc, filePath, onPreview }: Props = $props();

    // --- Adjustment state ---
    let exposure = $state(0);
    let contrast = $state(0);
    let saturation = $state(0);
    let temperature = $state(0);
    let highlights = $state(0);
    let shadows = $state(0);

    // --- Tone curve state ---
    // Points are {x, y} in 0-255 space. Always includes anchors at (0,0) and (255,255).
    let curvePoints = $state<{ x: number; y: number }[]>([
        { x: 0, y: 0 },
        { x: 255, y: 255 },
    ]);
    let draggingPointIndex = $state<number | null>(null);
    let curveContainer: SVGSVGElement | undefined = $state();

    let isSaving = $state(false);
    let saveMessage = $state<string | null>(null);

    // Source image data (loaded once, downscaled for preview)
    let sourceCanvas: HTMLCanvasElement | null = null;
    let sourceCtx: CanvasRenderingContext2D | null = null;
    let sourceImageData: ImageData | null = null;
    let previewCanvas: HTMLCanvasElement | null = null;
    let previewCtx: CanvasRenderingContext2D | null = null;
    let sourceWidth = 0;
    let sourceHeight = 0;
    let isSourceLoaded = $state(false);

    const PREVIEW_MAX = 1200;

    // Load source image into an offscreen canvas on mount / src change
    $effect(() => {
        const src = imageSrc;
        if (!src) return;
        isSourceLoaded = false;

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            // Downscale for preview
            let w = img.naturalWidth;
            let h = img.naturalHeight;
            if (Math.max(w, h) > PREVIEW_MAX) {
                const scale = PREVIEW_MAX / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            sourceWidth = w;
            sourceHeight = h;

            sourceCanvas = document.createElement("canvas");
            sourceCanvas.width = w;
            sourceCanvas.height = h;
            sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
            sourceCtx.drawImage(img, 0, 0, w, h);
            sourceImageData = sourceCtx.getImageData(0, 0, w, h);

            previewCanvas = document.createElement("canvas");
            previewCanvas.width = w;
            previewCanvas.height = h;
            previewCtx = previewCanvas.getContext("2d")!;

            isSourceLoaded = true;
            renderPreview();
        };
        img.src = src;
    });

    // Re-render preview whenever any adjustment changes
    $effect(() => {
        // Touch all reactive values to subscribe
        void exposure;
        void contrast;
        void saturation;
        void temperature;
        void highlights;
        void shadows;
        void curvePoints;

        if (isSourceLoaded) {
            renderPreview();
        }
    });

    // --- Tone curve LUT ---
    function buildCurveLUT(): Uint8Array {
        const lut = new Uint8Array(256);
        const pts = [...curvePoints].sort((a, b) => a.x - b.x);

        if (pts.length < 2) {
            for (let i = 0; i < 256; i++) lut[i] = i;
            return lut;
        }

        // Monotone cubic spline interpolation (Fritsch-Carlson)
        const n = pts.length;
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);

        // Compute slopes
        const deltas: number[] = [];
        const m: number[] = new Array(n).fill(0);

        for (let i = 0; i < n - 1; i++) {
            deltas[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1);
        }

        m[0] = deltas[0];
        m[n - 1] = deltas[n - 2];
        for (let i = 1; i < n - 1; i++) {
            if (deltas[i - 1] * deltas[i] <= 0) {
                m[i] = 0;
            } else {
                m[i] = (deltas[i - 1] + deltas[i]) / 2;
            }
        }

        // Fritsch-Carlson monotonicity fix
        for (let i = 0; i < n - 1; i++) {
            if (Math.abs(deltas[i]) < 1e-6) {
                m[i] = 0;
                m[i + 1] = 0;
            } else {
                const alpha = m[i] / deltas[i];
                const beta = m[i + 1] / deltas[i];
                const tau = alpha * alpha + beta * beta;
                if (tau > 9) {
                    const t = 3 / Math.sqrt(tau);
                    m[i] = t * alpha * deltas[i];
                    m[i + 1] = t * beta * deltas[i];
                }
            }
        }

        // Evaluate spline for each input value
        for (let x = 0; x < 256; x++) {
            if (x <= xs[0]) {
                lut[x] = Math.max(0, Math.min(255, Math.round(ys[0])));
                continue;
            }
            if (x >= xs[n - 1]) {
                lut[x] = Math.max(0, Math.min(255, Math.round(ys[n - 1])));
                continue;
            }

            // Find segment
            let seg = 0;
            for (let i = 0; i < n - 1; i++) {
                if (x >= xs[i] && x < xs[i + 1]) {
                    seg = i;
                    break;
                }
            }

            const h = xs[seg + 1] - xs[seg] || 1;
            const t = (x - xs[seg]) / h;
            const t2 = t * t;
            const t3 = t2 * t;

            // Hermite basis
            const h00 = 2 * t3 - 3 * t2 + 1;
            const h10 = t3 - 2 * t2 + t;
            const h01 = -2 * t3 + 3 * t2;
            const h11 = t3 - t2;

            const val = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
            lut[x] = Math.max(0, Math.min(255, Math.round(val)));
        }

        return lut;
    }

    // --- Pixel processing pipeline ---
    function renderPreview() {
        if (!sourceImageData || !previewCtx || !previewCanvas) return;

        const src = sourceImageData.data;
        const out = previewCtx.createImageData(sourceWidth, sourceHeight);
        const dst = out.data;
        const curveLUT = buildCurveLUT();

        // Precompute parameters
        // Exposure: additive brightness offset to match photon-rs behavior
        const brightnessOffset = exposure * 1.28;
        // Contrast: photon-rs style factor
        const contrastVal = contrast * 1.28;
        const contrastFactor = (259 * (contrastVal + 255)) / (255 * (259 - contrastVal));
        const satLevel = Math.abs(saturation) / 100 * 0.5;
        // Temperature: shift R/B channels (warm = +R -B, cool = -R +B)
        const tempR = 1 + temperature / 200;
        const tempB = 1 - temperature / 200;
        // Highlights affect bright pixels, shadows affect dark ones
        const highMul = 1 + highlights / 200;
        const shadMul = 1 + shadows / 200;

        const hasCurve = curvePoints.length >= 2 && curvePoints.some((p) => Math.abs(p.x - p.y) > 0.01);

        for (let i = 0; i < src.length; i += 4) {
            let r = src[i];
            let g = src[i + 1];
            let b = src[i + 2];

            // 1. Exposure (additive brightness, matches photon-rs)
            if (exposure !== 0) {
                r += brightnessOffset;
                g += brightnessOffset;
                b += brightnessOffset;
            }

            // 2. Contrast (matches photon-rs)
            if (contrast !== 0) {
                r = contrastFactor * (r - 128) + 128;
                g = contrastFactor * (g - 128) + 128;
                b = contrastFactor * (b - 128) + 128;
            }

            // 3. Saturation (HSL-based approximation to match photon-rs)
            if (saturation !== 0) {
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                const factor = saturation > 0 ? 1 + satLevel : 1 - satLevel;
                r = gray + factor * (r - gray);
                g = gray + factor * (g - gray);
                b = gray + factor * (b - gray);
            }

            // 4. Temperature (channel gain — custom)
            if (temperature !== 0) {
                r *= tempR;
                b *= tempB;
            }

            // 5. Highlights / shadows (luminance-weighted — custom)
            if (highlights !== 0 || shadows !== 0) {
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                const lumNorm = Math.min(lum / 255, 1);
                if (highlights !== 0) {
                    const weight = lumNorm * lumNorm;
                    const adj = 1 + (highMul - 1) * weight;
                    r *= adj; g *= adj; b *= adj;
                }
                if (shadows !== 0) {
                    const weight = (1 - lumNorm) * (1 - lumNorm);
                    const adj = 1 + (shadMul - 1) * weight;
                    r *= adj; g *= adj; b *= adj;
                }
            }

            // 6. Tone curve LUT (custom)
            if (hasCurve) {
                dst[i] = curveLUT[Math.max(0, Math.min(255, Math.round(r)))];
                dst[i + 1] = curveLUT[Math.max(0, Math.min(255, Math.round(g)))];
                dst[i + 2] = curveLUT[Math.max(0, Math.min(255, Math.round(b)))];
            } else {
                dst[i] = Math.max(0, Math.min(255, Math.round(r)));
                dst[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
                dst[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
            }
            dst[i + 3] = src[i + 3]; // alpha
        }

        previewCtx.putImageData(out, 0, 0);

        // Emit preview blob URL
        previewCanvas.toBlob(
            (blob) => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    onPreview(url);
                }
            },
            "image/jpeg",
            0.85,
        );
    }

    function getAdjustments() {
        return {
            exposure,
            contrast,
            saturation,
            temperature,
            highlights,
            shadows,
            curve_points: curvePoints.map((p): [number, number] => [p.x, p.y]),
        };
    }

    // --- Tone curve interaction ---
    const CURVE_SIZE = 200;
    const CURVE_PAD = 8;

    function curveSvgPath(): string {
        const pts = [...curvePoints].sort((a, b) => a.x - b.x);
        if (pts.length < 2) return "";

        const lut = buildCurveLUT();
        let d = `M ${toSvgX(0)} ${toSvgY(lut[0])}`;
        // Sample every 4 pixels for a smooth-enough path
        for (let x = 1; x < 256; x += 2) {
            d += ` L ${toSvgX(x)} ${toSvgY(lut[x])}`;
        }
        d += ` L ${toSvgX(255)} ${toSvgY(lut[255])}`;
        return d;
    }

    function toSvgX(val: number): number {
        return CURVE_PAD + (val / 255) * (CURVE_SIZE - 2 * CURVE_PAD);
    }
    function toSvgY(val: number): number {
        return CURVE_SIZE - CURVE_PAD - (val / 255) * (CURVE_SIZE - 2 * CURVE_PAD);
    }
    function fromSvgX(px: number): number {
        return Math.max(0, Math.min(255, Math.round(((px - CURVE_PAD) / (CURVE_SIZE - 2 * CURVE_PAD)) * 255)));
    }
    function fromSvgY(px: number): number {
        return Math.max(0, Math.min(255, Math.round(((CURVE_SIZE - CURVE_PAD - px) / (CURVE_SIZE - 2 * CURVE_PAD)) * 255)));
    }

    function getSvgCoords(e: PointerEvent): { x: number; y: number } {
        if (!curveContainer) return { x: 0, y: 0 };
        const rect = curveContainer.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }

    function handleCurvePointerDown(e: PointerEvent) {
        e.stopPropagation();
        const { x, y } = getSvgCoords(e);
        const valX = fromSvgX(x);
        const valY = fromSvgY(y);

        // Check if clicking near an existing point (within 12px)
        let closestIdx = -1;
        let closestDist = Infinity;
        for (let i = 0; i < curvePoints.length; i++) {
            const px = toSvgX(curvePoints[i].x);
            const py = toSvgY(curvePoints[i].y);
            const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
            if (dist < closestDist) {
                closestDist = dist;
                closestIdx = i;
            }
        }

        if (closestDist < 12 && closestIdx >= 0) {
            draggingPointIndex = closestIdx;
        } else {
            // Add new point
            curvePoints = [...curvePoints, { x: valX, y: valY }];
            draggingPointIndex = curvePoints.length - 1;
        }

        curveContainer?.setPointerCapture(e.pointerId);
    }

    function handleCurvePointerMove(e: PointerEvent) {
        if (draggingPointIndex === null) return;
        e.stopPropagation();
        const { x, y } = getSvgCoords(e);
        const valX = fromSvgX(x);
        const valY = fromSvgY(y);

        const pt = curvePoints[draggingPointIndex];
        // Don't move the X of anchor points (first and last after sorting)
        const isAnchor = draggingPointIndex === 0 && pt.x === 0
            || (draggingPointIndex === curvePoints.length - 1 && pt.x === 255)
            || pt.x === 0 || pt.x === 255;

        const updated = [...curvePoints];
        updated[draggingPointIndex] = {
            x: isAnchor ? pt.x : valX,
            y: valY,
        };
        curvePoints = updated;
    }

    function handleCurvePointerUp() {
        draggingPointIndex = null;
    }

    function handleCurveDoubleClick(e: MouseEvent) {
        e.stopPropagation();
        if (!curveContainer) return;
        const rect = curveContainer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Find closest non-anchor point and remove it
        let closestIdx = -1;
        let closestDist = Infinity;
        for (let i = 0; i < curvePoints.length; i++) {
            const pt = curvePoints[i];
            if (pt.x === 0 || pt.x === 255) continue; // don't remove anchors
            const px = toSvgX(pt.x);
            const py = toSvgY(pt.y);
            const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
            if (dist < closestDist) {
                closestDist = dist;
                closestIdx = i;
            }
        }

        if (closestIdx >= 0 && closestDist < 14) {
            curvePoints = curvePoints.filter((_, i) => i !== closestIdx);
        }
    }

    // --- Reset & Save ---
    function resetAll() {
        exposure = 0;
        contrast = 0;
        saturation = 0;
        temperature = 0;
        highlights = 0;
        shadows = 0;
        curvePoints = [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
        ];
    }

    function resetCurve() {
        curvePoints = [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
        ];
    }

    async function saveImage() {
        if (!filePath || isSaving) return;
        isSaving = true;
        saveMessage = null;

        try {
            const savedPath = await HologramAPI.applyEditsAndSave(filePath, getAdjustments());
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
    }

    const sliders: Slider[] = [
        { label: "Exposure", icon: Sun, value: () => exposure, set: (v) => (exposure = v), min: -100, max: 100 },
        { label: "Contrast", icon: Contrast, value: () => contrast, set: (v) => (contrast = v), min: -100, max: 100 },
        { label: "Saturation", icon: Droplets, value: () => saturation, set: (v) => (saturation = v), min: -100, max: 100 },
        { label: "Temperature", icon: Thermometer, value: () => temperature, set: (v) => (temperature = v), min: -100, max: 100 },
        { label: "Highlights", icon: Sun, value: () => highlights, set: (v) => (highlights = v), min: -100, max: 100 },
        { label: "Shadows", icon: CircleDot, value: () => shadows, set: (v) => (shadows = v), min: -100, max: 100 },
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

    {#if !isSourceLoaded}
        <div class="flex items-center justify-center py-6 text-amber-500 text-xs gap-2">
            <Loader2 size={14} class="animate-spin" />
            Loading image...
        </div>
    {:else}
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
                    step="1"
                    value={slider.value()}
                    oninput={(e) => slider.set(Number(e.currentTarget.value))}
                    class="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-600 bg-amber-200"
                />
            </div>
        {/each}

        <!-- Tone Curve -->
        <div class="pt-2 border-t border-amber-200">
            <div class="flex items-center justify-between mb-2">
                <h3 class="text-xs font-semibold text-amber-800 uppercase tracking-wide" style="margin: 0;">
                    Tone Curve
                </h3>
                <button
                    class="text-xs text-amber-600 hover:text-amber-800 transition-colors flex items-center gap-1"
                    onclick={resetCurve}
                    title="Reset curve"
                >
                    <Trash2 size={10} />
                    Reset
                </button>
            </div>

            <div class="flex justify-center">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <svg
                    bind:this={curveContainer}
                    width={CURVE_SIZE}
                    height={CURVE_SIZE}
                    class="bg-stone-100 rounded-lg border border-amber-200 cursor-crosshair touch-none"
                    onpointerdown={handleCurvePointerDown}
                    onpointermove={handleCurvePointerMove}
                    onpointerup={handleCurvePointerUp}
                    ondblclick={handleCurveDoubleClick}
                >
                    <!-- Grid lines -->
                    {#each [0.25, 0.5, 0.75] as t}
                        <line
                            x1={CURVE_PAD + t * (CURVE_SIZE - 2 * CURVE_PAD)}
                            y1={CURVE_PAD}
                            x2={CURVE_PAD + t * (CURVE_SIZE - 2 * CURVE_PAD)}
                            y2={CURVE_SIZE - CURVE_PAD}
                            stroke="#d4c5a0"
                            stroke-width="0.5"
                        />
                        <line
                            x1={CURVE_PAD}
                            y1={CURVE_PAD + t * (CURVE_SIZE - 2 * CURVE_PAD)}
                            x2={CURVE_SIZE - CURVE_PAD}
                            y2={CURVE_PAD + t * (CURVE_SIZE - 2 * CURVE_PAD)}
                            stroke="#d4c5a0"
                            stroke-width="0.5"
                        />
                    {/each}

                    <!-- Diagonal baseline -->
                    <line
                        x1={toSvgX(0)}
                        y1={toSvgY(0)}
                        x2={toSvgX(255)}
                        y2={toSvgY(255)}
                        stroke="#c8b88a"
                        stroke-width="1"
                        stroke-dasharray="4 3"
                    />

                    <!-- Curve path -->
                    <path
                        d={curveSvgPath()}
                        fill="none"
                        stroke="#b45309"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />

                    <!-- Control points -->
                    {#each curvePoints as pt, i}
                        <circle
                            cx={toSvgX(pt.x)}
                            cy={toSvgY(pt.y)}
                            r={draggingPointIndex === i ? 6 : 5}
                            fill={pt.x === 0 || pt.x === 255 ? "#92400e" : "#d97706"}
                            stroke="white"
                            stroke-width="2"
                            class="cursor-grab"
                            class:cursor-grabbing={draggingPointIndex === i}
                        />
                    {/each}

                    <!-- Axis labels -->
                    <text x={CURVE_PAD} y={CURVE_SIZE - 1} font-size="8" fill="#92400e" text-anchor="start">0</text>
                    <text x={CURVE_SIZE - CURVE_PAD} y={CURVE_SIZE - 1} font-size="8" fill="#92400e" text-anchor="end">255</text>
                </svg>
            </div>

            <p class="text-[10px] text-amber-500 text-center mt-1.5">
                Click to add points. Drag to adjust. Double-click to remove.
            </p>
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
    {/if}
</div>
