// Run real preview extraction, ranking, and the AutoCull UI in a browser.
// Tauri filesystem operations are stubbed; image decoding and analysis are real.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "hologram-autocull-"));
const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const executablePath = [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  .find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath }).catch(async (error) => {
  await server.close();
  throw error;
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.assign(window, {
      __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (["read_autocull_feature_cache", "find_missing_photo_ids"].includes(command)) return [];
          if (command === "plugin:event|listen") return 1;
          if (command === "get_photo_metadata") return {};
          return null;
        },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path: string) => path,
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto(server.resolvedUrls!.local[0]);
  const portrait = (await readFile(new URL("./fixtures/stock/portrait.jpg", import.meta.url))).toString("base64");
  const result = await page.evaluate(async (portrait) => {
    const modulePath = "/src/lib/autocull.ts";
    const { buildAutoCullSession } = await import(modulePath) as typeof import("../src/lib/autocull.ts");
    const image = new Image();
    image.src = `data:image/jpeg;base64,${portrait}`;
    await image.decode();
    const variants = ["original", "duplicate", "blurred", "noisy", "noisy-blurred", "black", "white"];
    const photos = variants.map((id, i) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 160;
      const ctx = canvas.getContext("2d")!;
      if (id.includes("blurred")) ctx.filter = "blur(2px)";
      ctx.drawImage(image, 0, 0, 160, 160);
      if (id === "black" || id === "white") {
        ctx.fillStyle = id;
        ctx.fillRect(0, 0, 160, 160);
      }
      if (id.includes("noisy")) {
        const pixels = ctx.getImageData(0, 0, 160, 160);
        let seed = 12345;
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const noise = ((seed / 4294967296) - 0.5) * 55;
          for (let channel = 0; channel < 3; channel++) pixels.data[pixel + channel] += noise;
        }
        ctx.putImageData(pixels, 0, 0);
      }
      return {
        id, file_name: `${id}.jpg`, file_path: `/fixture/${id}.jpg`, file_size: 100, file_type: "JPEG",
        thumbnail: canvas.toDataURL("image/png").split(",")[1],
        exif: { date_taken: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() },
        created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z",
      };
    });
    photos.push({ ...photos[0], id: "unavailable", file_name: "unavailable.NEF", file_path: "/fixture/unavailable.NEF", file_type: "NEF", thumbnail: "", exif: { date_taken: "2026-01-02T00:00:00Z" } });
    const progress: number[] = [];
    const session = await buildAutoCullSession(photos, [], (p) => progress.push(p.current));
    const cached = await buildAutoCullSession(photos);
    const storePath = "/src/lib/stores/photoStore.ts";
    const { photoStore } = await import(storePath) as typeof import("../src/lib/stores/photoStore.ts");
    photoStore.setPhotos(photos);
    return { session, cached, progress };
  }, portrait);
  const scores = Object.fromEntries(result.session.photos.map((p) => [p.photo_id, p.technical_score]));
  console.log("Preview technical scores:", scores);
  assert.equal(result.session.stats.indexed, 7);
  assert.equal(result.progress.at(-1), 8);
  assert.deepEqual(result.session.photos, result.cached.photos);
  assert.deepEqual(result.session.clusters, result.cached.clusters);
  assert.equal(result.session.photos.find((p) => p.photo_id === "unavailable")?.recommendation, "NEEDS_REVIEW");
  assert.equal(scores.original, scores.duplicate);
  assert.ok(scores.original > scores.blurred + 0.1, "The original should outrank a blurred copy");
  assert.ok(scores.original > scores.black && scores.original > scores.white, "Clipped copies should rank lower");

  await page.getByRole("button", { name: "AutoCull", exact: true }).click();
  const view = page.locator("[data-autocull-view]");
  await view.getByText("Analysis complete", { exact: true }).waitFor();
  await view.locator("[data-autocull-reasons]").waitFor();
  await view.locator("[data-autocull-close-call]").waitFor();
  assert.match(await view.innerText(), /1 preview unavailable/);
  assert.equal(await view.getByText("SUGGESTED", { exact: true }).count(), 1);
  await page.screenshot({ path: join(output, "autocull-desktop.png") });

  await view.getByRole("button", { name: "Ranked · worst first", exact: true }).click();
  await view.locator('[data-autocull-photo-id="unavailable"]').click();
  assert.match(await view.locator("[data-autocull-reasons]").innerText(), /Preview unavailable/);
  await view.getByRole("button", { name: "Keep", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-autocull-reasons]")?.textContent?.includes("You marked this photo as a keeper."));
  await view.getByRole("button", { name: "Reject", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-autocull-reasons]")?.textContent?.includes("You marked this photo as rejected."));
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({ path: join(output, "autocull-review.png") });
  await page.setViewportSize({ width: 800, height: 600 });
  await view.getByRole("button", { name: "Clusters", exact: true }).click();
  await page.screenshot({ path: join(output, "autocull-compact.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "The default 800px window should not overflow horizontally");
  assert.deepEqual(errors, [], "No browser runtime errors");
  assert.ok(scores.noisy <= scores.original + 0.08, "Added noise should not substantially improve the technical score");
  assert.ok(scores["noisy-blurred"] <= scores.blurred + 0.08, "Noise must not disguise a blurred image as sharp");
  const stockDir = new URL("./fixtures/stock/", import.meta.url);
  const stock = await Promise.all((await readdir(stockDir)).filter((name) => name.endsWith(".jpg")).map(async (name) => ({
    name, data: (await readFile(new URL(name, stockDir))).toString("base64"),
  })));
  const comparisons = await page.evaluate(async (stock) => {
    const modulePath = "/src/lib/autocull.ts";
    const { buildAutoCullSession } = await import(modulePath) as typeof import("../src/lib/autocull.ts");
    const results = [];
    for (const source of stock) {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${source.data}`;
      await image.decode();
      const photos = [false, true].map((blur, i) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 160;
        const ctx = canvas.getContext("2d")!;
        if (blur) ctx.filter = "blur(2px)";
        ctx.drawImage(image, 0, 0, 160, 160);
        return {
          id: `${source.name}-${i}`, file_name: `${source.name}-${i}.jpg`, file_path: `/stock/${source.name}-${i}.jpg`,
          file_size: 100, file_type: "JPEG", thumbnail: canvas.toDataURL("image/png").split(",")[1],
          exif: {}, created_at: "", modified_at: "",
        };
      });
      const session = await buildAutoCullSession(photos);
      results.push({ name: source.name, original: session.photos[0].technical_score, blurred: session.photos[1].technical_score });
    }
    return results;
  }, stock);
  console.table(comparisons);
  for (const pair of comparisons) assert.ok(pair.original > pair.blurred + 0.05, `${pair.name}: original must outrank blur`);
  let retryRequests = 0;
  await page.route("**/fixture/retry.jpg", (route) => route.fulfill({
    contentType: "image/jpeg", headers: { "cache-control": "no-store" },
    body: ++retryRequests === 1 ? Buffer.from("invalid image") : Buffer.from(portrait, "base64"),
  }));
  const retry = await page.evaluate(async () => {
    const modulePath = "/src/lib/autocull.ts";
    const { buildAutoCullSession } = await import(modulePath) as typeof import("../src/lib/autocull.ts");
    const photo = { id: "retry", file_name: "retry.jpg", file_path: "/fixture/retry.jpg", file_size: 1, file_type: "JPEG", exif: {}, created_at: "", modified_at: "" };
    const failed = await buildAutoCullSession([photo]);
    const recovered = await buildAutoCullSession([photo]);
    return [failed.stats.indexed, recovered.stats.indexed];
  });
  assert.deepEqual(retry, [0, 1], "Re-running analysis must retry failed image extraction");
  console.log(`Browser verification passed. Screenshots: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
