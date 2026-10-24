import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AutoCullPreferenceRefinement } from "./autocull.ts";
import {
  adjacentStackKey,
  applyChanges,
  buildReviewQueue,
  canFinishStack,
  canKeepSuggested,
  filterQueue,
  decisionSignature,
  resolutionIsCurrent,
  parseResolutions,
  loadResolutions,
  nextPendingKey,
  normalizeDecision,
  planDecision,
  planKeepSelectedRejectRest,
  planKeepSuggested,
  pushHistory,
  replacedPairwise,
  resolutionStorageKey,
  restoreRefinements,
  revertPairwise,
  saveResolutions,
  snapshotRefinements,
  stackIssues,
  stackPairwise,
  stackStatus,
  suggestionReasons,
  summarizeProgress,
  trainingPreferences,
  type ReviewStack,
  type PhotoDecision,
} from "./autocullReview.ts";
import type { AutoCullCluster, AutoCullPairwisePreference, AutoCullPhoto, AutoCullSession, Photo } from "./types.ts";

function photo(id: string, seconds: number | null, overrides: Partial<Photo> = {}): Photo {
  return {
    id, file_path: `/photos/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG",
    file_size: 100, created_at: "", modified_at: "",
    exif: seconds == null ? {} : { date_taken: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString() },
    ...overrides,
  };
}

function rec(id: string, overrides: Partial<AutoCullPhoto> = {}): AutoCullPhoto {
  return {
    photo_id: id, cluster_id: "", technical_score: 0.7, personal_score: 0.5, final_score: 0.6,
    behavior_signal: 0, reasons: [], recommendation: "MAYBE", confidence: 0.7, embedding: [1, 0],
    ...overrides,
  };
}

function cluster(id: string, photoIds: string[], topPick: string, margin = 0.2): AutoCullCluster {
  return { id, kind: "burst", confidence: 0.9, photo_ids: photoIds, top_pick_id: topPick, pick_margin: margin };
}

function session(photos: AutoCullPhoto[], clusters: AutoCullCluster[]): AutoCullSession {
  return {
    embedding_backend: "fixture", ranker_version: "test", generated_at: "", photos, clusters,
    stats: { total: photos.length, indexed: photos.length, select: 0, maybe: 0, reject: 0, needs_review: 0, training_examples: 0 },
  };
}

function lookup(photos: Photo[]) {
  const byId = new Map(photos.map((item) => [item.id, item]));
  return { byId, decisionOf: (id: string) => normalizeDecision(byId.get(id)) };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
}

describe("review queue", () => {
  const photos = [photo("late-single", 50), photo("b2", 11), photo("b1", 10), photo("early-single", 1), photo("undated", null)];
  const analysis = session(
    photos.map((item) => rec(item.id)),
    [cluster("burst-1", ["b2", "b1"], "b2", 0.01)],
  );

  it("covers every photo exactly once, including singles, in capture order", () => {
    const queue = buildReviewQueue(photos, analysis);
    assert.deepEqual(queue.map((stack) => stack.photoIds), [["early-single"], ["b1", "b2"], ["late-single"], ["undated"]]);
    assert.deepEqual(queue.flatMap((stack) => stack.photoIds).sort(), photos.map((item) => item.id).sort());
    assert.equal(queue[1].kind, "burst");
    assert.equal(queue[0].kind, "single");
  });

  it("keeps stack keys and order stable when scores and the top pick change", () => {
    const rescored = session(
      photos.map((item) => rec(item.id, { final_score: Math.random() })),
      [cluster("burst-9", ["b1", "b2"], "b1")],
    );
    assert.deepEqual(buildReviewQueue(photos, rescored).map((stack) => stack.key), buildReviewQueue(photos, analysis).map((stack) => stack.key));
  });

  it("builds a singles-only queue before analysis and drops filtered-out cluster members", () => {
    assert.ok(buildReviewQueue(photos, null).every((stack) => stack.kind === "single"));
    const queue = buildReviewQueue(photos.filter((item) => item.id !== "b2"), analysis);
    assert.deepEqual(queue.find((stack) => stack.photoIds.includes("b1"))?.photoIds, ["b1"]);
    assert.equal(queue.find((stack) => stack.photoIds.includes("b1"))?.kind, "single");
  });

  it("only suggests analyzed, non-rejected frames and flags close calls", () => {
    const queue = buildReviewQueue(photos, analysis);
    assert.equal(queue[1].suggestedId, "b2");
    assert.equal(queue[1].closeCall, true);
    const noPreview = session(photos.map((item) => rec(item.id, item.id === "b2" ? { embedding: undefined } : {})), analysis.clusters);
    const stack = buildReviewQueue(photos, noPreview)[1];
    assert.equal(stack.suggestedId, null);
    assert.equal(stack.closeCall, false);
    assert.deepEqual(stackIssues(stack, new Map(noPreview.photos.map((item) => [item.photo_id, item]))), ["preview-missing"]);
  });

  it("reports low technical quality as an issue without depending on saved flags", () => {
    const low = session([rec("early-single", { technical_score: 0.2 })], []);
    const stack = buildReviewQueue([photo("early-single", 1, { flag: "pick" })], low)[0];
    assert.deepEqual(stackIssues(stack, new Map(low.photos.map((item) => [item.photo_id, item]))), ["low-quality"]);
  });
});

describe("review status, filters and navigation", () => {
  const burst: ReviewStack = { key: "a|b|c", kind: "burst", photoIds: ["a", "b", "c"], suggestedId: "b", closeCall: false, similarity: 0.9, startTime: null };
  const single: ReviewStack = { key: "d", kind: "single", photoIds: ["d"], suggestedId: null, closeCall: false, similarity: null, startTime: null };
  const third: ReviewStack = { key: "e", kind: "single", photoIds: ["e"], suggestedId: null, closeCall: false, similarity: null, startTime: null };
  const stacks = [burst, single, third];

  it("treats singles as done once decided and bursts as done once resolved", () => {
    const { decisionOf } = lookup([photo("a", 1, { flag: "pick" }), photo("b", 2), photo("c", 3), photo("d", 4, { rating: 2 })]);
    assert.equal(stackStatus(single, decisionOf, false), "done");
    assert.equal(stackStatus(burst, decisionOf, false), "partial");
    assert.equal(stackStatus(burst, decisionOf, true), "done");
  });

  it("keeps fully decided bursts pending until explicitly resolved", () => {
    const { decisionOf } = lookup([photo("a", 1, { flag: "pick" }), photo("b", 2, { flag: "reject" }), photo("c", 3, { rating: 1 })]);
    assert.equal(stackStatus(burst, decisionOf, false), "partial");
    assert.equal(stackStatus(burst, decisionOf, true), "done");
  });

  it("reopens a resolved stack when every decision is cleared", () => {
    const { decisionOf } = lookup([photo("a", 1), photo("b", 2), photo("c", 3)]);
    assert.equal(stackStatus(burst, decisionOf, true), "todo");
  });

  it("summarizes progress and completion", () => {
    const { decisionOf } = lookup([photo("a", 1, { flag: "pick" }), photo("b", 2, { flag: "reject" }), photo("c", 3), photo("d", 4, { flag: "reject" }), photo("e", 5, { rating: 3 })]);
    const statusOf = (stack: ReviewStack) => stackStatus(stack, decisionOf, stack === burst);
    assert.deepEqual(summarizeProgress(stacks, statusOf, decisionOf), {
      stacks: 3, done: 3, partial: 0, photos: 5, decidedPhotos: 4, kept: 1, rejected: 2, complete: true,
    });
  });

  it("keeps the pinned stack visible in the To review filter", () => {
    const statusOf = (stack: ReviewStack) => (stack === single ? "done" as const : "todo" as const);
    assert.deepEqual(filterQueue(stacks, "todo", statusOf, () => []).map((stack) => stack.key), ["a|b|c", "e"]);
    assert.deepEqual(filterQueue(stacks, "todo", statusOf, () => [], "d").map((stack) => stack.key), ["a|b|c", "d", "e"]);
    assert.deepEqual(filterQueue(stacks, "issues", statusOf, (stack) => (stack === third ? ["low-quality"] : [])).map((stack) => stack.key), ["e"]);
  });

  it("navigates within the filtered list and from a hidden stack by queue order", () => {
    const visible = [burst, third];
    assert.equal(adjacentStackKey(stacks, visible, "a|b|c", 1), "e");
    assert.equal(adjacentStackKey(stacks, visible, "e", 1), null);
    assert.equal(adjacentStackKey(stacks, visible, "d", 1), "e");
    assert.equal(adjacentStackKey(stacks, visible, "d", -1), "a|b|c");
  });

  it("advances to the next pending stack, wrapping, and reports completion", () => {
    const pending = new Set(["a|b|c"]);
    const statusOf = (stack: ReviewStack) => (pending.has(stack.key) ? "todo" as const : "done" as const);
    assert.equal(nextPendingKey(stacks, "e", statusOf), "a|b|c");
    pending.clear();
    assert.equal(nextPendingKey(stacks, "e", statusOf), null);
  });
});

describe("review actions", () => {
  const raw = photo("raw", 1, { file_type: "NEF", paired_with: "jpg" });
  const jpg = photo("jpg", 1, { paired_with: "raw", rating: 3 });
  const stack: ReviewStack = {
    key: "jpg|other|picked|rated", kind: "burst", photoIds: ["jpg", "other", "picked", "rated"],
    suggestedId: "jpg", closeCall: false, similarity: 0.9, startTime: null,
  };
  const all = [raw, { ...jpg }, photo("other", 2), photo("picked", 3, { flag: "pick" }), photo("rated", 4, { rating: 2 })];

  it("applies decisions to both files of a RAW+JPEG pair and reverts them", () => {
    const { byId } = lookup(all);
    const changes = planDecision(["jpg"], byId, { flag: "reject" });
    assert.deepEqual(changes.map((change) => change.id), ["jpg", "raw"]);
    const after = applyChanges(byId, changes, "after");
    assert.equal(after.get("raw")?.flag, "reject");
    const undone = applyChanges(after, changes, "before");
    assert.deepEqual(normalizeDecision(undone.get("raw")), normalizeDecision(raw));
    assert.deepEqual(normalizeDecision(undone.get("jpg")), normalizeDecision(jpg));
  });

  it("keeps the suggested frame without changing its stars", () => {
    const { byId } = lookup(all);
    const changes = planKeepSuggested(stack, byId);
    assert.deepEqual(changes.find((change) => change.id === "jpg")?.after, { flag: "pick", rating: 3 });
    assert.ok(changes.some((change) => change.id === "raw"));
    const rejected = lookup(all.map((item) => (item.id === "jpg" ? { ...item, flag: "reject" as const } : item))).byId;
    assert.equal(canKeepSuggested(stack, rejected), false);
    assert.deepEqual(planKeepSuggested(stack, rejected), []);
  });

  it("does not override a rejected RAW partner when keeping a suggestion", () => {
    const { byId } = lookup(all.map((item) => item.id === "raw" ? { ...item, flag: "reject" as const } : item));
    assert.equal(canKeepSuggested(stack, byId), false);
    assert.deepEqual(planKeepSuggested(stack, byId), []);
  });

  it("keeps both selected files when both are visible in the stack", () => {
    const { byId } = lookup([raw, { ...jpg, rating: 0 }, photo("other", 2)]);
    const changes = planKeepSelectedRejectRest({ ...stack, photoIds: ["jpg", "raw", "other"] }, "jpg", byId);
    assert.deepEqual(changes.map((change) => [change.id, change.after.flag]), [["jpg", "pick"], ["raw", "pick"], ["other", "reject"]]);
  });

  it("rejects only undecided frames when keeping the selected frame", () => {
    const { byId } = lookup(all);
    const changes = planKeepSelectedRejectRest(stack, "jpg", byId);
    assert.deepEqual(changes.map((change) => [change.id, change.after.flag, change.after.rating]), [
      ["jpg", "pick", 3], ["raw", "pick", 0], ["other", "reject", 0],
    ]);
  });

  it("requires a deliberate choice before finishing", () => {
    const empty = lookup([photo("a", 1), photo("b", 2)]);
    const pair: ReviewStack = { ...stack, key: "a|b", photoIds: ["a", "b"] };
    assert.equal(canFinishStack(pair, empty.decisionOf).ok, false);
    const rated = lookup([photo("a", 1, { rating: 1 }), photo("b", 2)]);
    assert.equal(canFinishStack(pair, rated.decisionOf).ok, true);
  });

  it("trains keepers against the other frames only when both exist", () => {
    const { decisionOf } = lookup(all);
    const prefs = trainingPreferences(stack, decisionOf, "t");
    assert.deepEqual(prefs.map((item) => [item.winner_photo_id, item.loser_photo_id]), [["picked", "jpg"], ["picked", "other"], ["picked", "rated"]]);
    const none = lookup([photo("a", 1, { flag: "reject" }), photo("b", 2)]);
    assert.deepEqual(trainingPreferences({ ...stack, photoIds: ["a", "b"] }, none.decisionOf, "t"), []);
  });
});

describe("undo and persistence", () => {
  function pref(winner: string, loser: string, at: string): AutoCullPairwisePreference {
    return { winner_photo_id: winner, loser_photo_id: loser, confidence: 1, source: "cluster_winner", created_at: at };
  }
  function refinement(id: string, at: string): AutoCullPreferenceRefinement {
    return { photo_id: id, flag: "pick", rating: 0, confidence: 1, source: "manual_decision", updated_at: at };
  }

  it("restores replaced comparisons and removes added ones", () => {
    const earlier = pref("b", "a", "1");
    const unrelated = pref("c", "d", "1");
    const added = [pref("a", "b", "2")];
    const replaced = replacedPairwise([earlier, unrelated], added);
    assert.deepEqual(replaced, [earlier]);
    assert.deepEqual(revertPairwise([unrelated, ...added], added, replaced), [unrelated, earlier]);
  });

  it("removes only learned comparisons fully contained in the reopened stack", () => {
    const learned = pref("a", "b", "1");
    const manual: AutoCullPairwisePreference = { ...pref("b", "a", "2"), source: "manual" };
    const crossStack = pref("a", "c", "1");
    const unrelated = pref("d", "e", "1");
    assert.deepEqual(stackPairwise([learned, manual, crossStack, unrelated], ["a", "b"]), [learned]);
  });

  it("restores refinement entries, including absent ones", () => {
    const before = snapshotRefinements([refinement("a", "1")], ["a", "b"]);
    assert.deepEqual(before, { a: refinement("a", "1"), b: null });
    const after = [refinement("a", "3"), refinement("b", "3"), refinement("c", "2")];
    assert.deepEqual(restoreRefinements(after, before), [refinement("a", "1"), refinement("c", "2")]);
  });

  it("caps undo history", () => {
    let history: number[] = [];
    for (let index = 0; index < 5; index++) history = pushHistory(history, index, 3);
    assert.deepEqual(history, [2, 3, 4]);
  });

  it("scopes resolutions per folder and profile and migrates legacy confirmations", () => {
    const storage = memoryStorage();
    saveResolutions(storage, "/a", "default", { x: { resolved_at: "t", trained: false } });
    assert.deepEqual(loadResolutions(storage, "/a", "other"), {});
    assert.deepEqual(loadResolutions(storage, "/b", "default"), {});
    assert.equal(loadResolutions(storage, "/a", "default").x?.resolved_at, "t");
    assert.notEqual(resolutionStorageKey("/a", "default"), resolutionStorageKey("/a", "other"));
    storage.setItem("hologram.autocull.confirmed:/a", JSON.stringify(["legacy"]));
    assert.equal(loadResolutions(storage, "/a", "default").legacy, undefined);
    storage.data.delete(resolutionStorageKey("/a", "default"));
    assert.ok(loadResolutions(storage, "/a", "default").legacy);
    saveResolutions(storage, "/a", "default", {});
    assert.deepEqual(loadResolutions(storage, "/a", "default"), {});
    assert.equal(loadResolutions(storage, "/a", "other").legacy, undefined);
  });

  it("separates suggestion reasons from restated saved decisions", () => {
    assert.deepEqual(
      suggestionReasons(rec("a", { reasons: ["You marked this photo as a keeper.", "Strong detail and exposure in the preview."] })),
      ["Strong detail and exposure in the preview."],
    );
  });
});


describe("resolution decision signatures", () => {
  const stack: ReviewStack = {
    key: "a|b", kind: "burst", photoIds: ["a", "b"], suggestedId: "a",
    closeCall: false, similarity: 0.9, startTime: null,
  };
  const choices = new Map([
    ["a", { flag: "pick", rating: 4 }],
    ["b", { flag: "reject", rating: 0 }],
  ] satisfies [string, PhotoDecision][]);
  const decisionOf = (id: string) => normalizeDecision(choices.get(id));

  it("invalidates changed flags and ratings and recognizes restored decisions", () => {
    const resolution = { resolved_at: "t", trained: true, decision_signature: decisionSignature(stack, decisionOf) };
    assert.equal(resolutionIsCurrent(stack, decisionOf, resolution), true);
    const changedFlag = (id: string) => id === "a" ? { flag: "reject" as const, rating: 4 } : decisionOf(id);
    const changedRating = (id: string) => id === "a" ? { flag: "pick" as const, rating: 5 } : decisionOf(id);
    assert.equal(resolutionIsCurrent(stack, changedFlag, resolution), false);
    assert.equal(resolutionIsCurrent(stack, changedRating, resolution), false);
    assert.equal(resolutionIsCurrent(stack, decisionOf, resolution), true);
    assert.equal(resolutionIsCurrent({ ...stack, photoIds: ["b", "a"] }, decisionOf, resolution), true);
    assert.equal(resolutionIsCurrent({ ...stack, photoIds: ["a"] }, decisionOf, resolution), false);
  });

  it("reopens legacy resolutions while retaining historical training", () => {
    const legacy = parseResolutions(null, JSON.stringify([stack.key]))[stack.key];
    assert.equal(legacy.trained, true);
    assert.equal(resolutionIsCurrent(stack, decisionOf, legacy), false);
    assert.equal(stackStatus(stack, decisionOf, resolutionIsCurrent(stack, decisionOf, legacy)), "partial");
    assert.equal(resolutionIsCurrent(stack, decisionOf, undefined), false);
    const malformed = parseResolutions(JSON.stringify({ [stack.key]: { resolved_at: "t", trained: true, decision_signature: 5 } }))[stack.key];
    assert.equal(malformed.decision_signature, undefined);
    assert.equal(resolutionIsCurrent(stack, decisionOf, malformed), false);
  });

  it("preserves a current signature through storage and reopening the folder", () => {
    const storage = memoryStorage();
    const resolution = { resolved_at: "t", trained: false, decision_signature: decisionSignature(stack, decisionOf) };
    saveResolutions(storage, "/photos", "default", { [stack.key]: resolution });
    const restored = loadResolutions(storage, "/photos", "default")[stack.key];
    assert.deepEqual(restored, resolution);
    assert.equal(resolutionIsCurrent(stack, decisionOf, restored), true);
  });
});
