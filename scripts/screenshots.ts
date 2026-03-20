/**
 * scripts/screenshots.ts — Automated demo screenshot capture
 *
 * Starts the Vite dev server, seeds realistic photo data via Tauri mocks,
 * and writes PNG files to screenshots/.
 *
 * Usage:
 *   bun run screenshots              # auto-start dev server on :4173 if needed
 *   bun run screenshots --no-server  # use already-running server on :1420 (tauri dev)
 *
 * Output: screenshots/
 *   01-welcome.png          — welcome screen with feature highlights
 *   02-grid.png             — photo grid with sidebar stats and filters
 *   03-grid-filtered.png    — grid with active filters applied
 *   04-viewer.png           — full-screen photo viewer with EXIF sidebar
 *   05-viewer-paired.png    — viewer showing RAW+JPEG toggle
 *   06-editor.png           — image editor with tone curve and sliders
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

// ── Config ────────────────────────────────────────────────────────────────────

const noServer = process.argv.includes("--no-server");
const force = process.argv.includes("--force");
const BASE_URL = noServer ? "http://localhost:1420" : "http://localhost:4173";
const OUT_DIR = "screenshots";
const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;

// Minimum fraction of pixels that must differ for a screenshot to be considered
// "significantly changed" and worth committing. 0.01 = 1% of total pixels.
// If --force is set, all screenshots are updated (threshold = 0).
const DIFF_THRESHOLD = force ? 0 : 0.01;

// ── Mock photo data ──────────────────────────────────────────────────────────

// Generate a 1x1 colored JPEG as base64 for thumbnails
function colorThumbnail(r: number, g: number, b: number): string {
    // Minimal JPEG: use a data URI-compatible tiny colored rectangle via canvas
    // For simplicity in Node, generate a solid-color PNG as base64
    const png = new PNG({ width: 280, height: 187 });
    for (let y = 0; y < 187; y++) {
        for (let x = 0; x < 280; x++) {
            const idx = (y * 280 + x) << 2;
            // Add subtle gradient for visual interest
            png.data[idx] = Math.min(255, r + Math.floor(y * 0.15));
            png.data[idx + 1] = Math.min(255, g + Math.floor(x * 0.08));
            png.data[idx + 2] = Math.min(255, b + Math.floor((x + y) * 0.05));
            png.data[idx + 3] = 255;
        }
    }
    return PNG.sync.write(png).toString("base64");
}

const THUMBNAILS = [
    colorThumbnail(45, 85, 120),   // dusky blue landscape
    colorThumbnail(130, 95, 60),   // warm golden hour
    colorThumbnail(35, 100, 55),   // forest green
    colorThumbnail(160, 80, 90),   // rosy portrait
    colorThumbnail(70, 70, 100),   // twilight purple
    colorThumbnail(100, 120, 80),  // sage meadow
    colorThumbnail(50, 50, 70),    // deep evening
    colorThumbnail(140, 110, 70),  // warm architecture
    colorThumbnail(80, 130, 150),  // ocean blue
    colorThumbnail(110, 60, 45),   // rustic red
    colorThumbnail(90, 110, 130),  // overcast street
    colorThumbnail(55, 95, 75),    // mossy detail
];

interface MockPhoto {
    id: string;
    file_path: string;
    file_name: string;
    file_size: number;
    file_type: string;
    thumbnail: string;
    exif: {
        camera_make?: string;
        camera_model?: string;
        lens_model?: string;
        focal_length?: number;
        aperture?: number;
        shutter_speed?: string;
        iso?: number;
        exposure_mode?: string;
        flash?: string;
        white_balance?: string;
        date_taken?: string;
        width?: number;
        height?: number;
        orientation?: number;
    };
    created_at: string;
    modified_at: string;
    paired_with?: string;
}

const MOCK_PHOTOS: MockPhoto[] = [
    {
        id: "photo-1", file_path: "/photos/DSC_4821.NEF", file_name: "DSC_4821.NEF",
        file_size: 28_540_928, file_type: "NEF", thumbnail: THUMBNAILS[0],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 50mm f/1.8 S",
            focal_length: 50, aperture: 1.8, shutter_speed: "1/2000", iso: 200,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-15T08:32:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T08:32:00", modified_at: "2025-11-15T08:32:00",
        paired_with: "photo-2",
    },
    {
        id: "photo-2", file_path: "/photos/DSC_4821.JPG", file_name: "DSC_4821.JPG",
        file_size: 8_192_000, file_type: "JPEG", thumbnail: THUMBNAILS[0],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 50mm f/1.8 S",
            focal_length: 50, aperture: 1.8, shutter_speed: "1/2000", iso: 200,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-15T08:32:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T08:32:00", modified_at: "2025-11-15T08:32:00",
        paired_with: "photo-1",
    },
    {
        id: "photo-3", file_path: "/photos/IMG_7294.CR3", file_name: "IMG_7294.CR3",
        file_size: 32_768_000, file_type: "CR3", thumbnail: THUMBNAILS[1],
        exif: { camera_make: "Canon", camera_model: "EOS R5", lens_model: "RF 85mm F1.2L USM",
            focal_length: 85, aperture: 1.2, shutter_speed: "1/1600", iso: 100,
            exposure_mode: "Manual", flash: "Off", white_balance: "Daylight",
            date_taken: "2025-11-14T16:45:00", width: 8192, height: 5464 },
        created_at: "2025-11-14T16:45:00", modified_at: "2025-11-14T16:45:00",
    },
    {
        id: "photo-4", file_path: "/photos/DSC_4830.NEF", file_name: "DSC_4830.NEF",
        file_size: 27_893_760, file_type: "NEF", thumbnail: THUMBNAILS[2],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 24-70mm f/2.8 S",
            focal_length: 35, aperture: 5.6, shutter_speed: "1/250", iso: 400,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Cloudy",
            date_taken: "2025-11-15T10:15:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T10:15:00", modified_at: "2025-11-15T10:15:00",
    },
    {
        id: "photo-5", file_path: "/photos/IMG_7301.CR3", file_name: "IMG_7301.CR3",
        file_size: 34_012_160, file_type: "CR3", thumbnail: THUMBNAILS[3],
        exif: { camera_make: "Canon", camera_model: "EOS R5", lens_model: "RF 85mm F1.2L USM",
            focal_length: 85, aperture: 1.4, shutter_speed: "1/1000", iso: 100,
            exposure_mode: "Manual", flash: "Off", white_balance: "Daylight",
            date_taken: "2025-11-14T17:10:00", width: 8192, height: 5464 },
        created_at: "2025-11-14T17:10:00", modified_at: "2025-11-14T17:10:00",
    },
    {
        id: "photo-6", file_path: "/photos/DSC_4835.NEF", file_name: "DSC_4835.NEF",
        file_size: 29_360_128, file_type: "NEF", thumbnail: THUMBNAILS[4],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 50mm f/1.8 S",
            focal_length: 50, aperture: 2.8, shutter_speed: "1/60", iso: 1600,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-15T18:30:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T18:30:00", modified_at: "2025-11-15T18:30:00",
        paired_with: "photo-7",
    },
    {
        id: "photo-7", file_path: "/photos/DSC_4835.JPG", file_name: "DSC_4835.JPG",
        file_size: 7_864_320, file_type: "JPEG", thumbnail: THUMBNAILS[4],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 50mm f/1.8 S",
            focal_length: 50, aperture: 2.8, shutter_speed: "1/60", iso: 1600,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-15T18:30:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T18:30:00", modified_at: "2025-11-15T18:30:00",
        paired_with: "photo-6",
    },
    {
        id: "photo-8", file_path: "/photos/A7R_0142.ARW", file_name: "A7R_0142.ARW",
        file_size: 62_914_560, file_type: "ARW", thumbnail: THUMBNAILS[5],
        exif: { camera_make: "Sony", camera_model: "A7R V", lens_model: "FE 24-70mm F2.8 GM II",
            focal_length: 24, aperture: 8, shutter_speed: "1/125", iso: 100,
            exposure_mode: "Manual", flash: "Off", white_balance: "Daylight",
            date_taken: "2025-11-13T12:00:00", width: 9504, height: 6336 },
        created_at: "2025-11-13T12:00:00", modified_at: "2025-11-13T12:00:00",
    },
    {
        id: "photo-9", file_path: "/photos/DSC_4840.JPG", file_name: "DSC_4840.JPG",
        file_size: 9_437_184, file_type: "JPEG", thumbnail: THUMBNAILS[6],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 24-70mm f/2.8 S",
            focal_length: 70, aperture: 2.8, shutter_speed: "1/500", iso: 800,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-15T19:45:00", width: 6048, height: 4024 },
        created_at: "2025-11-15T19:45:00", modified_at: "2025-11-15T19:45:00",
    },
    {
        id: "photo-10", file_path: "/photos/IMG_7310.CR3", file_name: "IMG_7310.CR3",
        file_size: 33_554_432, file_type: "CR3", thumbnail: THUMBNAILS[7],
        exif: { camera_make: "Canon", camera_model: "EOS R5", lens_model: "RF 24-105mm F4L IS USM",
            focal_length: 24, aperture: 8, shutter_speed: "1/60", iso: 200,
            exposure_mode: "Aperture Priority", flash: "Off", white_balance: "Shade",
            date_taken: "2025-11-14T14:20:00", width: 8192, height: 5464 },
        created_at: "2025-11-14T14:20:00", modified_at: "2025-11-14T14:20:00",
    },
    {
        id: "photo-11", file_path: "/photos/A7R_0155.ARW", file_name: "A7R_0155.ARW",
        file_size: 61_865_984, file_type: "ARW", thumbnail: THUMBNAILS[8],
        exif: { camera_make: "Sony", camera_model: "A7R V", lens_model: "FE 70-200mm F2.8 GM OSS II",
            focal_length: 200, aperture: 2.8, shutter_speed: "1/2000", iso: 400,
            exposure_mode: "Shutter Priority", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-13T15:30:00", width: 9504, height: 6336 },
        created_at: "2025-11-13T15:30:00", modified_at: "2025-11-13T15:30:00",
    },
    {
        id: "photo-12", file_path: "/photos/DSC_4850.JPG", file_name: "DSC_4850.JPG",
        file_size: 10_485_760, file_type: "JPEG", thumbnail: THUMBNAILS[9],
        exif: { camera_make: "Nikon", camera_model: "Z6 III", lens_model: "NIKKOR Z 50mm f/1.8 S",
            focal_length: 50, aperture: 1.8, shutter_speed: "1/4000", iso: 100,
            exposure_mode: "Manual", flash: "Off", white_balance: "Daylight",
            date_taken: "2025-11-16T07:00:00", width: 6048, height: 4024 },
        created_at: "2025-11-16T07:00:00", modified_at: "2025-11-16T07:00:00",
    },
    {
        id: "photo-13", file_path: "/photos/IMG_7315.JPG", file_name: "IMG_7315.JPG",
        file_size: 7_340_032, file_type: "JPEG", thumbnail: THUMBNAILS[10],
        exif: { camera_make: "Canon", camera_model: "EOS R5", lens_model: "RF 24-105mm F4L IS USM",
            focal_length: 50, aperture: 4, shutter_speed: "1/320", iso: 400,
            exposure_mode: "Program", flash: "Off", white_balance: "Auto",
            date_taken: "2025-11-14T11:00:00", width: 8192, height: 5464 },
        created_at: "2025-11-14T11:00:00", modified_at: "2025-11-14T11:00:00",
    },
    {
        id: "photo-14", file_path: "/photos/A7R_0160.ARW", file_name: "A7R_0160.ARW",
        file_size: 63_963_136, file_type: "ARW", thumbnail: THUMBNAILS[11],
        exif: { camera_make: "Sony", camera_model: "A7R V", lens_model: "FE 24-70mm F2.8 GM II",
            focal_length: 50, aperture: 2.8, shutter_speed: "1/500", iso: 200,
            exposure_mode: "Manual", flash: "Off", white_balance: "Cloudy",
            date_taken: "2025-11-13T16:45:00", width: 9504, height: 6336 },
        created_at: "2025-11-13T16:45:00", modified_at: "2025-11-13T16:45:00",
    },
];

const MOCK_STATS = {
    total_photos: MOCK_PHOTOS.length,
    raw_count: MOCK_PHOTOS.filter((p) => ["NEF", "CR3", "ARW", "DNG", "CR2"].includes(p.file_type)).length,
    jpeg_count: MOCK_PHOTOS.filter((p) => p.file_type === "JPEG").length,
    paired_count: MOCK_PHOTOS.filter((p) => p.paired_with).length / 2,
    cameras: { "Nikon Z6 III": 6, "Canon EOS R5": 4, "Sony A7R V": 3 },
    lenses: {
        "NIKKOR Z 50mm f/1.8 S": 4,
        "RF 85mm F1.2L USM": 2,
        "NIKKOR Z 24-70mm f/2.8 S": 2,
        "FE 24-70mm F2.8 GM II": 2,
    },
};

// ── Tauri mock ────────────────────────────────────────────────────────────────

async function installTauriMock(
    page: Page,
    options: { withPhotos?: boolean } = {},
): Promise<void> {
    const withPhotos = options.withPhotos ?? false;

    await page.addInitScript(
        (payload: { withPhotos: boolean; photos: MockPhoto[]; stats: typeof MOCK_STATS }) => {
            // Mock Tauri internals so the app doesn't crash outside the native shell
            (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
                invoke: async (cmd: string, _args: unknown) => {
                    if (cmd === "scan_folder_fast") {
                        return { photos: payload.photos, stats: payload.stats };
                    }
                    if (cmd === "generate_thumbnails") return null;
                    if (cmd === "filter_photos") return payload.photos;
                    if (cmd === "get_photo_stats") return payload.stats;
                    if (cmd === "apply_edits_and_save") return "/tmp/edited.jpg";
                    if (cmd === "load_full_resolution_image_command") {
                        // Return a tiny valid image buffer
                        return new ArrayBuffer(0);
                    }
                    if (cmd === "plugin:event|listen") return 1;
                    if (cmd === "plugin:event|unlisten") return null;
                    if (cmd === "plugin:dialog|open") return "/mock/photos";
                    return null;
                },
                transformCallback: (callback: (...args: unknown[]) => unknown) => {
                    return 1;
                },
                unregisterCallback: () => {},
                convertFileSrc: (filePath: string) => filePath,
            };

            (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
                unregisterListener: () => {},
            };

            // If we want pre-loaded photos, seed the store after the app mounts
            if (payload.withPhotos) {
                const originalFetch = window.fetch;
                let seeded = false;
                // Poll for the Svelte store to be available, then seed it
                const seedInterval = setInterval(() => {
                    if (seeded) return;
                    try {
                        // Access the photoStore module — SvelteKit exposes it on the page
                        // We'll use a custom event to trigger seeding from within the app
                        const event = new CustomEvent("__hologram_seed__", {
                            detail: { photos: payload.photos, stats: payload.stats },
                        });
                        window.dispatchEvent(event);
                        seeded = true;
                        clearInterval(seedInterval);
                    } catch {}
                }, 100);
                // Safety: stop polling after 10s
                setTimeout(() => clearInterval(seedInterval), 10_000);
            }
        },
        { withPhotos, photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
}

/**
 * Seed the photoStore by evaluating directly in the page context.
 * This bypasses event listeners by directly manipulating Svelte stores
 * via the module system — we import and call photoStore methods.
 */
async function seedPhotos(page: Page): Promise<void> {
    await page.evaluate(
        (payload: { photos: MockPhoto[]; stats: typeof MOCK_STATS }) => {
            // The app uses a Svelte writable store. We can't import it directly,
            // but we can simulate a folder import by triggering the same flow:
            // set photos, stats, and clear loading state via the store.
            //
            // SvelteKit bundles the store — access it through the component tree.
            // Alternatively, dispatch our custom event which we can listen for.
            const event = new CustomEvent("__hologram_seed__", {
                detail: payload,
            });
            window.dispatchEvent(event);
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
    await page.waitForTimeout(500);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function startServer(): Promise<ChildProcess> {
    console.log("Starting dev server…");
    const server = spawn(
        "bun",
        ["run", "dev", "--", "--host", "localhost", "--port", "4173", "--strictPort"],
        { stdio: ["ignore", "pipe", "pipe"], detached: false },
    );
    server.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[server] ${chunk}`));
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));
    await pollUntilReady(BASE_URL);
    console.log("Server ready.");
    return server;
}

async function pollUntilReady(url: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 304) return;
        } catch {
            /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

// ── Visual diff ───────────────────────────────────────────────────────────────

let significantChanges = false;

function diffFraction(a: Buffer, b: Buffer): number {
    const imgA = PNG.sync.read(a);
    const imgB = PNG.sync.read(b);
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) return 1;
    const total = imgA.width * imgA.height;
    const changed = pixelmatch(imgA.data, imgB.data, null, imgA.width, imgA.height, {
        threshold: 0.1,
    });
    return changed / total;
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

async function shot(page: Page, name: string): Promise<void> {
    const filePath = `${OUT_DIR}/${name}.png`;
    const newBytes = await page.screenshot({ fullPage: false });

    if (existsSync(filePath)) {
        const oldBytes = await readFile(filePath);
        const fraction = diffFraction(oldBytes, newBytes);
        const pct = (fraction * 100).toFixed(2);
        if (fraction >= DIFF_THRESHOLD) {
            significantChanges = true;
            console.log(`  ✓ ${filePath} (${pct}% changed — significant)`);
        } else {
            console.log(`  – ${filePath} (${pct}% changed — skipped, below threshold)`);
            return;
        }
    } else {
        significantChanges = true;
        console.log(`  ✓ ${filePath} (new)`);
    }

    await writeFile(filePath, newBytes);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

/**
 * 01. welcome — The welcome/landing screen shown when no photos are loaded.
 *    Shows the Hologram branding, feature highlights, and the sidebar.
 */
async function scenarioWelcome(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page);
    await page.goto(BASE_URL);
    // Wait for the welcome screen to render
    await page.locator("text=Hologram").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(page, "01-welcome");
    await page.close();
}

/**
 * 02. grid — The main photo grid populated with a realistic library.
 *    Shows the sidebar with stats, the search toolbar, and photo cards
 *    with thumbnails, EXIF metadata, and RAW+JPEG badges.
 */
async function scenarioGrid(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page, { withPhotos: true });
    await page.goto(BASE_URL);
    await page.waitForTimeout(300);

    // Seed photos directly into the store
    await page.evaluate(
        (payload) => {
            // Access photoStore via window — we'll add a bridge in the seed step
            (window as any).__HOLOGRAM_PHOTOS__ = payload.photos;
            (window as any).__HOLOGRAM_STATS__ = payload.stats;
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );

    // Trigger the import flow programmatically
    await page.evaluate(
        (payload) => {
            // Find the Import Photos button and simulate a successful scan
            // by directly manipulating the DOM store bridge
            const photoStoreModule = (window as any).__photoStore__;
            if (photoStoreModule) {
                photoStoreModule.setPhotos(payload.photos);
                photoStoreModule.setStats(payload.stats);
            }
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );

    // Wait for the grid to render
    await page.waitForTimeout(1000);

    // Check if we see the photo grid (count heading)
    const hasGrid = await page.locator("text=Photos (").isVisible().catch(() => false);
    if (!hasGrid) {
        // Fallback: click Import Photos and mock the dialog response
        console.log("  (seeding via import button fallback)");
        const importBtn = page.locator("text=Import Photos");
        if (await importBtn.isVisible()) {
            await importBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    await page.waitForTimeout(500);
    await shot(page, "02-grid");
    await page.close();
}

/**
 * 03. grid-filtered — The photo grid with sidebar filters expanded and
 *    active filters applied, showing the customizable filter system.
 */
async function scenarioGridFiltered(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page, { withPhotos: true });
    await page.goto(BASE_URL);
    await page.waitForTimeout(300);

    // Seed photos
    await page.evaluate(
        (payload) => {
            const store = (window as any).__photoStore__;
            if (store) {
                store.setPhotos(payload.photos);
                store.setStats(payload.stats);
            }
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
    await page.waitForTimeout(1000);

    // If no grid visible, try import fallback
    const hasGrid = await page.locator("text=Photos (").isVisible().catch(() => false);
    if (!hasGrid) {
        const importBtn = page.locator("text=Import Photos");
        if (await importBtn.isVisible()) {
            await importBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // Expand filters
    const filterToggle = page.locator("text=Filters").locator("..").locator("button").last();
    if (await filterToggle.isVisible()) {
        await filterToggle.click();
        await page.waitForTimeout(300);
    }

    // Select a camera model filter if available
    const cameraSelect = page.locator("#filter-camera_model");
    if (await cameraSelect.isVisible()) {
        await cameraSelect.selectOption({ label: "Z6 III" });
        await page.waitForTimeout(300);
    }

    await page.waitForTimeout(500);
    await shot(page, "03-grid-filtered");
    await page.close();
}

/**
 * 04. viewer — The full-screen photo viewer showing a single image with
 *    the EXIF metadata sidebar, navigation arrows, and zoom controls.
 */
async function scenarioViewer(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page, { withPhotos: true });
    await page.goto(BASE_URL);
    await page.waitForTimeout(300);

    // Seed photos
    await page.evaluate(
        (payload) => {
            const store = (window as any).__photoStore__;
            if (store) {
                store.setPhotos(payload.photos);
                store.setStats(payload.stats);
            }
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
    await page.waitForTimeout(1000);

    // Try import fallback if needed
    const hasGrid = await page.locator("text=Photos (").isVisible().catch(() => false);
    if (!hasGrid) {
        const importBtn = page.locator("text=Import Photos");
        if (await importBtn.isVisible()) {
            await importBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // Click the third photo card (Canon EOS R5 portrait shot)
    const cards = page.locator("button").filter({ hasText: "IMG_7294" });
    if (await cards.first().isVisible()) {
        await cards.first().click();
    } else {
        // Fallback: click any photo card
        const anyCard = page.locator("button").filter({ hasText: /\.(NEF|CR3|ARW|JPG)/ }).first();
        if (await anyCard.isVisible()) {
            await anyCard.click();
        }
    }

    await page.waitForTimeout(800);
    await shot(page, "04-viewer");
    await page.close();
}

/**
 * 05. viewer-paired — The viewer showing a RAW+JPEG paired photo with
 *    the toggle button visible, demonstrating the pairing workflow.
 */
async function scenarioViewerPaired(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page, { withPhotos: true });
    await page.goto(BASE_URL);
    await page.waitForTimeout(300);

    await page.evaluate(
        (payload) => {
            const store = (window as any).__photoStore__;
            if (store) {
                store.setPhotos(payload.photos);
                store.setStats(payload.stats);
            }
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
    await page.waitForTimeout(1000);

    const hasGrid = await page.locator("text=Photos (").isVisible().catch(() => false);
    if (!hasGrid) {
        const importBtn = page.locator("text=Import Photos");
        if (await importBtn.isVisible()) {
            await importBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // Click a paired photo (DSC_4821 has RAW+JPEG pair)
    const pairedCard = page.locator("button").filter({ hasText: "DSC_4821" }).first();
    if (await pairedCard.isVisible()) {
        await pairedCard.click();
    }

    await page.waitForTimeout(800);
    await shot(page, "05-viewer-paired");
    await page.close();
}

/**
 * 06. editor — The image editor panel open inside the viewer, showing
 *    the tone curve, adjustment sliders, and the edited preview.
 */
async function scenarioEditor(ctx: BrowserContext): Promise<void> {
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await installTauriMock(page, { withPhotos: true });
    await page.goto(BASE_URL);
    await page.waitForTimeout(300);

    await page.evaluate(
        (payload) => {
            const store = (window as any).__photoStore__;
            if (store) {
                store.setPhotos(payload.photos);
                store.setStats(payload.stats);
            }
        },
        { photos: MOCK_PHOTOS, stats: MOCK_STATS },
    );
    await page.waitForTimeout(1000);

    const hasGrid = await page.locator("text=Photos (").isVisible().catch(() => false);
    if (!hasGrid) {
        const importBtn = page.locator("text=Import Photos");
        if (await importBtn.isVisible()) {
            await importBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // Open any photo in viewer
    const anyCard = page.locator("button").filter({ hasText: /\.(NEF|CR3|ARW|JPG)/ }).first();
    if (await anyCard.isVisible()) {
        await anyCard.click();
    }
    await page.waitForTimeout(800);

    // Click the Edit button to open the editor
    const editBtn = page.locator("text=Edit").first();
    if (await editBtn.isVisible()) {
        await editBtn.click();
        await page.waitForTimeout(600);
    }

    await shot(page, "06-editor");
    await page.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });

    let server: ChildProcess | null = null;

    if (noServer) {
        try {
            const res = await fetch(BASE_URL);
            if (!res.ok && res.status !== 304 && res.status !== 200) {
                throw new Error(`Server returned ${res.status}`);
            }
            console.log(`Using existing server at ${BASE_URL}`);
        } catch {
            throw new Error(`--no-server was set but no server is reachable at ${BASE_URL}`);
        }
    } else {
        let serverAlreadyRunning = false;
        try {
            const res = await fetch(BASE_URL);
            if (res.ok || res.status === 304 || res.status === 200) {
                serverAlreadyRunning = true;
                console.log(`Using existing server at ${BASE_URL}`);
            }
        } catch {
            /* need to start one */
        }

        if (!serverAlreadyRunning) server = await startServer();
    }

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({ deviceScaleFactor: DEVICE_SCALE_FACTOR });

    try {
        console.log("\nCapturing screenshots…\n");
        await scenarioWelcome(context);
        await scenarioGrid(context);
        await scenarioGridFiltered(context);
        await scenarioViewer(context);
        await scenarioViewerPaired(context);
        await scenarioEditor(context);
        if (significantChanges) {
            console.log(`\nDone. Screenshots saved to ./${OUT_DIR}/`);
        } else {
            console.log("\nDone. No significant visual changes detected — no files updated.");
        }
    } finally {
        await context.close();
        await browser.close();
        if (server) server.kill();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
