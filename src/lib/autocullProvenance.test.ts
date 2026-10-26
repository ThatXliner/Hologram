import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { automaticFeedbackPhotoIds, automaticPhotoIds, loadAutomaticDecisions, saveAutomaticDecisions } from "./autocullPlan.ts";
import { capturePreferenceFeatures, loadPreferenceFeatureSnapshots, loadPreferenceRefinements, rankAutoCullPhotos, savePreferenceFeedback } from "./autocull.ts";
import { createDecisionBook } from "./autocullDecisionBook.ts";
import type { Photo } from "./types.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});
function photo(id: string): Photo {
  return { id, file_path: `/Shoots/A/${id}.jpg`, file_name: `${id}.jpg`, file_size: 1, file_type: "JPEG", created_at: "2026-01-01", modified_at: "2026-01-01", exif: {}, flag: "pick", rating: 0 };
}

describe("automatic provenance across overlapping folders", () => {
  it("recognizes the same automatic flag when the photo is opened through a parent folder", () => {
    const source = photo("parent-folder-photo");
    saveAutomaticDecisions(storage, "/Shoots/A", { [source.id]: { flag: "pick", rating: 0 } });
    assert.deepEqual([...automaticPhotoIds([source], loadAutomaticDecisions(storage, "/Shoots"))], [source.id]);
  });

  it("migrates legacy folders once and never resurrects a confirmed decision", () => {
    storage.setItem("hologram.autocull.automatic.v1./Shoots/A", JSON.stringify({ a: { flag: "pick", rating: 0 } }));
    storage.setItem("hologram.autocull.automatic.v1./Shoots/B", JSON.stringify({ b: { flag: "reject", rating: 0 } }));
    const automatic = loadAutomaticDecisions(storage, "/Shoots");
    assert.deepEqual(Object.keys(automatic).sort(), ["a", "b"]);
    delete automatic.a;
    saveAutomaticDecisions(storage, "/Shoots", automatic);
    assert.equal(Object.hasOwn(loadAutomaticDecisions(storage, "/Shoots/A"), "a"), false);
    assert.equal(Object.hasOwn(loadAutomaticDecisions(storage, "/Shoots/B"), "b"), true);
    saveAutomaticDecisions(storage, "/Shoots/A", { ...automatic, a: { flag: "pick", rating: 0 } });
    assert.equal(Object.hasOwn(loadAutomaticDecisions(storage, "/Shoots"), "a"), true);
  });

  it("omits unconfirmed automatic feedback already stored as manual, then exports confirmation and reflects undo", async () => {
    const source = photo("contaminated-legacy-feedback");
    const analysis = rankAutoCullPhotos([source], new Map([[source.id, { embedding: [1, 0], technicalScore: 0.8, backend: "perceptual-dct-focus-v4" }]]));
    await capturePreferenceFeatures([source], analysis);
    savePreferenceFeedback("default", [{ photo_id: source.id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" }], []);
    saveAutomaticDecisions(storage, "/Shoots/A", { [source.id]: { flag: "pick", rating: 0 } });
    const unconfirmed = await createDecisionBook("default");
    assert.equal(unconfirmed.summary.manual_decisions, 0);
    assert.equal(unconfirmed.summary.omitted_decisions, 1);
    assert.equal(unconfirmed.summary.automatic_feedback, 1);
    saveAutomaticDecisions(storage, "/Shoots", {});
    assert.equal((await createDecisionBook("default")).summary.manual_decisions, 1);
    saveAutomaticDecisions(storage, "/Shoots", { [source.id]: { flag: "pick", rating: 0 } });
    assert.equal((await createDecisionBook("default")).summary.manual_decisions, 0);
  });
  it("retains conflicting legacy guesses until explicit review rather than picking an invented newest value", () => {
    const source = photo("ambiguous-legacy-guess");
    storage.setItem("hologram.autocull.automatic.v1./Shoots/A", JSON.stringify({ [source.id]: { flag: "pick", rating: 0 } }));
    storage.setItem("hologram.autocull.automatic.v1./Shoots", JSON.stringify({ [source.id]: { flag: "reject", rating: 0 } }));
    const migrated = loadAutomaticDecisions(storage, "/Shoots/A");
    assert.equal(automaticPhotoIds([source], migrated).has(source.id), true);
    assert.equal(automaticPhotoIds([{ ...source, flag: "reject" }], migrated).has(source.id), true);
    const reloaded = loadAutomaticDecisions(storage, "/unrelated");
    assert.equal(automaticPhotoIds([source], reloaded).has(source.id), true);
    assert.equal(automaticPhotoIds([{ ...source, flag: "reject" }], reloaded).has(source.id), true);
    saveAutomaticDecisions(storage, "/Shoots", {});
    assert.equal(automaticPhotoIds([source], loadAutomaticDecisions(storage, "/Shoots/A")).size, 0);
  });

  it("omits comparisons touching unconfirmed automatic photos while retaining human evidence", async () => {
    const sources = [photo("automatic-pair-endpoint"), photo("human-pair-endpoint")];
    await capturePreferenceFeatures(sources, rankAutoCullPhotos(sources, new Map(sources.map((source) => [source.id, { embedding: [1, 0], technicalScore: 0.8, backend: "perceptual-dct-focus-v4" }]))));
    savePreferenceFeedback("default", sources.map((source) => ({ photo_id: source.id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" })),
      [{ winner_photo_id: sources[0].id, loser_photo_id: sources[1].id, confidence: 1, source: "cluster_winner", created_at: "2026-01-01" }]);
    saveAutomaticDecisions(storage, "/Shoots/A", { [sources[0].id]: { flag: "pick", rating: 0 } });
    const book = await createDecisionBook("default");
    assert.equal(book.summary.manual_decisions, 1);
    assert.equal(book.summary.comparisons, 0);
    assert.equal(book.summary.omitted_comparisons, 1);
    assert.equal(book.summary.automatic_feedback, 1);
    assert.equal(book.photos.length, 1);
  });

  it("excludes old automatic feedback from training when its source photos are absent", async () => {
    const source = photo("absent-auto-source");
    const backend = "perceptual-dct-focus-v4";
    await capturePreferenceFeatures([source], rankAutoCullPhotos([source], new Map([[source.id, { embedding: [1, 0], technicalScore: 0.8, backend }]])));
    savePreferenceFeedback("default", [{ photo_id: source.id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" }], []);
    saveAutomaticDecisions(storage, "/Shoots/A", { [source.id]: { flag: "pick", rating: 0 } });
    const target: Photo = { ...photo("new-target"), flag: "none" };
    const refinements = loadPreferenceRefinements();
    const snapshots = await loadPreferenceFeatureSnapshots([source.id]);
    const features = new Map([[target.id, { embedding: [1, 0], technicalScore: 0.8, backend }]]);
    assert.equal(rankAutoCullPhotos([target], features, [], refinements, false, new Set(), snapshots).stats.training_examples, 1);
    const excluded = automaticFeedbackPhotoIds({ photos: [target], refinements, pairs: [], automatic: loadAutomaticDecisions(storage, "/Shoots") });
    assert.equal(rankAutoCullPhotos([target], features, [], refinements, false, excluded, snapshots).stats.training_examples, 0);
    assert.equal(excluded.has(source.id), true);
  });

});
