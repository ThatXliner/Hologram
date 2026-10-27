import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";
import {
  createPreferenceProfile,
  loadPairwisePreferences,
  loadPreferenceRefinements,
  saveActivePreferenceProfileId,
  savePreferenceFeedback,
} from "./autocull.ts";
import { loadAutomaticDecisions, saveAutomaticDecisions } from "./autocullPlan.ts";
import { loadResolutions, saveResolutions } from "./autocullReview.ts";
import { HologramAPI } from "./api.ts";
import { photoStore } from "./stores/photoStore.ts";
import type { AutoCullPairwisePreference, Photo, PhotoMetadata } from "./types.ts";
import { beginXmpImport, finishXmpImport, reconcileXmpImports, xmpImportState } from "./xmpImport.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failKey: string | null = null;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failKey === key) throw new Error("Storage quota exceeded");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  xmpImportState.set({ revision: 0, error: null, syncing: false, failedPhotoIds: [] });
  photoStore.reset();
  HologramAPI.setActiveFolderPath("/shoot");
});

function photo(id: string, pairedWith?: string): Photo {
  return {
    id, file_path: `/shoot/${id}.jpg`, file_name: `${id}.jpg`, file_size: 1, file_type: "JPEG",
    exif: {}, created_at: "2026-01-01", modified_at: "2026-01-01", flag: "reject", rating: 0,
    ...(pairedWith ? { paired_with: pairedWith } : {}),
  };
}

function imported(rating = 0, flag: PhotoMetadata["flag"] = "reject", revision = "import-1"): PhotoMetadata {
  return { tags: [], notes: "", rating, flag, xmp_cull_revision: revision };
}

describe("XMP import ownership", () => {
  it("blocks cached review before IPC and unlocks a rolled-back import without claiming saved metadata", () => {
    beginXmpImport();
    assert.equal(get(xmpImportState).syncing, true);
    assert.equal(get(xmpImportState).revision, 1);
    assert.equal(get(xmpImportState).error, null);
    finishXmpImport();
    assert.equal(get(xmpImportState).syncing, false);
    assert.equal(get(xmpImportState).error, null);
  });

  it("promotes an identical automatic reject to human feedback exactly once", () => {
    saveAutomaticDecisions(storage, "/shoot", { a: { flag: "reject", rating: 0 }, other: { flag: "pick", rating: 0 } });
    assert.equal(reconcileXmpImports({ a: imported() }, [photo("a")]), true);
    assert.deepEqual(loadAutomaticDecisions(storage, "/"), { other: { flag: "pick", rating: 0 } });
    const reviews = loadPreferenceRefinements();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].photo_id, "a");
    assert.equal(reviews[0].source, "manual_decision");
    assert.equal(reviews[0].flag, "reject");
    const firstRevision = get(xmpImportState).revision;
    assert.equal(reconcileXmpImports({ a: imported() }, [photo("a")]), false);
    assert.deepEqual(loadPreferenceRefinements(), reviews);
    assert.equal(get(xmpImportState).revision, firstRevision);
  });

  it("invalidates finished stacks and their comparisons across profiles and folder scopes", () => {
    const other = createPreferenceProfile("Other");
    saveActivePreferenceProfileId("default");
    const pair: AutoCullPairwisePreference = { winner_photo_id: "b", loser_photo_id: "c", confidence: 1, source: "cluster_winner", created_at: "2026-01-01" };
    for (const profile of ["default", other.id]) {
      savePreferenceFeedback(profile, [{ photo_id: "a", flag: "pick", rating: 5, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" }], [pair]);
      for (const folder of ["/shoot", "/"]) {
        saveResolutions(storage, folder, profile, {
          "a|b|c": { resolved_at: "2026-01-01", trained: true },
          "d|e": { resolved_at: "2026-01-01", trained: true },
        });
      }
    }
    reconcileXmpImports({ a: imported() }, [photo("a")]);
    assert.equal(loadPreferenceRefinements()[0].flag, "reject");
    assert.deepEqual(loadPreferenceRefinements(other.id), []);
    for (const profile of ["default", other.id]) {
      assert.deepEqual(loadPairwisePreferences(profile), []);
      for (const folder of ["/shoot", "/"]) assert.deepEqual(Object.keys(loadResolutions(storage, folder, profile)), ["d|e"]);
    }
  });

  it("reopens a displayed JPEG stack for its RAW import without copying the decision", () => {
    const sources = [photo("raw", "jpeg"), photo("jpeg", "raw"), photo("other")];
    saveResolutions(storage, "/shoot", "default", { "jpeg|other": { resolved_at: "2026-01-01", trained: false } });
    saveAutomaticDecisions(storage, "/shoot", { raw: { flag: "reject", rating: 0 }, jpeg: { flag: "reject", rating: 0 } });
    photoStore.setPhotos(sources);
    photoStore.applyImportedMetadata({ raw: imported(4, "none") }, "/shoot", sources);
    assert.equal(photoStore.photos.find((item) => item.id === "raw")?.rating, 4);
    assert.equal(photoStore.photos.find((item) => item.id === "jpeg")?.rating, 0);
    assert.deepEqual(Object.keys(loadAutomaticDecisions(storage, "/shoot")), ["jpeg"]);
    assert.deepEqual(loadResolutions(storage, "/shoot", "default"), {});
    assert.deepEqual(loadPreferenceRefinements().map((row) => row.photo_id), ["raw"]);
  });

  it("ignores metadata-only imports and preserves independent automatic ownership", () => {
    saveAutomaticDecisions(storage, "/shoot", { a: { flag: "reject", rating: 0 } });
    const item = { ...imported(), xmp_cull_revision: null, tags: ["blue"] };
    photoStore.setPhotos([photo("a")]);
    photoStore.applyImportedMetadata({ a: item }, "/shoot");
    assert.deepEqual(photoStore.photos[0].tags, ["blue"]);
    assert.deepEqual(Object.keys(loadAutomaticDecisions(storage, "/shoot")), ["a"]);
    assert.deepEqual(loadPreferenceRefinements(), []);
    assert.equal(get(xmpImportState).revision, 0);
  });

  it("keeps a failed import pending and retries without resurrecting finished-stack comparisons", () => {
    const other = createPreferenceProfile("Other");
    saveActivePreferenceProfileId("default");
    const pairs: AutoCullPairwisePreference[] = [{ winner_photo_id: "b", loser_photo_id: "c", confidence: 1, source: "cluster_winner", created_at: "2026-01-01" }];
    savePreferenceFeedback("default", [], pairs);
    savePreferenceFeedback(other.id, [], pairs);
    saveResolutions(storage, "/shoot", "default", { "a|b|c": { resolved_at: "2026-01-01", trained: true } });
    storage.failKey = `hologram.autocull.taste.v1.feedback.${encodeURIComponent(other.id)}`;
    assert.throws(() => reconcileXmpImports({ a: imported() }, [photo("a")]), /AutoCull could not synchronize/);
    assert.ok(get(xmpImportState).error);
    assert.ok(loadResolutions(storage, "/shoot", "default")["a|b|c"]);
    storage.failKey = null;
    assert.equal(reconcileXmpImports({ a: imported() }, [photo("a")]), true);
    assert.equal(get(xmpImportState).error, null);
    assert.deepEqual(loadPairwisePreferences("default"), []);
    assert.deepEqual(loadPairwisePreferences(other.id), []);
    assert.deepEqual(loadResolutions(storage, "/shoot", "default"), {});
  });

  it("does not acknowledge an import when its receipt cannot be persisted", () => {
    storage.failKey = "hologram.xmp.imports.v1";
    assert.throws(() => reconcileXmpImports({ a: imported() }, [photo("a")]));
    storage.failKey = null;
    assert.equal(reconcileXmpImports({ a: imported() }, [photo("a")]), true);
    assert.equal(loadPreferenceRefinements().length, 1);
    assert.equal(reconcileXmpImports({ a: imported() }, [photo("a")]), false);
  });

  it("clears stale review feedback when the imported state is unrated and unflagged", () => {
    savePreferenceFeedback("default", [{ photo_id: "a", flag: "pick", rating: 5, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" }], []);
    reconcileXmpImports({ a: imported(0, "none") }, [photo("a")]);
    assert.equal(loadPreferenceRefinements()[0].flag, "none");
    assert.equal(loadPreferenceRefinements()[0].rating, 0);
  });

  it("publishes imported decisions to both store lists but never a different active folder", () => {
    const source = photo("a");
    photoStore.setPhotos([source]);
    photoStore.setFilteredPhotos([source]);
    photoStore.applyImportedMetadata({ a: imported(3, "none") }, "/shoot");
    assert.equal(get(photoStore).photos[0].rating, 3);
    assert.equal(get(photoStore).filteredPhotos[0].rating, 3);
    HologramAPI.setActiveFolderPath("/different");
    photoStore.applyImportedMetadata({ a: imported(5, "none", "import-2") }, "/shoot", [source]);
    assert.equal(get(photoStore).photos[0].rating, 3);
    assert.equal(loadPreferenceRefinements()[0].rating, 5);
  });

  it("waits for writes in their original folder and rereads when a newer decision races refresh", async () => {
    const source = photo("a");
    photoStore.setPhotos([source]);
    const originalGet = HologramAPI.getPhotoMetadata;
    const originalSet = HologramAPI.setPhotoMetadata;
    const reads: (() => void)[] = [];
    const writes: (() => void)[] = [];
    const folders: (string | null | undefined)[] = [];
    let persisted = imported(3, "none");
    HologramAPI.getPhotoMetadata = async () => {
      const snapshot = persisted;
      await new Promise<void>((resolve) => reads.push(resolve));
      return { a: snapshot };
    };
    HologramAPI.setPhotoMetadata = async (_id, _tags, _notes, rating, flag, folder) => {
      folders.push(folder);
      await new Promise<void>((resolve) => writes.push(resolve));
      persisted = { tags: [], notes: "", rating: rating ?? 0, flag: flag ?? "none", xmp_cull_revision: null };
    };
    try {
      const refreshed = photoStore.refreshImportedMetadata(["a"], "/shoot", [source]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(get(xmpImportState).syncing, true);
      photoStore.setPhotoRating("a", 5);
      reads.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(reads.length, 0);
      writes.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(reads.length, 1);
      reads.shift()?.();
      await refreshed;
      assert.deepEqual(folders, ["/shoot"]);
      assert.equal(photoStore.photos[0].rating, 5);
      assert.equal(get(xmpImportState).syncing, false);
      assert.deepEqual(loadPreferenceRefinements(), []);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
      HologramAPI.setPhotoMetadata = originalSet;
    }
  });

  it("blocks cached AutoCull decisions if the post-import database read fails", async () => {
    const originalGet = HologramAPI.getPhotoMetadata;
    HologramAPI.getPhotoMetadata = async () => { throw new Error("Database unavailable"); };
    try {
      await assert.rejects(photoStore.refreshImportedMetadata(["a"], "/shoot", [photo("a")]), /AutoCull could not synchronize/);
      assert.ok(get(xmpImportState).revision > 0);
      assert.match(get(xmpImportState).error ?? "", /Database unavailable/);
      assert.equal(get(xmpImportState).syncing, false);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
    }
  });

  for (const { label, metadata } of [
    { label: "an already acknowledged cull import", metadata: imported() },
    { label: "a metadata-only import", metadata: { ...imported(), tags: ["client"], xmp_cull_revision: null } },
  ]) {
    it(`recovers from a failed database read when retrying ${label}`, async () => {
      const originalGet = HologramAPI.getPhotoMetadata;
      const source = photo("a");
      photoStore.setPhotos([source]);
      photoStore.applyImportedMetadata({ a: metadata }, "/shoot");
      const reviews = loadPreferenceRefinements();
      try {
        HologramAPI.getPhotoMetadata = async () => { throw new Error("Database temporarily unavailable"); };
        await assert.rejects(photoStore.refreshImportedMetadata(["a"], "/shoot", [source]));
        assert.deepEqual(get(xmpImportState).failedPhotoIds, ["a"]);
        HologramAPI.getPhotoMetadata = async () => ({ a: metadata });
        await photoStore.refreshImportedMetadata(["a"], "/shoot", [source]);
        assert.equal(get(xmpImportState).error, null);
        assert.deepEqual(get(xmpImportState).failedPhotoIds, []);
        assert.equal(get(xmpImportState).syncing, false);
        assert.deepEqual(loadPreferenceRefinements(), reviews);
      } finally {
        HologramAPI.getPhotoMetadata = originalGet;
      }
    });
  }

  it("keeps failed photos blocked until successful refreshes cover all of them", async () => {
    const originalGet = HologramAPI.getPhotoMetadata;
    const sources = [photo("a"), photo("b"), photo("c")];
    photoStore.setPhotos(sources);
    try {
      HologramAPI.getPhotoMetadata = async () => { throw new Error("Database temporarily unavailable"); };
      await assert.rejects(photoStore.refreshImportedMetadata(["a", "c"], "/shoot", sources));
      HologramAPI.getPhotoMetadata = async (ids) => Object.fromEntries(ids.map((id) => [id, imported(2, "none", `import-${id}`)]));
      await photoStore.refreshImportedMetadata(["b"], "/shoot", sources);
      assert.ok(get(xmpImportState).error);
      assert.deepEqual(get(xmpImportState).failedPhotoIds, ["a", "c"]);
      await photoStore.refreshImportedMetadata(["a"], "/shoot", sources);
      assert.ok(get(xmpImportState).error);
      assert.deepEqual(get(xmpImportState).failedPhotoIds, ["c"]);
      await photoStore.loadMetadata(["c"]);
      assert.equal(get(xmpImportState).error, null);
      assert.deepEqual(get(xmpImportState).failedPhotoIds, []);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
    }
  });

  it("does not apply an old load after the library was replaced", async () => {
    const originalGet = HologramAPI.getPhotoMetadata;
    let complete: (() => void) | undefined;
    let started: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    HologramAPI.getPhotoMetadata = async () => {
      started?.();
      await new Promise<void>((resolve) => { complete = resolve; });
      return { a: imported(5, "none") };
    };
    try {
      photoStore.setPhotos([photo("a")]);
      const loaded = photoStore.loadMetadata(["a"]);
      await readStarted;
      photoStore.setPhotos([{ ...photo("a"), rating: 2 }]);
      complete?.();
      await loaded;
      assert.equal(photoStore.photos[0].rating, 2);
      assert.deepEqual(loadPreferenceRefinements(), []);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
    }
  });

  it("retries a racing catalog load to preserve an edit and reconcile another photo's saved import", async () => {
    const originalGet = HologramAPI.getPhotoMetadata;
    const originalSet = HologramAPI.setPhotoMetadata;
    let releaseRead: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    let started: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    let reads = 0;
    const persisted: Record<string, PhotoMetadata> = {
      a: { tags: [], notes: "", rating: 0, flag: "none", xmp_cull_revision: null },
      b: { ...imported(4, "none", "pending-import-b"), tags: ["client"], notes: "Saved review" },
    };
    HologramAPI.getPhotoMetadata = async () => {
      reads++;
      const snapshot = { ...persisted };
      if (reads === 1) {
        started?.();
        await new Promise<void>((resolve) => { releaseRead = resolve; });
      }
      return snapshot;
    };
    HologramAPI.setPhotoMetadata = async (id, tags, notes, rating, flag) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      persisted[id] = { tags, notes, rating: rating ?? 0, flag: flag ?? "none", xmp_cull_revision: null };
    };
    try {
      photoStore.setPhotos([photo("a"), photo("b")]);
      saveAutomaticDecisions(storage, "/shoot", { b: { flag: "pick", rating: 0 } });
      const loaded = photoStore.loadMetadata(["a", "b"]);
      await readStarted;
      photoStore.setPhotoRating("a", 5);
      releaseRead?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(reads, 1);
      releaseWrite?.();
      await loaded;
      assert.equal(reads, 2);
      assert.equal(photoStore.photos.find((item) => item.id === "a")?.rating, 5);
      const savedImport = photoStore.photos.find((item) => item.id === "b");
      assert.equal(savedImport?.rating, 4);
      assert.equal(savedImport?.flag, "none");
      assert.deepEqual(savedImport?.tags, ["client"]);
      assert.equal(savedImport?.notes, "Saved review");
      assert.equal(get(photoStore).filteredPhotos.find((item) => item.id === "b")?.rating, 4);
      assert.deepEqual(loadPreferenceRefinements().map((row) => [row.photo_id, row.rating]), [["b", 4]]);
      assert.equal(Object.hasOwn(loadAutomaticDecisions(storage, "/shoot"), "b"), false);
      assert.equal(get(xmpImportState).syncing, false);
      assert.equal(reconcileXmpImports({ b: persisted.b }, photoStore.photos), false);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
      HologramAPI.setPhotoMetadata = originalSet;
    }
  });

  const readKinds: ("catalog" | "refresh")[] = ["catalog", "refresh"];
  const publicationKinds: ("refresh" | "direct")[] = ["refresh", "direct"];
  for (const readKind of readKinds) {
    for (const publicationKind of publicationKinds) {
      it(`keeps a newer ${publicationKind} import when an older ${readKind} read completes`, async () => {
        const originalGet = HologramAPI.getPhotoMetadata;
        const source = photo("a");
        const previous = imported(2, "none", "previous-import");
        const current = imported(5, "none", "current-import");
        let releaseRead: (() => void) | undefined;
        let started: (() => void) | undefined;
        const readStarted = new Promise<void>((resolve) => { started = resolve; });
        HologramAPI.getPhotoMetadata = async () => {
          started?.();
          await new Promise<void>((resolve) => { releaseRead = resolve; });
          return { a: previous };
        };
        try {
          photoStore.setPhotos([source]);
          const earlierRead = readKind === "catalog"
            ? photoStore.loadMetadata(["a"])
            : photoStore.refreshImportedMetadata(["a"], "/shoot", [source]);
          await readStarted;
          HologramAPI.getPhotoMetadata = async () => ({ a: current });
          if (publicationKind === "refresh") await photoStore.refreshImportedMetadata(["a"], "/shoot", [source]);
          else photoStore.applyImportedMetadata({ a: current }, "/shoot", [source]);
          const reviews = loadPreferenceRefinements();
          releaseRead?.();
          await earlierRead;
          assert.equal(photoStore.photos[0].rating, 5);
          assert.equal(get(photoStore).filteredPhotos[0].rating, 5);
          assert.deepEqual(loadPreferenceRefinements(), reviews);
          assert.equal(reconcileXmpImports({ a: current }, [source]), false);
        } finally {
          HologramAPI.getPhotoMetadata = originalGet;
        }
      });
    }
  }

  it("loads unrelated saved metadata after a failed edit without consuming the import flush error", async () => {
    const originalGet = HologramAPI.getPhotoMetadata;
    const originalSet = HologramAPI.setPhotoMetadata;
    const originalError = console.error;
    const errors: unknown[][] = [];
    const persisted: Record<string, PhotoMetadata> = {
      a: { tags: [], notes: "", rating: 0, flag: "none", xmp_cull_revision: null },
      b: { ...imported(4, "none", "pending-import-b"), tags: ["client"], notes: "Saved review" },
    };
    HologramAPI.getPhotoMetadata = async () => persisted;
    HologramAPI.setPhotoMetadata = async () => { throw new Error("Disk full"); };
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      photoStore.setPhotos([photo("a"), photo("b")]);
      photoStore.setPhotoRating("a", 5);
      await photoStore.loadMetadata(["a", "b"]);
      const savedImport = photoStore.photos.find((item) => item.id === "b");
      assert.equal(savedImport?.rating, 4);
      assert.deepEqual(savedImport?.tags, ["client"]);
      assert.equal(savedImport?.notes, "Saved review");
      assert.deepEqual(loadPreferenceRefinements().map((row) => [row.photo_id, row.rating]), [["b", 4]]);
      assert.equal(errors.length, 1);
      assert.equal(errors[0][0], "setPhotoMetadata failed:");
      await assert.rejects(photoStore.flushMetadataWrites(), /Disk full/);
    } finally {
      HologramAPI.getPhotoMetadata = originalGet;
      HologramAPI.setPhotoMetadata = originalSet;
      console.error = originalError;
    }
  });
});
