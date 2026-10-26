import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capturePreferenceFeatures, loadPreferenceFeatureSnapshots, preferenceSourceGroup,
  PREFERENCE_FEATURE_VERSION, rankAutoCullPhotos, recordPreferenceRefinement, savePreferenceFeedback,
  type AutoCullPreferenceRefinement, type PreferenceFeatureSnapshot,
} from "./autocull.ts";
import { buildDecisionBook, createDecisionBook } from "./autocullDecisionBook.ts";
import { parseDataset } from "../../scripts/xgboost-evaluation.ts";
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
const backend = "perceptual-dct-focus-v4";
function photo(id: string, folder = "/private/alice/shoot-one"): Photo {
  return { id, file_path: `${folder}/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG", file_size: 1,
    created_at: "2026-01-01", modified_at: "2026-01-01", exif: {} };
}
function decision(id: string, flag: "pick" | "reject" | "none" = "pick"): AutoCullPreferenceRefinement {
  return { photo_id: id, flag, rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" };
}
function comparison(winner: string, loser: string): AutoCullPairwisePreference {
  return { winner_photo_id: winner, loser_photo_id: loser, confidence: 1, source: "cluster_winner", created_at: "2026-01-01" };
}
function snapshot(id: string, group = "a"): PreferenceFeatureSnapshot {
  return { photoId: id, backend, version: PREFERENCE_FEATURE_VERSION,
    embedding: [1, 0], rankerFeatures: Array.from({ length: 267 }, (_, index) => index / 267),
    sourceGroup: `folder-sha256:${group.repeat(64)}` };
}
async function capture(photos: Photo[]) {
  const features = new Map(photos.map((item) => [item.id, { embedding: [1, 0], technicalScore: 0.7, backend }]));
  await capturePreferenceFeatures(photos, rankAutoCullPhotos(photos, features));
}
beforeEach(() => Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true }));

describe("decision books", () => {
  it("exports replayable manual evidence with anonymous identities and compatible evaluator datasets", () => {
    const ids = ["/private/alice/pick.jpg", "/private/alice/reject.jpg"];
    const book = buildDecisionBook({ refinements: [decision(ids[0]), decision(ids[1], "reject")],
      pairs: [comparison(ids[0], ids[1])], snapshots: new Map(ids.map((id, index) => [id, snapshot(id, index ? "b" : "a")])),
      createdAt: "2026-01-01" });
    assert.equal(book.grouping, "source-folder-unverified");
    assert.equal(book.summary.manual_decisions, 2);
    assert.equal(book.summary.comparisons, 1);
    assert.equal(book.summary.shoots, 2);
    assert.deepEqual(book.datasets[0].pointwise.map((row) => row.signal), [0.78, 0.175]);
    assert.deepEqual(book.photos[0].embedding, [1, 0]);
    assert.deepEqual(book.reviews.map((row) => row.flag), ["pick", "reject"]);
    assert.equal(parseDataset(book.datasets[0]).kind, "human");
    const encoded = JSON.stringify(book);
    for (const privateValue of [...ids, "/private", "alice", "folder-sha256"]) assert.ok(!encoded.includes(privateValue));
  });

  it("uses effective corrected decisions and reversed comparisons without accumulating history", () => {
    const snapshots = new Map(["a", "b"].map((id) => [id, snapshot(id)]));
    const book = buildDecisionBook({ refinements: [decision("a"), decision("a", "reject"), decision("b", "none")],
      pairs: [comparison("a", "b"), comparison("b", "a")], snapshots });
    assert.equal(book.reviews.length, 2);
    assert.equal(book.reviews[0].flag, "reject");
    assert.equal(book.datasets[0].pointwise.length, 1);
    assert.equal(book.datasets[0].pairs.length, 1);
    assert.equal(book.datasets[0].pairs[0].winnerId, book.photos[1].id);
  });

  it("reports missing, old, invalid and ungrouped feature evidence without inventing source shoots", () => {
    const snapshots = new Map(["old", "nan", "zero", "ungrouped", "unsupported"].map((id) => [id, snapshot(id)]));
    snapshots.set("old", { ...snapshot("old"), version: "old" });
    snapshots.set("nan", { ...snapshot("nan"), rankerFeatures: [NaN] });
    snapshots.set("zero", { ...snapshot("zero"), embedding: [0, 0] });
    snapshots.set("ungrouped", { ...snapshot("ungrouped"), sourceGroup: undefined });
    snapshots.set("unsupported", { ...snapshot("unsupported"), backend: "fixture" });
    const book = buildDecisionBook({ refinements: ["missing", ...snapshots.keys()].map((id) => decision(id)), pairs: [], snapshots });
    assert.equal(book.summary.unavailable_features, 5);
    assert.equal(book.summary.missing_shoot, 1);
    assert.equal(book.summary.omitted_decisions, 6);
    assert.equal(book.datasets.length, 0);
  });

  it("partitions backend evidence and omits incompatible comparisons", () => {
    const a = snapshot("backend-a"), b = { ...snapshot("backend-b", "b"), backend: "dinov2-small-transformersjs+perceptual-dct-focus-v4" };
    const book = buildDecisionBook({ refinements: [decision(a.photoId), decision(b.photoId)],
      pairs: [comparison(a.photoId, b.photoId)], snapshots: new Map([[a.photoId, a], [b.photoId, b]]) });
    assert.equal(book.datasets.length, 2);
    assert.ok(book.datasets.every((dataset) => dataset.photos.length === 1 && dataset.pairs.length === 0));
    assert.equal(book.summary.omitted_comparisons, 1);
    assert.equal(book.summary.comparisons, 0);
  });

  it("captures stable parent-folder groups with Windows separators while preserving case", async () => {
    assert.equal(await preferenceSourceGroup("C:\\Shoots\\One\\a.jpg"), await preferenceSourceGroup("C:/Shoots/One/b.nef"));
    assert.notEqual(await preferenceSourceGroup("/Shoots/One/a.jpg"), await preferenceSourceGroup("/shoots/One/a.jpg"));
    assert.notEqual(await preferenceSourceGroup("/shoots/one/a.jpg"), await preferenceSourceGroup("/shoots/two/a.jpg"));
    assert.equal(await preferenceSourceGroup("a.jpg"), undefined);
    const source = [photo("group-captured")];
    await capture(source);
    const saved = (await loadPreferenceFeatureSnapshots([source[0].id])).get(source[0].id);
    assert.equal(saved?.sourceGroup, await preferenceSourceGroup(source[0].file_path));
    assert.ok(!JSON.stringify(saved).includes("/private"));
  });

  it("reads one profile, ignores automatic-only photo flags and reflects undo", async () => {
    const source = [photo("profile-one"), photo("profile-two", "/private/alice/shoot-two"), photo("automatic-only")];
    await capture(source);
    await recordPreferenceRefinement("first-private-profile", source[0].id, "pick", 5);
    await recordPreferenceRefinement("second-private-profile", source[1].id, "reject", 0);
    const first = await createDecisionBook("first-private-profile", [{ ...source[2], flag: "pick" }]);
    assert.equal(first.summary.manual_decisions, 1);
    assert.equal(first.summary.photos, 1);
    assert.equal(first.reviews[0].rating, 5);
    assert.ok(!JSON.stringify(first).includes("first-private-profile"));
    savePreferenceFeedback("first-private-profile", [], []);
    assert.equal((await createDecisionBook("first-private-profile")).summary.manual_decisions, 0);
    assert.equal((await createDecisionBook("second-private-profile")).summary.manual_decisions, 1);
  });

  it("exports empty and single-shoot books without claiming evaluation readiness", () => {
    assert.equal(buildDecisionBook({ refinements: [], pairs: [], snapshots: new Map() }).datasets.length, 0);
    const book = buildDecisionBook({ refinements: [decision("single")], pairs: [], snapshots: new Map([["single", snapshot("single")]]) });
    assert.equal(book.summary.shoots, 1);
    assert.equal(book.grouping, "source-folder-unverified");
    assert.throws(() => parseDataset(book.datasets[0]), /two unique shoots/);
  });
  it("keeps feature captures and future writes available when source hashing fails", async () => {
    const original = crypto.subtle.digest;
    const source = [photo("hash-unavailable")];
    try {
      crypto.subtle.digest = async () => { throw new Error("Hash unavailable"); };
      await capture(source);
      const saved = (await loadPreferenceFeatureSnapshots([source[0].id])).get(source[0].id);
      assert.equal(saved?.sourceGroup, undefined);
      assert.equal(saved?.rankerFeatures.length, 267);
    } finally {
      crypto.subtle.digest = original;
    }
    const next = [photo("hash-restored")];
    await capture(next);
    const saved = (await loadPreferenceFeatureSnapshots([next[0].id])).get(next[0].id);
    assert.match(saved?.sourceGroup ?? "", /^folder-sha256:[a-f0-9]{64}$/);
    try {
      crypto.subtle.digest = async () => { throw new Error("Hash unavailable again"); };
      await capture(next);
      assert.equal((await loadPreferenceFeatureSnapshots([next[0].id])).get(next[0].id)?.sourceGroup, saved?.sourceGroup);
    } finally {
      crypto.subtle.digest = original;
    }
    const repaired = await loadPreferenceFeatureSnapshots([source[0].id], source);
    assert.match(repaired.get(source[0].id)?.sourceGroup ?? "", /^folder-sha256:[a-f0-9]{64}$/);
    assert.equal((await loadPreferenceFeatureSnapshots([source[0].id])).get(source[0].id)?.sourceGroup, repaired.get(source[0].id)?.sourceGroup);
  });

  it("backfills groups without overwriting a newer capture queued while hashing", async () => {
    const source = photo("concurrent-group");
    await capture([{ ...source, file_path: "relative.jpg" }]);
    let started: () => void = () => {};
    let release: () => void = () => {};
    const hashing = new Promise<void>((resolve) => { started = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const original = crypto.subtle.digest;
    let first = true;
    try {
      crypto.subtle.digest = async (algorithm, data) => {
        if (first) { first = false; started(); await paused; }
        return original.call(crypto.subtle, algorithm, data);
      };
      const backfill = loadPreferenceFeatureSnapshots([source.id], [source]);
      await hashing;
      const newer = { ...source, file_path: "/private/new-source/concurrent-group.jpg" };
      const features = new Map([[newer.id, { embedding: [0, 1], technicalScore: 0.2, backend }]]);
      await capturePreferenceFeatures([newer], rankAutoCullPhotos([newer], features));
      release();
      const result = (await backfill).get(source.id);
      assert.deepEqual(result?.embedding, [0, 1]);
      assert.equal(result?.rankerFeatures[0], 0.2);
      assert.equal(result?.sourceGroup, await preferenceSourceGroup(newer.file_path));
      assert.deepEqual((await loadPreferenceFeatureSnapshots([source.id])).get(source.id), result);
    } finally {
      release();
      crypto.subtle.digest = original;
    }
  });

});
