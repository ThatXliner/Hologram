// Run real preview extraction, ranking, and the AutoCull UI in a browser.
// Tauri filesystem operations are stubbed; image decoding and analysis are real.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "hologram-autocull-"));
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const executablePath = [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  .find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath }).catch(async (error) => {
  await server.close();
  throw error;
});

type Decision = { flag: string; rating: number };

async function decisions(page: Page, ids: string[]): Promise<Record<string, Decision>> {
  return page.evaluate(async (ids) => {
    const storePath = "/src/lib/stores/photoStore.ts";
    const { photoStore } = await import(storePath) as typeof import("../src/lib/stores/photoStore.ts");
    const byId = new Map(photoStore.photos.map((photo) => [photo.id, photo]));
    return Object.fromEntries(ids.map((id) => [id, { flag: byId.get(id)?.flag ?? "none", rating: byId.get(id)?.rating ?? 0 }]));
  }, ids);
}

async function invokeCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window as unknown as { __invokeCounts: Record<string, number> }).__invokeCounts }));
}

const AUTOMATIC_KEY = "hologram.autocull.automatic.v2";

async function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), key);
}

async function pairwise(page: Page): Promise<{ winner_photo_id: string; loser_photo_id: string }[]> {
  return JSON.parse((await stored(page, "hologram.autocull.taste.v1.feedback.default")) ?? "{}").pairs ?? [];
}

async function pairwiseCount(page: Page): Promise<number> {
  return (await pairwise(page)).length;
}

async function automaticIds(page: Page): Promise<string[]> {
  return Object.keys(JSON.parse((await stored(page, AUTOMATIC_KEY)) ?? "{}")).sort();
}

async function refinedIds(page: Page): Promise<string[]> {
  return (JSON.parse((await stored(page, "hologram.autocull.taste.v1.feedback.default")) ?? "{}").refinements ?? []).map((item: { photo_id: string }) => item.photo_id);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().addInitScript(() => {
    const counts: Record<string, number> = {};
    Object.assign(window, {
      __invokeCounts: counts,
      __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          counts[command] = (counts[command] ?? 0) + 1;
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
  const fixture = async (name: string) => (await readFile(new URL(`./fixtures/stock/${name}`, import.meta.url))).toString("base64");
  const portrait = await fixture("portrait.jpg");
  const images = { portrait, bear: await fixture("bear.jpg"), street: await fixture("street.jpg") };
  const result = await page.evaluate(async (images) => {
    const modulePath = "/src/lib/autocull.ts";
    const { buildAutoCullSession } = await import(modulePath) as typeof import("../src/lib/autocull.ts");
    async function thumbnail(data: string, draw: (ctx: CanvasRenderingContext2D, image: HTMLImageElement) => void = (ctx, image) => ctx.drawImage(image, 0, 0, 160, 160)) {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 160;
      const ctx = canvas.getContext("2d")!;
      draw(ctx, image);
      return canvas.toDataURL("image/png").split(",")[1];
    }
    const variants = ["original", "duplicate", "blurred", "noisy", "noisy-blurred", "black", "white"];
    const photos = [];
    for (const [i, id] of variants.entries()) {
      photos.push({
        id, file_name: `${id}.jpg`, file_path: `/fixture/${id}.jpg`, file_size: 100, file_type: "JPEG",
        thumbnail: await thumbnail(images.portrait, (ctx, image) => {
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
        }),
        exif: { date_taken: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() } as Record<string, unknown>,
        created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z",
      } as Record<string, unknown>);
    }
    photos.push({ ...photos[0], id: "unavailable", file_name: "unavailable.NEF", file_path: "/fixture/unavailable.NEF", file_type: "NEF", thumbnail: "", exif: { date_taken: "2026-01-02T00:00:00Z" } });
    const progress: number[] = [];
    const session = await buildAutoCullSession(photos as never, [], (p) => progress.push(p.current));
    const cached = await buildAutoCullSession(photos as never);
    // UI-only fixtures: a RAW+JPEG pair and an unrelated single, far from the burst in time.
    // The RAW half was rejected and the single rated in the grid: AutoCull must leave both alone.
    const bear = await thumbnail(images.bear);
    const library = [
      ...photos,
      { ...photos[0], id: "pair-jpg", file_name: "pair.jpg", file_path: "/fixture/pair.jpg", paired_with: "pair-raw", thumbnail: bear, exif: { date_taken: "2026-01-03T00:00:00Z" } },
      { ...photos[0], id: "pair-raw", file_name: "pair.NEF", file_path: "/fixture/pair.NEF", file_type: "NEF", paired_with: "pair-jpg", thumbnail: bear, flag: "reject", exif: { date_taken: "2026-01-03T00:00:00Z" } },
      { ...photos[0], id: "street", file_name: "street.jpg", file_path: "/fixture/street.jpg", thumbnail: await thumbnail(images.street), rating: 2, exif: { date_taken: "2026-01-04T00:00:00Z" } },
    ];
    const storePath = "/src/lib/stores/photoStore.ts";
    const { photoStore } = await import(storePath) as typeof import("../src/lib/stores/photoStore.ts");
    photoStore.setPhotos(library as never);
    return { session, cached, progress };
  }, images);
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

  // ── Review UI ──────────────────────────────────────────────────────────────
  const displayIds = ["original", "duplicate", "blurred", "noisy", "noisy-blurred", "black", "white", "unavailable", "pair-jpg", "street"];
  const view = page.locator("[data-autocull-view]");
  const rows = view.locator("[data-stack-key]");
  const currentRow = view.locator('[data-stack-key][aria-current="true"]');
  const currentKey = () => currentRow.getAttribute("data-stack-key");
  const status = () => view.locator("[data-autocull-status]").innerText();
  const press = async (key: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press(key);
  };
  const setFilter = (value: string) => view.locator(`[data-filter="${value}"]`).click();
  const rowKeys = async () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-stack-key")!));
  const overview = view.locator("[data-autocull-overview]");
  const overviewState = () => overview.getAttribute("data-autocull-overview-state");
  const planCount = async (kind: "keep" | "reject" | "review") => Number(await view.locator(`[data-autocull-plan-${kind}]`).getAttribute(`data-autocull-plan-${kind}`));
  const waitForAnalysis = () => page.waitForFunction(() => !document.querySelector("[data-autocull-view] .animate-spin"));
  const libraryIds = [...displayIds, "pair-raw"];
  const initialDecisions = {
    ...Object.fromEntries(libraryIds.map((id) => [id, { flag: "none", rating: 0 }])),
    "pair-raw": { flag: "reject", rating: 0 },
    street: { flag: "none", rating: 2 },
  };
  const openAdvanced = async () => {
    const advanced = view.locator("[data-autocull-advanced]");
    if (!(await advanced.evaluate((element) => (element as HTMLDetailsElement).open))) await advanced.locator("summary").click();
    return advanced;
  };
  const trainingCount = async () => {
    const match = (await (await openAdvanced()).innerText()).match(/(\d+) preferences learned/);
    assert.ok(match, "The inspector reports how many preferences the profile learned from");
    return Number(match[1]);
  };
  const todoCount = async () => Number((await view.locator('[data-filter="todo"]').innerText()).match(/(\d+)\s*$/)![1]);

  // ── Automatic pass: the primary screen previews what AutoCull would do ──────
  await page.getByRole("button", { name: "AutoCull", exact: true }).click();
  await overview.waitFor();
  await waitForAnalysis();
  await view.locator('[data-autocull-overview-state="preview"]').waitFor();
  const keepCount = await planCount("keep");
  const rejectCount = await planCount("reject");
  console.log("AutoCull plan:", { keep: keepCount, reject: rejectCount, review: await planCount("review") });
  assert.ok(keepCount + rejectCount > 0, "The fixtures give AutoCull something it is confident about");
  assert.ok(await planCount("review") >= 1, "Missing previews always wait for the photographer");
  assert.match(await view.locator("[data-autocull-untouched]").innerText(), /^2 photos you already decided/, "The rated single and the half-rejected pair are left alone");
  assert.deepEqual(await decisions(page, libraryIds), initialDecisions, "Previewing the plan changes nothing");

  // No photo is on screen in the overview, so decision keys must do nothing.
  for (const key of ["p", "x", "u", "3", "Enter", "s"]) await press(key);
  assert.deepEqual(await decisions(page, libraryIds), initialDecisions, "Hidden decision keys are inert on the overview");
  assert.ok(await view.getByRole("button", { name: "Undo", exact: true }).isDisabled(), "Nothing entered the undo history");

  // ── Manual review (before applying): queue, decisions, training, loupe ──────
  await view.getByRole("button", { name: "Review manually instead" }).click();
  await view.locator("[data-autocull-queue]").waitFor();
  await view.locator("[data-autocull-reasons]").waitFor();

  await setFilter("all");
  await rows.last().click();
  await press("5");
  const resumedKey = await currentKey();
  const beforeLeaving = await decisions(page, libraryIds);
  await openAdvanced();
  const beforeProgress = await view.locator("[data-autocull-progress]").innerText();
  const beforeAnalysis = (await invokeCounts(page)).find_missing_photo_ids;
  for (const tab of ["Settings", "Export", "Grid"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    assert.ok(await view.isHidden(), "AutoCull is hidden on the other tabs");
    if (tab !== "Grid") {
      for (const key of ["p", "x", "u", "3", "Enter", "s", "Control+z", "Meta+z"]) await press(key);
      assert.deepEqual(await decisions(page, libraryIds), beforeLeaving, "Hidden AutoCull shortcuts cannot change decisions or undo");
    }
  }
  await page.getByRole("button", { name: "AutoCull", exact: true }).click();
  await page.waitForFunction(() => {
    const view = document.querySelector("[data-autocull-view]");
    return view && view.getAttribute("data-autocull-mode") !== "loading";
  });
  assert.deepEqual(await decisions(page, libraryIds), beforeLeaving, "Photo decisions survive switching tabs");
  assert.equal(await view.getAttribute("data-autocull-mode"), "review", "Returning to AutoCull must resume review, not reset to overview");
  assert.equal(await currentKey(), resumedKey, "Returning to AutoCull keeps the selected stack");
  assert.equal((await invokeCounts(page)).find_missing_photo_ids, beforeAnalysis, "Returning to AutoCull reuses its analysis");
  assert.equal(await view.locator('[data-filter="all"]').getAttribute("aria-pressed"), "true", "Returning to AutoCull keeps its queue filter");
  assert.ok(await view.locator("[data-autocull-advanced]").evaluate((element) => element instanceof HTMLDetailsElement && element.open), "Returning to AutoCull keeps its open inspector");
  assert.equal(await view.locator("[data-autocull-progress]").innerText(), beforeProgress, "Review progress survives switching tabs");
  assert.ok(await view.getByRole("button", { name: "Undo", exact: true }).isEnabled(), "Review undo survives switching tabs");
  await view.getByRole("button", { name: "Undo", exact: true }).click();
  await setFilter("todo");
  console.log("Tab-switch resume preserves review, decisions, selection, progress, and undo");
  const trainingBaseline = await trainingCount();

  // Every display photo (singles included) appears in exactly one stack, in capture order.
  await setFilter("all");
  const allKeys = await rowKeys();
  const covered = allKeys.flatMap((key) => key.split("|"));
  assert.deepEqual([...covered].sort(), [...displayIds].sort(), "Queue must cover each visible photo exactly once");
  assert.ok(!covered.includes("pair-raw"), "The RAW half of a pair is reviewed through its JPEG");
  assert.ok(await view.locator('[data-stack-kind="single"]').count() >= 3, "Singles are part of the queue");
  assert.ok(await view.locator('[data-stack-key]:not([data-stack-kind="single"])').count() >= 1, "Related frames form a stack");
  assert.deepEqual(allKeys.slice(-3), ["unavailable", "pair-jpg", "street"], "Stacks follow capture order");
  assert.match(await view.locator("[data-autocull-progress]").innerText(), new RegExp(`1/${allKeys.length} stacks`), "Only the rated single starts done");

  // Analysis-flagged stacks are reachable through the Issues filter.
  await setFilter("issues");
  assert.ok(await view.locator('[data-stack-key="unavailable"]').count() === 1, "Missing previews are listed as issues");
  await setFilter("todo");
  const baseline = await invokeCounts(page);

  // Navigation: ↓/↑ move between stacks, Enter does nothing without a choice.
  await rows.first().click();
  const first = await currentKey();
  await press("ArrowDown");
  const second = await currentKey();
  assert.notEqual(second, first, "ArrowDown moves to the next stack");
  await press("ArrowUp");
  assert.equal(await currentKey(), first, "ArrowUp returns to the previous stack");
  await press("Enter");
  assert.equal(await currentKey(), first, "Enter without a choice must not finish the stack");
  assert.match(await status(), /before finishing/);

  // Saved decisions are separate from suggestions and update without re-analysis.
  await setFilter("issues");
  await view.locator('[data-stack-key="unavailable"]').click();
  assert.match(await view.locator("[data-autocull-reasons]").innerText(), /Preview unavailable/);
  await view.getByRole("button", { name: "Keep", exact: true }).click();
  await view.locator("[data-autocull-decision]").getByText("KEPT").waitFor();
  await view.getByRole("button", { name: "Reject", exact: true }).click();
  await view.locator("[data-autocull-decision]").getByText("REJECTED").waitFor();
  assert.doesNotMatch(await view.locator("[data-autocull-reasons]").innerText(), /You marked/, "Reasons only describe the suggestion");
  await press("Control+z");
  await press("Control+z");
  assert.deepEqual((await decisions(page, ["unavailable"])).unavailable, { flag: "none", rating: 0 }, "Undo restores button decisions");
  assert.match(await (await openAdvanced()).innerText(), /1 preview unavailable/);

  // RAW+JPEG: one keystroke flags both files, the single leaves the To review list, undo restores
  // only what it changed (the RAW half was already rejected in the grid).
  await setFilter("todo");
  await view.locator('[data-stack-key="pair-jpg"]').click();
  await press("x");
  assert.deepEqual(await decisions(page, ["pair-jpg", "pair-raw"]), {
    "pair-jpg": { flag: "reject", rating: 0 }, "pair-raw": { flag: "reject", rating: 0 },
  });
  assert.notEqual(await currentKey(), "pair-jpg", "A decided single advances to the next stack");
  assert.equal(await view.locator('[data-stack-key="pair-jpg"]').count(), 0, "Finished stacks leave the To review filter");
  await press("Control+z");
  assert.deepEqual(await decisions(page, ["pair-jpg", "pair-raw"]), {
    "pair-jpg": { flag: "none", rating: 0 }, "pair-raw": { flag: "reject", rating: 0 },
  }, "Undo restores both files of the pair to their earlier state");
  assert.equal(await currentKey(), "pair-jpg", "Undo returns to the undone photo");

  // Multi-frame stack: close call, frame navigation, keep suggested keeps stars.
  const stackRow = view.locator('[data-stack-key]:not([data-stack-kind="single"])').first();
  const stackKey = (await stackRow.getAttribute("data-stack-key"))!;
  const stackIds = stackKey.split("|");
  await stackRow.click();
  await view.locator("[data-autocull-close-call]").waitFor();
  const filmstrip = view.locator("[data-autocull-filmstrip]");
  const suggestedFrame = filmstrip.locator("[data-autocull-photo-id]").filter({ hasText: "SUGGESTED" });
  assert.equal(await suggestedFrame.count(), 1, "Exactly one suggested frame per stack");
  const suggestedId = (await suggestedFrame.getAttribute("data-autocull-photo-id"))!;
  assert.ok(stackIds.length >= 3, "The burst fixture should group at least three frames");
  const frameOrder = await filmstrip.locator("[data-autocull-photo-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-autocull-photo-id")!));
  assert.deepEqual([...frameOrder].sort(), [...stackIds].sort(), "The filmstrip shows every frame of the stack");
  await suggestedFrame.click();
  const currentFrame = () => filmstrip.locator('[aria-current="true"]').getAttribute("data-autocull-photo-id");
  await press("3");
  const suggestedIndex = frameOrder.indexOf(suggestedId);
  if (suggestedIndex < frameOrder.length - 1) {
    assert.equal(await currentFrame(), frameOrder[suggestedIndex + 1], "Rating advances to the next frame");
    await press("ArrowLeft");
  } else {
    assert.equal(await currentFrame(), suggestedId, "Rating the last frame stays inside the stack");
    await press("ArrowLeft");
    assert.equal(await currentFrame(), frameOrder[suggestedIndex - 1]);
    await press("ArrowRight");
  }
  assert.equal(await currentFrame(), suggestedId, "Arrow keys move between frames");
  await view.getByRole("button", { name: "Keep suggested", exact: true }).click();
  assert.deepEqual((await decisions(page, [suggestedId]))[suggestedId], { flag: "pick", rating: 3 }, "Keep suggested preserves stars");
  await suggestedFrame.getByText("KEPT").waitFor({ timeout: 1000 });
  await setFilter("all");
  assert.deepEqual(await rowKeys(), allKeys, "Decisions never reorder the queue");
  await setFilter("todo");

  // Keep selected & reject rest protects existing picks, trains, and is one undo step.
  const other = stackIds.find((id) => id !== suggestedId)!;
  await filmstrip.locator(`[data-autocull-photo-id="${other}"]`).click();
  const pairwiseBefore = await pairwiseCount(page);
  await view.locator("[data-autocull-keep-reject-rest]").click();
  const afterBatch = await decisions(page, stackIds);
  assert.deepEqual(afterBatch[suggestedId], { flag: "pick", rating: 3 }, "Existing picks keep their stars");
  assert.equal(afterBatch[other].flag, "pick");
  for (const id of stackIds.filter((id) => id !== suggestedId && id !== other)) assert.equal(afterBatch[id].flag, "reject");
  assert.ok(await pairwiseCount(page) > pairwiseBefore, "Finishing a stack with keepers trains the profile");
  const crossShootPhotos = await page.evaluate(async () => {
    const path = "/src/lib/stores/photoStore.ts";
    const { photoStore } = await import(path) as typeof import("../src/lib/stores/photoStore.ts");
    return photoStore.photos.filter((photo) => ["original", "blurred", "street"].includes(photo.id))
      .map((photo) => ({ ...photo, id: `shoot-b-${photo.id}`, file_path: `/shoot-b/${photo.file_name}`, flag: "none" as const, rating: 0 }));
  });
  const otherShoot = await page.context().newPage();
  await otherShoot.goto(server.resolvedUrls!.local[0]);
  const acrossShoots = await otherShoot.evaluate(async (photos) => {
    const path = "/src/lib/autocull.ts";
    const api = await import(path) as typeof import("../src/lib/autocull.ts");
    const neutral = await api.buildAutoCullSession(photos, [], () => {}, [], false, "/shoot-b");
    const learned = await api.buildAutoCullSession(photos, api.loadPairwisePreferences(), () => {}, api.loadPreferenceRefinements(), false, "/shoot-b");
    const isolated = await api.buildAutoCullSession(photos, api.loadPairwisePreferences("untrained-profile"), () => {}, api.loadPreferenceRefinements("untrained-profile"), false, "/shoot-b");
    return {
      neutral: neutral.photos.map((photo) => photo.personal_score),
      learned: learned.photos.map((photo) => photo.personal_score),
      isolated: isolated.photos.map((photo) => photo.personal_score),
      examples: learned.stats.training_examples,
    };
  }, crossShootPhotos);
  await otherShoot.close();
  assert.ok(acrossShoots.examples > 0, "A fresh app context learns from the previous shoot with its source photos absent");
  assert.notDeepEqual(acrossShoots.learned, acrossShoots.neutral, "Saved preferences influence another shoot's scores");
  assert.deepEqual(acrossShoots.isolated, acrossShoots.neutral, "A different profile does not inherit the first profile's taste");

  assert.notEqual(await currentKey(), stackKey, "The batch action finishes the stack and moves on");
  await press("Meta+z");
  const afterUndo = await decisions(page, stackIds);
  assert.deepEqual(afterUndo[suggestedId], { flag: "pick", rating: 3 });
  for (const id of stackIds.filter((id) => id !== suggestedId)) assert.deepEqual(afterUndo[id], { flag: "none", rating: 0 });
  assert.equal(await pairwiseCount(page), pairwiseBefore, "Undo removes the comparisons it trained");
  assert.equal(await currentKey(), stackKey);
  assert.equal(await view.locator(`[data-stack-key="${stackKey}"]`).getAttribute("data-stack-status"), "partial", "Undo reopens the stack");
  await page.screenshot({ path: join(output, "autocull-desktop.png") });
  await press("Control+z");
  await press("Control+z");
  assert.deepEqual(await decisions(page, stackIds), Object.fromEntries(stackIds.map((id) => [id, { flag: "none", rating: 0 }])), "Undo clears keep suggested and the rating");

  // Correcting a finished stack's winner reopens it and forgets what the old winner taught.
  const winner = suggestedId;
  const corrected = other;
  const winnerComparisons = (list: { winner_photo_id: string; loser_photo_id: string }[], id: string) => list.filter((item) => item.winner_photo_id === id).length;
  await setFilter("all");
  await filmstrip.locator(`[data-autocull-photo-id="${winner}"]`).click();
  await view.locator("[data-autocull-keep-reject-rest]").click();
  assert.equal(winnerComparisons(await pairwise(page), winner), stackIds.length - 1, "Finishing teaches that the winner beat every other frame");
  await view.locator(`[data-stack-key="${stackKey}"]`).click();
  assert.equal(await view.locator(`[data-stack-key="${stackKey}"]`).getAttribute("data-stack-status"), "done");
  await filmstrip.locator(`[data-autocull-photo-id="${corrected}"]`).click();
  await press("p");
  assert.match(await status(), /reopened/, "Changing the keepers of a finished stack says it reopened");
  assert.equal(await view.locator(`[data-stack-key="${stackKey}"]`).getAttribute("data-stack-status"), "partial", "The corrected stack needs finishing again");
  assert.equal(await pairwiseCount(page), pairwiseBefore, "The old winner's comparisons are dropped");
  await filmstrip.locator(`[data-autocull-photo-id="${winner}"]`).click();
  await press("x");
  await press("Enter");
  const retrained = await pairwise(page);
  assert.equal(winnerComparisons(retrained, winner), 0, "The previous winner no longer trains as the better frame");
  assert.ok(retrained.some((item) => item.winner_photo_id === corrected && item.loser_photo_id === winner), "The new winner trains against the old one");
  await press("Control+z"); // finish
  await press("Control+z"); // reject old winner
  await press("Control+z"); // keep new winner
  assert.equal(winnerComparisons(await pairwise(page), winner), stackIds.length - 1, "Undoing the correction restores the earlier comparisons");
  assert.equal(await view.locator(`[data-stack-key="${stackKey}"]`).getAttribute("data-stack-status"), "done", "Undoing the correction restores the finished stack");
  await press("Control+z"); // keep & reject rest
  assert.equal(await pairwiseCount(page), pairwiseBefore);

  // The loupe commits through the same history and training path as the stage.
  await view.locator(`[data-stack-key="${stackKey}"]`).click();
  await filmstrip.locator(`[data-autocull-photo-id="${frameOrder[0]}"]`).click();
  await view.getByRole("button", { name: "Loupe", exact: true }).click();
  await page.locator('[role="dialog"].fixed').waitFor();
  await page.keyboard.press("x");
  await page.keyboard.press("Escape");
  await page.locator('[role="dialog"].fixed').waitFor({ state: "detached" });
  assert.equal((await decisions(page, [frameOrder[0]]))[frameOrder[0]].flag, "reject", "A loupe reject is saved");
  assert.ok((await refinedIds(page)).includes(frameOrder[0]), "A loupe decision teaches the profile like a stage decision");
  assert.match((await view.getByRole("button", { name: "Undo", exact: true }).getAttribute("title"))!, /loupe decision/, "The loupe decision is in AutoCull's undo history");
  await press("Control+z");
  assert.deepEqual(await decisions(page, libraryIds), initialDecisions, "Every manual check above was undone");
  assert.ok(!(await refinedIds(page)).includes(frameOrder[0]), "Undo removes what the loupe decision taught");

  // None of the decisions above may re-run analysis or rescan files.
  await page.waitForTimeout(900);
  const afterDecisions = await invokeCounts(page);
  for (const command of ["find_missing_photo_ids", "read_autocull_feature_cache"]) {
    assert.equal(afterDecisions[command] ?? 0, baseline[command] ?? 0, `Decisions must not trigger ${command}`);
  }

  // ── Apply AutoCull: one undoable transaction that never trains ─────────────
  await view.locator("[data-autocull-show-overview]").click();
  await view.locator('[data-autocull-overview-state="preview"]').waitFor();
  assert.equal(await planCount("keep"), keepCount);
  assert.equal(await planCount("reject"), rejectCount);
  const trainingStorage = async () => [await stored(page, "hologram.autocull.taste.v1.feedback.default")];
  const trainingBefore = await trainingStorage();
  const applyAndCheck = async () => {
    await view.locator("[data-autocull-apply]").click();
    await view.locator('[data-autocull-overview-state="applied"]').waitFor();
    const applied = await decisions(page, libraryIds);
    const flagged = (flag: string) => displayIds.filter((id) => applied[id].flag === flag && initialDecisions[id].flag !== flag);
    assert.equal(flagged("pick").length, keepCount, "Every previewed keep was applied");
    assert.equal(flagged("reject").length, rejectCount, "Every previewed reject was applied");
    for (const id of ["pair-jpg", "pair-raw", "street", "unavailable"]) {
      assert.deepEqual(applied[id], initialDecisions[id], `${id}: existing, paired and unanalyzable photos are left alone`);
    }
    assert.deepEqual(await automaticIds(page), [...flagged("pick"), ...flagged("reject")].sort(), "AutoCull records which flags it set");
    assert.deepEqual(await trainingStorage(), trainingBefore, "The automatic pass never trains the profile");
  };
  await applyAndCheck();
  await page.screenshot({ path: join(output, "autocull-applied.png") });
  await press("Control+z");
  await view.locator('[data-autocull-overview-state="preview"]').waitFor();
  assert.deepEqual(await decisions(page, libraryIds), initialDecisions, "One undo reverts the whole automatic pass");
  assert.deepEqual(await automaticIds(page), [], "Undo forgets AutoCull's provenance too");
  await applyAndCheck();
  await page.waitForTimeout(900);
  const afterApply = await invokeCounts(page);
  for (const command of ["find_missing_photo_ids", "read_autocull_feature_cache"]) {
    assert.equal(afterApply[command] ?? 0, baseline[command] ?? 0, `Applying AutoCull must not trigger ${command}`);
  }

  // Re-analysis must not learn from AutoCull's own flags or plan them again.
  await view.getByRole("button", { name: "Refresh analysis" }).click();
  await page.waitForFunction((before) => {
    const counts = (window as unknown as { __invokeCounts: Record<string, number> }).__invokeCounts;
    return (counts.read_autocull_feature_cache ?? 0) > before;
  }, afterApply.read_autocull_feature_cache ?? 0);
  await waitForAnalysis();
  assert.equal(await overviewState(), "applied", "Nothing new to apply after re-analysis");
  const autoFlags = await automaticIds(page);
  await view.locator("[data-autocull-review-exceptions]").click();
  await view.locator("[data-autocull-queue]").waitFor();
  assert.notEqual(await currentRow.getAttribute("data-stack-status"), "done", "Review starts at a remaining exception");
  assert.equal(await trainingCount(), trainingBaseline, "AutoCull's flags are not training labels");

  // Confirming an automatic flag makes it the photographer's decision.
  await setFilter("all");
  const autoRow = rows.filter({ hasText: "auto ·" }).first();
  const confirmKey = (await autoRow.getAttribute("data-stack-key"))!;
  const confirmIds = confirmKey.split("|").filter((id) => autoFlags.includes(id));
  assert.ok(confirmIds.length > 0, "An AutoCull-flagged stack is marked in the queue");
  await autoRow.click();
  await view.locator("[data-autocull-provenance], [data-autocull-filmstrip]").first().waitFor();
  await press("Enter");
  const remainingAuto = await automaticIds(page);
  for (const id of confirmIds) {
    assert.ok(!remainingAuto.includes(id), `${id}: confirming clears AutoCull provenance`);
    assert.ok((await refinedIds(page)).includes(id), `${id}: a confirmed flag teaches the profile`);
  }
  await press("Control+z");
  assert.deepEqual(await automaticIds(page), autoFlags, "Undoing a confirmation restores provenance");

  // Skipping the last open stack must not claim the review is finished.
  await setFilter("todo");
  await view.locator('[data-stack-key]:not([data-stack-status="done"])').first().click();
  for (let step = 0; step < 40 && (await todoCount()) > 1; step++) {
    const kind = await currentRow.getAttribute("data-stack-kind");
    await press("p");
    if (kind !== "single") await press("Enter");
  }
  assert.equal(await todoCount(), 1);
  const lastKey = await currentKey();
  await press("n");
  assert.equal(await view.locator("[data-autocull-complete]").count(), 0, "Skipping is not finishing");
  assert.match(await status(), /only stack left/);
  assert.equal(await currentKey(), lastKey);
  const lastKind = await currentRow.getAttribute("data-stack-kind");
  await press("p");
  if (lastKind !== "single") await press("Enter");
  await view.locator("[data-autocull-complete]").waitFor();
  assert.match(await view.locator("[data-autocull-complete]").innerText(), new RegExp(`All ${allKeys.length} stacks reviewed`));
  assert.match(await view.locator("[data-autocull-progress]").innerText(), new RegExp(`${allKeys.length}/${allKeys.length} stacks`));
  await page.screenshot({ path: join(output, "autocull-complete.png") });

  // The completion screen shows no photo, so decision keys must do nothing there either.
  const completed = await decisions(page, libraryIds);
  for (const key of ["x", "u", "0", "3", "p", "Enter", "ArrowDown"]) await press(key);
  assert.deepEqual(await decisions(page, libraryIds), completed, "Hidden decision keys are inert on the completion screen");
  await view.getByRole("button", { name: "Review all stacks" }).click();
  assert.equal(await rows.count(), allKeys.length, "Completion offers a way back into every stack");
  await view.locator("[data-autocull-stage]").waitFor();

  // An explicit refresh is the way to re-rank with new decisions.
  const beforeRefresh = await invokeCounts(page);
  await view.getByRole("button", { name: "Refresh analysis" }).click();
  await page.waitForFunction((before) => {
    const counts = (window as unknown as { __invokeCounts: Record<string, number> }).__invokeCounts;
    return (counts.read_autocull_feature_cache ?? 0) > before;
  }, beforeRefresh.read_autocull_feature_cache ?? 0);
  await waitForAnalysis();

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({ path: join(output, "autocull-review.png") });
  await page.setViewportSize({ width: 800, height: 600 });
  await view.locator("[data-autocull-suggestion-line]").waitFor();
  await page.screenshot({ path: join(output, "autocull-compact.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "The default 800px window should not overflow horizontally");
  for (const name of ["Finish stack", "Next photo"]) {
    const button = view.getByRole("button", { name, exact: true });
    if (await button.count()) {
      const box = (await button.boundingBox())!;
      assert.ok(box.y + box.height <= 600 && box.x + box.width <= 800, `${name} stays on screen at 800x600`);
    }
  }
  assert.ok(((await view.locator("[data-autocull-stage]").boundingBox())?.height ?? 0) > 200, "The preview keeps usable height at 800x600");
  assert.ok(await view.locator("[data-autocull-queue]").isVisible(), "The queue rail stays visible at 800x600");

  // The overview fits the default window too: counts and the primary action stay visible.
  await view.locator("[data-autocull-show-overview]").click();
  await overview.waitFor();
  await page.screenshot({ path: join(output, "autocull-overview-compact.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "The overview should not overflow horizontally at 800px");
  for (const selector of ["[data-autocull-plan-keep]", "[data-autocull-plan-reject]", "[data-autocull-plan-review]", "[data-autocull-review-exceptions], [data-autocull-apply]"]) {
    const box = (await view.locator(selector).boundingBox())!;
    assert.ok(box.y + box.height <= 600 && box.x + box.width <= 800, `${selector} stays on screen at 800x600`);
  }
  assert.deepEqual(errors, [], "No browser runtime errors");

  // ── Ranking robustness ─────────────────────────────────────────────────────
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
  await view.getByRole("button", { name: /Review manually instead|Browse all stacks|Review .*exception/ }).first().click();
  await setFilter("all");
  await view.locator('[data-stack-key="street"]').click();
  await press("5");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.evaluate(async () => {
    const storePath = "/src/lib/stores/photoStore.ts";
    const { photoStore } = await import(storePath) as typeof import("../src/lib/stores/photoStore.ts");
    photoStore.setPhotoRating("street", 4);
  });
  await page.getByRole("button", { name: "AutoCull", exact: true }).click();
  await view.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await decisions(page, ["street"])).street.rating, 4, "Retained AutoCull undo must not overwrite a newer Grid decision");
  console.log(`Browser verification passed. Screenshots: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
