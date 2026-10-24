import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  metadataTrainingExclusions, capturePreferenceFeatures, createPreferenceProfile, loadActivePreferenceProfileId,
  loadPairwisePreferences, loadPreferenceFeatureSnapshots, loadPreferenceProfiles,
  loadPreferenceRefinements, rankAutoCullPhotos, recordPreferenceRefinement,
  savePairwisePreferences, savePreferenceRefinements, type PixelFeatures,
} from "./autocull.ts";
import type { AutoCullPairwisePreference, Photo } from "./types.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function photo(id: string): Photo {
  return { id, file_path: `/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG", file_size: 1,
    created_at: "2026-01-01", modified_at: "2026-01-01", exif: {} };
}
function pixels(photos: Photo[]): Map<string, PixelFeatures> {
  return new Map(photos.map((photo, index) => [photo.id, { embedding: index % 2 ? [0, 1] : [1, 0], technicalScore: 0.7, backend: "fixture" }]));
}
function pair(winner: string, loser: string): AutoCullPairwisePreference {
  return { winner_photo_id: winner, loser_photo_id: loser, confidence: 1, source: "cluster_winner", created_at: "2026-01-01" };
}

beforeEach(() => Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true }));

describe("library taste", () => {
  it("remembers choices with source shoot absent and isolates profiles", async () => {
    const source = [photo("shoot-a/keep"), photo("shoot-a/reject")];
    const analysis = rankAutoCullPhotos(source, pixels(source));
    const profile = createPreferenceProfile("Portraits");
    await recordPreferenceRefinement(profile.id, source[0].id, "pick", 0, source[0], analysis.photos[0]);
    await recordPreferenceRefinement(profile.id, source[1].id, "reject", 0, source[1], analysis.photos[1]);
    const target = [photo("shoot-b/like-keep"), photo("shoot-b/like-reject")];
    const snapshots = await loadPreferenceFeatureSnapshots(source.map((photo) => photo.id));
    const learned = rankAutoCullPhotos(target, pixels(target), [], loadPreferenceRefinements(profile.id), false, new Set(), snapshots);
    assert.equal(learned.stats.training_examples, 2);
    assert.ok(learned.photos[0].personal_score > learned.photos[1].personal_score + 0.01);
    assert.equal(loadActivePreferenceProfileId(), profile.id);
    assert.ok(loadPreferenceProfiles().some((item) => item.id === profile.id));
    const other = createPreferenceProfile("Landscape");
    const untouched = rankAutoCullPhotos(target, pixels(target), [], loadPreferenceRefinements(other.id), false, new Set(), snapshots);
    assert.equal(untouched.stats.training_examples, 0);
    assert.equal(untouched.photos[0].personal_score, untouched.photos[1].personal_score);
  });

  it("trains offline pairwise feedback and restores corrections exactly", async () => {
    const source = [photo("pair-a"), photo("pair-b")];
    const analysis = rankAutoCullPhotos(source, pixels(source));
    await capturePreferenceFeatures(source, analysis);
    savePairwisePreferences([pair(source[0].id, source[1].id)]);
    const target = [photo("pair-target-a"), photo("pair-target-b")];
    const snapshots = await loadPreferenceFeatureSnapshots(source.map((photo) => photo.id));
    const rank = () => rankAutoCullPhotos(target, pixels(target), loadPairwisePreferences(), [], false, new Set(), snapshots);
    const before = rank();
    assert.equal(before.stats.training_examples, 1);
    assert.ok(before.photos[0].personal_score > before.photos[1].personal_score);
    const saved = loadPairwisePreferences();
    savePairwisePreferences([pair(source[1].id, source[0].id)]);
    assert.ok(rank().photos[1].personal_score > rank().photos[0].personal_score);
    savePairwisePreferences(saved);
    assert.deepEqual(rank().photos, before.photos);
  });

  it("does not train missing, incompatible, invalid or automatic evidence", async () => {
    const source = [photo("valid-snapshot")];
    const analysis = rankAutoCullPhotos(source, pixels(source));
    await recordPreferenceRefinement("default", source[0].id, "pick", 0, source[0], analysis.photos[0]);
    const target = [photo("snapshot-target")];
    const refs = loadPreferenceRefinements();
    const snapshots = await loadPreferenceFeatureSnapshots([source[0].id]);
    const rank = (input = snapshots, excluded = new Set<string>()) => rankAutoCullPhotos(target, pixels(target), [], refs, false, excluded, input);
    assert.equal(rank(new Map()).stats.training_examples, 0);
    assert.equal(rank(snapshots, new Set([source[0].id])).stats.training_examples, 0);
    const snapshot = snapshots.get(source[0].id)!;
    for (const invalid of [{ ...snapshot, version: "old" }, { ...snapshot, backend: "other" }, { ...snapshot, rankerFeatures: [NaN] }, { ...snapshot, embedding: [0, 0] }]) {
      assert.equal(rank(new Map([[source[0].id, invalid]])).stats.training_examples, 0);
    }
    const original = refs;
    await recordPreferenceRefinement("default", source[0].id, "reject", 0);
    savePreferenceRefinements("default", original);
    assert.deepEqual(loadPreferenceRefinements(), original);
  });

  it("imports all legacy shoots once and never resurrects undone feedback", () => {
    const profile = { id: "portrait", name: "Portraits", created_at: "2026-01-01", updated_at: "2026-01-01" };
    localStorage.setItem("hologram.autocull.preferenceProfiles./old-a", JSON.stringify([profile]));
    for (const [folder, id] of [["/old-a", "legacy-a"], ["/old-b", "legacy-b"]]) {
      localStorage.setItem(`hologram.autocull.preferenceRefinements.${folder}.portrait`, JSON.stringify([{ photo_id: id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" }]));
      localStorage.setItem(`hologram.autocull.pairwise.${folder}.profile.portrait`, JSON.stringify([pair(id, `${id}-other`)]));
    }
    assert.equal(loadPreferenceRefinements("portrait").length, 2);
    assert.equal(loadPairwisePreferences("portrait").length, 2);
    assert.ok(loadPreferenceProfiles().some((item) => item.id === "portrait"));
    savePreferenceRefinements("portrait", []);
    savePairwisePreferences([], "portrait");
    assert.deepEqual(loadPreferenceRefinements("portrait"), []);
    assert.deepEqual(loadPairwisePreferences("portrait"), []);
    assert.notEqual(localStorage.getItem("hologram.autocull.preferenceRefinements./old-a.portrait"), null);
  });
  it("does not share learned features between backends in a mixed batch", async () => {
    const source = [photo("mixed-source-a"), photo("mixed-source-b")];
    const analysis = rankAutoCullPhotos(source, pixels(source));
    await recordPreferenceRefinement("default", source[0].id, "pick", 0, source[0], analysis.photos[0]);
    await recordPreferenceRefinement("default", source[1].id, "reject", 0, source[1], analysis.photos[1]);
    const target = [photo("mixed-target-compatible"), photo("mixed-target-other")];
    const targetPixels = pixels(target);
    targetPixels.set(target[1].id, { embedding: [1, 0], technicalScore: 0.7, backend: "other" });
    const snapshots = await loadPreferenceFeatureSnapshots(source.map((photo) => photo.id));
    const baseline = rankAutoCullPhotos(target, targetPixels, [], [], false);
    const learned = rankAutoCullPhotos(target, targetPixels, [], loadPreferenceRefinements(), false, new Set(), snapshots);
    assert.ok(learned.photos[0].personal_score > baseline.photos[0].personal_score);
    assert.equal(learned.photos[1].personal_score, baseline.photos[1].personal_score);
  });

  it("does not silently forget old shoots as the global library grows", () => {
    const refs = Array.from({ length: 4001 }, (_, index) => ({ photo_id: `large-${index}`, flag: "pick" as const, rating: 0,
      confidence: 1, source: "manual_decision" as const, updated_at: "2026-01-01" }));
    savePreferenceRefinements("default", refs);
    assert.equal(loadPreferenceRefinements().length, 4001);
    const pairs = Array.from({ length: 2001 }, (_, index) => pair(`winner-${index}`, `loser-${index}`));
    savePairwisePreferences(pairs);
    assert.equal(loadPairwisePreferences().length, 2001);
  });

  it("does not import another profile's labels through shared photo metadata", async () => {
    const source = [photo("owned-by-portrait")];
    const profile = createPreferenceProfile("Portraits");
    const analysis = rankAutoCullPhotos(source, pixels(source));
    await recordPreferenceRefinement(profile.id, source[0].id, "pick", 0, source[0], analysis.photos[0]);
    const flagged = [{ ...source[0], flag: "pick" as const }];
    const excluded = metadataTrainingExclusions("default");
    assert.ok(excluded.has(source[0].id));
    const session = rankAutoCullPhotos(flagged, pixels(source), [], [], true, new Set(), new Map(), excluded);
    assert.equal(session.stats.training_examples, 0);
    await recordPreferenceRefinement("default", source[0].id, "reject", 0);
    assert.equal(metadataTrainingExclusions("default").has(source[0].id), false);
  });

});
