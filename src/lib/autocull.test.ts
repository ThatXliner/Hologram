import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankAutoCullPhotos, type PixelFeatures } from "./autocull.ts";
import type { AutoCullPairwisePreference, Photo } from "./types.ts";

function photo(id: string, seconds?: number, overrides: Partial<Photo> = {}): Photo {
  return {
    id, file_path: `/photos/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG",
    file_size: 100, created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z",
    exif: seconds == null ? {} : { date_taken: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString() },
    ...overrides,
  };
}

function features(photos: Photo[], vectors: number[][], quality = 0.7): Map<string, PixelFeatures> {
  return new Map(photos.map((p, i) => [p.id, {
    embedding: vectors[i], technicalScore: quality, backend: "fixture",
  }]));
}

function preference(winner: string, loser: string): AutoCullPairwisePreference {
  return { winner_photo_id: winner, loser_photo_id: loser, confidence: 1, source: "cluster_winner", created_at: "2026-01-01T00:00:00Z" };
}

describe("autocull session ranking", () => {
  it("does not shift an unrelated photo after a single positive or negative decision", () => {
    const photos = [photo("rated"), photo("unrelated")];
    const pixels = features(photos, [[1, 0], [0, 1]]);
    const baseline = rankAutoCullPhotos(photos, pixels).photos[1];
    for (const flag of ["pick", "reject"] as const) {
      const result = rankAutoCullPhotos([{ ...photos[0], flag }, photos[1]], pixels).photos[1];
      assert.ok(Math.abs(result.personal_score - baseline.personal_score) < 0.01);
      assert.equal(result.recommendation, baseline.recommendation);
    }
  });

  it("learns from a single pair without interpreting both frames as absolute labels", () => {
    const photos = [photo("winner"), photo("loser")];
    const pixels = features(photos, [[1, 0], [0, 1]]);
    const result = rankAutoCullPhotos(photos, pixels, [preference("winner", "loser")]);
    assert.ok(result.photos[0].personal_score > result.photos[1].personal_score + 0.01);
    assert.notEqual(result.photos[1].recommendation, "REJECT");
  });

  it("honors an explicit rejection even when the photo has five stars", () => {
    const p = photo("rejected", undefined, { flag: "reject", rating: 5 });
    assert.equal(rankAutoCullPhotos([p], features([p], [[1, 0]], 1)).photos[0].recommendation, "REJECT");
  });

  it("learns a consistent ordering from comparisons with a shared middle frame", () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    const session = rankAutoCullPhotos(photos, features(photos, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]), [preference("a", "b"), preference("b", "c")]);
    assert.ok(session.photos[0].personal_score > session.photos[1].personal_score);
    assert.ok(session.photos[1].personal_score > session.photos[2].personal_score);
  });

  it("uses the latest comparison if the photographer changes their mind", () => {
    const photos = [photo("a"), photo("b")];
    const pixels = features(photos, [[1, 0], [0, 1]]);
    const session = rankAutoCullPhotos(photos, pixels, [preference("a", "b"), preference("b", "a")]);
    assert.ok(session.photos[1].personal_score > session.photos[0].personal_score);
    assert.equal(session.stats.training_examples, 1);
  });

  it("asks for review when pixels are unavailable, irrespective of risky EXIF settings", () => {
    const p = photo("tripod", undefined, { exif: { iso: 100, shutter_speed: "30", focal_length: 200 } });
    const result = rankAutoCullPhotos([p], new Map()).photos[0];
    assert.equal(result.recommendation, "NEEDS_REVIEW");
    assert.ok(result.confidence <= 0.5);
  });

  it("does not recommend an explicitly rejected frame as the cluster winner", () => {
    const photos = [photo("rejected", 0, { flag: "reject", rating: 5 }), photo("keeper", 1)];
    const pixels = features(photos, [[1, 0], [1, 0]], 0.1);
    pixels.get("rejected")!.technicalScore = 1;
    assert.equal(rankAutoCullPhotos(photos, pixels).clusters[0].top_pick_id, "keeper");
  });
});

describe("autocull grouping", () => {
  it("does not call sequential filenames separated by an hour a burst", () => {
    const photos = [photo("DSC_0001", 0), photo("DSC_0002", 3600)];
    const session = rankAutoCullPhotos(photos, features(photos, [[1, 0], [0.86, 0.51]]));
    assert.equal(session.clusters.length, 0);
  });

  it("prevents a burst from drifting away from its first frame", () => {
    const photos = [photo("a", 0), photo("b", 1), photo("c", 2)];
    const vectors = [0, 40, 80].map((degrees) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]);
    const session = rankAutoCullPhotos(photos, features(photos, vectors));
    assert.deepEqual(session.clusters.map((c) => c.photo_ids), [["a", "b"]]);
  });

  it("still groups filename sequences when capture times are absent", () => {
    const photos = [photo("DSC_0001"), photo("DSC_0002")];
    assert.equal(rankAutoCullPhotos(photos, features(photos, [[1, 0], [0.86, 0.51]])).clusters[0].kind, "burst");
  });

  it("does not disable similar groups when the library exceeds 2500 frames", () => {
    const photos = Array.from({ length: 2501 }, (_, i) => photo(`frame-${String(i * 10).padStart(5, "0")}`, i * 60));
    const session = rankAutoCullPhotos(photos, features(photos, photos.map(() => [1, 0])));
    assert.ok(session.clusters.length > 100);
    assert.equal(new Set(session.clusters.flatMap((c) => c.photo_ids)).size, 2501);
    assert.ok(session.clusters.every((c) => c.photo_ids.length <= 18));
  });

  it("gives deterministic membership and winners when input order changes", () => {
    const photos = [photo("same-b", 0), photo("same-a", 0), photo("same-c", 0)];
    const pixels = features(photos, photos.map(() => [1, 0]));
    assert.deepEqual(rankAutoCullPhotos(photos, pixels).clusters, rankAutoCullPhotos([...photos].reverse(), pixels).clusters);
  });

  it("finds distant duplicates in a large collection without cross-group contamination", () => {
    let seed = 12345;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    const photos = Array.from({ length: 3000 }, (_, i) => photo(`frame-${String(i * 10).padStart(5, "0")}`, i * 60));
    const vectors = photos.map(() => Array.from({ length: 128 }, random));
    for (let i = 0; i < 20; i++) vectors[2980 + i] = vectors[i].map((v) => v + random() * 0.1);
    const session = rankAutoCullPhotos(photos, features(photos, vectors));
    for (let i = 0; i < 20; i++) {
      const group = session.clusters.find((c) => c.photo_ids.includes(photos[i].id));
      assert.deepEqual(group?.photo_ids, [photos[i].id, photos[2980 + i].id]);
    }
    assert.equal(session.clusters.length, 20);
  });
});
