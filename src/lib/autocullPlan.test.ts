import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { automaticPhotoIds, buildAutoCullPlan, loadAutomaticDecisions, saveAutomaticDecisions } from "./autocullPlan.ts";
import { applyChanges, type StorageLike } from "./autocullReview.ts";
import { rankAutoCullPhotos } from "./autocull.ts";
import type { AutoCullPhoto, AutoCullSession, Photo } from "./types.ts";

function photo(id: string, overrides: Partial<Photo> = {}): Photo {
  return { id, file_path: `/photos/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG", file_size: 100,
    created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z", exif: {}, ...overrides };
}
function analysis(id: string, quality: number, score = quality, embedding: number[] | undefined = [1, 0]): AutoCullPhoto {
  return { photo_id: id, cluster_id: "", technical_score: quality, personal_score: 0.5, final_score: score,
    behavior_signal: 0, reasons: [], recommendation: "MAYBE", confidence: 0.8, embedding };
}
function session(records: AutoCullPhoto[], grouped = false): AutoCullSession {
  return { ...rankAutoCullPhotos([], new Map()), photos: records,
    clusters: grouped ? [{ id: "group", kind: "burst", confidence: 0.9, photo_ids: records.map((r) => r.photo_id),
      top_pick_id: records[0].photo_id, pick_margin: 0 }] : [] };
}
function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe("automatic cull policy", () => {
  it("keeps strong singles, rejects only very weak singles and leaves uncertain or missing pixels for review", () => {
    const photos = ["strong", "weak", "middle", "missing", "invalid"].map((id) => photo(id));
    const result = buildAutoCullPlan(photos, photos, session([
      analysis("strong", 0.7), analysis("weak", 0.25), analysis("middle", 0.5),
      { ...analysis("missing", 1), embedding: undefined }, analysis("invalid", 1, 1, [NaN, 0]),
    ]));
    assert.deepEqual(result.keepIds, ["strong"]);
    assert.deepEqual(result.rejectIds, ["weak"]);
    assert.deepEqual(result.reviewIds, ["middle", "missing", "invalid"]);
    assert.deepEqual(result.resolvedStackKeys, ["strong", "weak"]);
    assert.equal(result.changes.length, 2);
  });

  it("resolves a clear visual winner but leaves distinct close calls for review", () => {
    const photos = [photo("a"), photo("b")];
    const records = [analysis("a", 0.8, 0.75), analysis("b", 0.7, 0.6, [0.95, 0.312])];
    const clear = buildAutoCullPlan(photos, photos, session(records, true));
    assert.deepEqual(clear.keepIds, ["a"]);
    assert.deepEqual(clear.rejectIds, ["b"]);
    assert.deepEqual(clear.reviewIds, []);
    assert.deepEqual(clear.resolvedStackKeys, ["a|b"]);
    const close = buildAutoCullPlan(photos, photos, session([records[0], { ...records[1], final_score: 0.74 }], true));
    assert.deepEqual(close.changes, []);
    assert.deepEqual(close.reviewIds, ["a", "b"]);
  });

  it("chooses the same keeper for near-identical tied frames regardless of input order", () => {
    const photos = [photo("b"), photo("a")];
    const records = photos.map((p) => analysis(p.id, 0.7));
    for (const ordered of [records, [...records].reverse()]) {
      const result = buildAutoCullPlan(photos, photos, session(ordered, true));
      assert.deepEqual(result.keepIds, ["a"]);
      assert.deepEqual(result.rejectIds, ["b"]);
    }
  });

  it("preserves manual flags and ratings on either member, including a hidden partner", () => {
    for (const decision of [{ flag: "pick" }, { flag: "reject" }, { rating: 1 }] satisfies Partial<Photo>[]) {
      const raw = photo("raw", { paired_with: "jpeg" });
      const jpeg = photo("jpeg", { paired_with: "raw", ...decision });
      for (const visible of [[raw], [raw, jpeg]]) {
        const result = buildAutoCullPlan(visible, [raw, jpeg], session([analysis("raw", 0.8), analysis("jpeg", 0.1)], true));
        assert.deepEqual(result.changes, []);
        assert.deepEqual(result.reviewIds, []);
      }
    }
  });

  it("keeps both visible files of a winning pair without rejecting the keeper through its partner", () => {
    const photos = [photo("raw", { paired_with: "jpeg" }), photo("jpeg", { paired_with: "raw" }), photo("other")];
    const result = buildAutoCullPlan(photos, photos, session([
      analysis("raw", 0.8), analysis("jpeg", 0.2), analysis("other", 0.6),
    ], true));
    assert.deepEqual(result.keepIds, ["raw", "jpeg"]);
    assert.deepEqual(result.rejectIds, ["other"]);
    assert.deepEqual(result.changes.map((change) => [change.id, change.after.flag]).sort(), [["jpeg", "pick"], ["other", "reject"], ["raw", "pick"]]);
    assert.deepEqual(result.reviewIds, []);
  });

  it("counts visible decisions while updating a hidden partner and remains consistent across separate stacks", () => {
    const raw = photo("raw", { paired_with: "jpeg" });
    const jpeg = photo("jpeg", { paired_with: "raw" });
    const hidden = buildAutoCullPlan([raw], [raw, jpeg], session([analysis("raw", 0.8)]));
    assert.deepEqual(hidden.keepIds, ["raw"]);
    assert.equal(hidden.changes.length, 2);
    const separate = buildAutoCullPlan([raw, jpeg], [raw, jpeg], session([analysis("raw", 0.8), analysis("jpeg", 0.1)]));
    assert.deepEqual(separate.keepIds, ["raw", "jpeg"]);
    assert.deepEqual(separate.rejectIds, []);
    assert.equal(new Set(separate.changes.map((change) => change.after.flag)).size, 1);
  });
});

describe("automatic decision provenance", () => {
  it("persists across folders, recognizes applied choices, and releases a manually corrected photo", () => {
    const storage = memoryStorage();
    const photos = [photo("a"), photo("b")];
    const plan = buildAutoCullPlan(photos, photos, session([analysis("a", 0.8), analysis("b", 0.1)]));
    const automatic = Object.fromEntries(plan.changes.map((change) => [change.id, change.after]));
    saveAutomaticDecisions(storage, "/photos", automatic);
    const reloaded = loadAutomaticDecisions(storage, "/photos");
    assert.deepEqual(reloaded, automatic);
    assert.deepEqual(loadAutomaticDecisions(storage, "/other"), automatic);
    const applied = [...applyChanges(new Map(photos.map((p) => [p.id, p])), plan.changes, "after").values()];
    assert.deepEqual([...automaticPhotoIds(applied, reloaded)], ["a", "b"]);
    assert.deepEqual([...automaticPhotoIds(applied.map((p) => p.id === "a" ? { ...p, flag: "reject" } : p), reloaded)], ["b"]);
    delete reloaded.b; // An explicit confirmation of the same flag also transfers ownership to the user.
    assert.equal(automaticPhotoIds(applied, reloaded).size, 1);
  });

  it("ignores malformed stored entries and tolerates unavailable storage", () => {
    const storage: StorageLike = { getItem: () => '{"valid":{"flag":"pick","rating":0},"bad":{"flag":"reject","rating":99}}', setItem: () => { throw new Error("unavailable"); } };
    assert.deepEqual(loadAutomaticDecisions(storage, null), { valid: { flag: "pick", rating: 0 } });
    assert.doesNotThrow(() => saveAutomaticDecisions(storage, null, {}));
    assert.deepEqual(loadAutomaticDecisions({ ...storage, getItem: () => "invalid" }, null), {});
  });
});
