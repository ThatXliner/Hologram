import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoCullSession, capturePreferenceFeatures, loadPreferenceFeatureSnapshots,
  rankAutoCullPhotos, rankAutoCullPhotosWithNative, PREFERENCE_FEATURE_VERSION,
  type AutoCullPreferenceRefinement, type PixelFeatures,
} from "./autocull.ts";
import {
  loadAutoCullLearner, saveAutoCullLearner, nativeRankerRequest, parseNativeRankerResponse,
  NATIVE_RANKER_VERSION, type NativeRankerRequest, type NativeRankerResponse,
} from "./autocullNative.ts";
import type { Photo } from "./types.ts";

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
function response(request: NativeRankerRequest): NativeRankerResponse {
  const training_rows = request.pointwise.length + request.pairs.length * 2;
  return { schema_version: 1, xgboost_version: "3.1.1", ranker_version: NATIVE_RANKER_VERSION,
    scores: request.predict.map(() => training_rows ? 0.5 : null), base_margin: 0, training_rows, train_ms: 1, predict_ms: 0.1 };
}
const refinement = (photo_id: string): AutoCullPreferenceRefinement => ({ photo_id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" });

beforeEach(() => Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true }));

describe("native learner boundary", () => {
  it("defaults to built-in and keeps its device setting separate from feedback", () => {
    localStorage.setItem("hologram.autocull.taste.v1.feedback.default", "sentinel");
    assert.equal(loadAutoCullLearner(), "builtin");
    saveAutoCullLearner("xgboost-native");
    assert.equal(loadAutoCullLearner(), "xgboost-native");
    saveAutoCullLearner("builtin");
    assert.equal(loadAutoCullLearner(), "builtin");
    assert.equal(localStorage.getItem("hologram.autocull.taste.v1.feedback.default"), "sentinel");
  });

  it("preserves clipping and relative comparison weight", () => {
    const request = nativeRankerRequest([{ vector: [], features: [1], signal: 1, confidence: 10 }], [{ winnerFeatures: [1], loserFeatures: [0], confidence: 1 }], [[1]]);
    assert.deepEqual(request.pointwise, [{ features: [1], target: 0.97, weight: 2 }]);
    assert.equal(request.pairs[0].weight, 0.9);
    assert.equal(request.pairs[0].loser[0], 0);
  });

  it("rejects stale versions, missing predictions and trained nulls", () => {
    const request = nativeRankerRequest([{ vector: [], features: [1], signal: 1, confidence: 1 }], [], [[1]]);
    const valid = response(request);
    assert.deepEqual(parseNativeRankerResponse(valid, request), valid);
    assert.throws(() => parseNativeRankerResponse({ ...valid, schema_version: 9 }, request), /version/);
    assert.throws(() => parseNativeRankerResponse({ ...valid, xgboost_version: "old" }, request), /version/);
    assert.throws(() => parseNativeRankerResponse({ ...valid, scores: [] }, request), /shape/);
    assert.throws(() => parseNativeRankerResponse({ ...valid, scores: [null] }, request), /finite/);
    assert.throws(() => parseNativeRankerResponse({ ...valid, scores: [Infinity] }, request), /finite/);
    assert.throws(() => parseNativeRankerResponse({ ...valid, train_ms: -1 }, request), /timing/);
  });
});

describe("shared eligibility and score finalization", () => {
  it("keeps empty-feedback policy unchanged while executing the requested native learner", async () => {
    const photos = [photo("neutral-a"), photo("neutral-b")], features = pixels(photos);
    let calls = 0;
    const native = await rankAutoCullPhotosWithNative(photos, features, [], [], false, new Set(), new Map(), new Set(), async request => {
      calls++;
      assert.equal(request.pointwise.length + request.pairs.length, 0);
      return response(request);
    });
    const builtin = rankAutoCullPhotos(photos, features, [], [], false);
    assert.equal(calls, 1);
    assert.deepEqual(native.photos, builtin.photos);
    assert.deepEqual(native.clusters, builtin.clusters);
    assert.equal(native.ranker_version, NATIVE_RANKER_VERSION);
    assert.equal(native.learner?.engine, "xgboost-native");
  });

  it("excludes automatic observations and cross-profile metadata before the native boundary", async () => {
    const photos = [{ ...photo("auto"), flag: "pick" as const }, { ...photo("other-profile"), flag: "reject" as const }, photo("manual")];
    const features = pixels(photos);
    const pairs = [{ winner_photo_id: "auto", loser_photo_id: "manual", confidence: 1, source: "manual" as const, created_at: "2026-01-01" }];
    const native = await rankAutoCullPhotosWithNative(photos, features, pairs, [refinement("auto"), refinement("manual")], true, new Set(["auto"]), new Map(), new Set(["other-profile"]), async request => {
      assert.equal(request.pointwise.length, 1);
      assert.equal(request.pairs.length, 0);
      return response(request);
    });
    assert.equal(native.stats.training_examples, 1);
    const builtin = rankAutoCullPhotos(photos, features, pairs, [refinement("auto"), refinement("manual")], true, new Set(["auto"]), new Map(), new Set(["other-profile"]));
    assert.equal(native.stats.training_examples, builtin.stats.training_examples);
  });

  it("retains absent-shoot snapshots and separates embedding backends", async () => {
    const source = [photo("native-global-source")];
    const sourceSession = rankAutoCullPhotos(source, pixels(source));
    await capturePreferenceFeatures(source, sourceSession);
    const snapshots = await loadPreferenceFeatureSnapshots(source.map(photo => photo.id));
    assert.equal(snapshots.get(source[0].id)?.version, PREFERENCE_FEATURE_VERSION);
    const target = [photo("native-target-compatible"), photo("native-target-other")], features = pixels(target);
    features.get(target[1].id)!.backend = "other";
    const requests: NativeRankerRequest[] = [];
    const native = await rankAutoCullPhotosWithNative(target, features, [], [refinement(source[0].id)], false, new Set(), snapshots, new Set(), async request => {
      requests.push(request);
      return response(request);
    });
    assert.equal(native.stats.training_examples, 1);
    assert.deepEqual(requests.map(request => request.pointwise.length), [1, 0]);
    assert.ok(requests.every(request => request.predict.length === 1));
    assert.equal(snapshots.get(source[0].id)?.version, PREFERENCE_FEATURE_VERSION);
  });

  it("propagates native errors without producing a built-in session", async () => {
    const photos = [photo("failure")];
    await assert.rejects(rankAutoCullPhotosWithNative(photos, pixels(photos), [], [], false, new Set(), new Map(), new Set(), async () => { throw new Error("native unavailable"); }), /native unavailable/);
  });

  it("stops superseded image analysis before it imports feedback", async () => {
    const photos = [{ ...photo("stale"), flag: "pick" as const }];
    const before = [...Array(localStorage.length)].map((_, index) => localStorage.key(index));
    await assert.rejects(buildAutoCullSession(photos, [], () => {}, [], true, null, new Set(), "default", "builtin", () => false), /superseded/);
    assert.deepEqual([...Array(localStorage.length)].map((_, index) => localStorage.key(index)), before);
  });
});
