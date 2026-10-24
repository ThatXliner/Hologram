import { cosineSimilarity } from "./autocull.ts";
import {
  buildReviewQueue, isDecided, normalizeDecision, pairedIds, planDecision, sameDecision,
  type DecisionChange, type PhotoDecision, type ReviewStack, type StorageLike,
} from "./autocullReview.ts";
import type { AutoCullPhoto, AutoCullSession, Photo } from "./types.ts";

export type AutomaticDecisions = Record<string, PhotoDecision>;

function storageKey(folderPath: string | null): string {
  return `hologram.autocull.automatic.v1.${folderPath?.trim() || "global"}`;
}

export function loadAutomaticDecisions(storage: StorageLike | null, folderPath: string | null): AutomaticDecisions {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(storageKey(folderPath)) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const entries: [string, PhotoDecision][] = [];
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || !("flag" in value) || !("rating" in value)) continue;
      if (value.flag !== "pick" && value.flag !== "reject") continue;
      if (typeof value.rating !== "number" || !Number.isInteger(value.rating) || value.rating < 0 || value.rating > 5) continue;
      entries.push([id, { flag: value.flag, rating: value.rating }]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveAutomaticDecisions(storage: StorageLike | null, folderPath: string | null, automatic: AutomaticDecisions): void {
  try {
    storage?.setItem(storageKey(folderPath), JSON.stringify(automatic));
  } catch {
    // Unavailable storage must not interrupt the current cull.
  }
}

export function automaticPhotoIds(photos: Photo[], automatic: AutomaticDecisions): Set<string> {
  return new Set(photos.filter((photo) => {
    const decision = Object.hasOwn(automatic, photo.id) ? automatic[photo.id] : undefined;
    return decision && sameDecision(normalizeDecision(photo), decision);
  }).map((photo) => photo.id));
}

function hasEvidence(photo: AutoCullPhoto | undefined): photo is AutoCullPhoto & { embedding: number[] } {
  return Boolean(photo && Number.isFinite(photo.technical_score) && Number.isFinite(photo.final_score)
    && photo.embedding?.length && photo.embedding.every(Number.isFinite) && photo.embedding.some((value) => value !== 0));
}

export function buildAutoCullPlan(photos: Photo[], allPhotos: Photo[], session: AutoCullSession): {
  changes: DecisionChange[];
  keepIds: string[];
  rejectIds: string[];
  reviewIds: string[];
  resolvedStackKeys: string[];
} {
  const byId = new Map(allPhotos.map((photo) => [photo.id, photo]));
  const analyzed = new Map(session.photos.map((photo) => [photo.photo_id, photo]));
  const decisions = new Map<string, PhotoDecision>();
  const protectedPhoto = (id: string) => pairedIds(id, byId).some((member) => isDecided(normalizeDecision(byId.get(member))));
  const decide = (id: string, flag: "pick" | "reject") => {
    if (protectedPhoto(id)) return;
    const members = pairedIds(id, byId);
    // A pair is one exposure: neither its second file nor a later stack may reject a keeper.
    if (flag === "reject" && members.some((member) => decisions.get(member)?.flag === "pick")) return;
    for (const member of members) if (byId.has(member)) decisions.set(member, { flag, rating: 0 });
  };
  const decideStack = (stack: ReviewStack) => {
    if (stack.photoIds.length === 1) {
      const id = stack.photoIds[0];
      const rec = analyzed.get(id);
      if (!hasEvidence(rec)) return;
      if (rec.technical_score >= 0.7) decide(id, "pick");
      else if (rec.technical_score <= 0.25) decide(id, "reject");
      return;
    }
    const candidates = stack.photoIds.map((id) => analyzed.get(id)).filter(hasEvidence)
      .filter((rec) => !pairedIds(rec.photo_id, byId).some((id) => normalizeDecision(byId.get(id)).flag === "reject"))
      .sort((left, right) => right.final_score - left.final_score || left.photo_id.localeCompare(right.photo_id));
    const winner = candidates[0];
    const winnerPair = new Set(winner ? pairedIds(winner.photo_id, byId) : []);
    const runnerUp = candidates.find((rec) => !winnerPair.has(rec.photo_id));
    const nearDuplicates = winner && candidates.length === stack.photoIds.length
      && candidates.every((rec) => cosineSimilarity(winner.embedding, rec.embedding) >= 0.995);
    const clearWinner = winner && (!runnerUp || winner.final_score - runnerUp.final_score >= 0.04);
    if (winner && winner.technical_score >= 0.55 && (clearWinner || nearDuplicates)) {
      decide(winner.photo_id, "pick");
      for (const rec of candidates) {
        if (!winnerPair.has(rec.photo_id) && cosineSimilarity(winner.embedding, rec.embedding) >= 0.9) decide(rec.photo_id, "reject");
      }
    }
    for (const id of stack.photoIds) {
      const rec = analyzed.get(id);
      if (hasEvidence(rec) && rec.technical_score <= 0.25) decide(id, "reject");
    }
  };
  const stacks = buildReviewQueue(photos, session);
  stacks.forEach(decideStack);
  const keepIds = photos.filter((photo) => decisions.get(photo.id)?.flag === "pick").map((photo) => photo.id);
  const rejectIds = photos.filter((photo) => decisions.get(photo.id)?.flag === "reject").map((photo) => photo.id);
  const reviewIds = photos.filter((photo) => !protectedPhoto(photo.id) && !decisions.has(photo.id)).map((photo) => photo.id);
  const changes = new Map<string, DecisionChange>();
  for (const [id, decision] of decisions) {
    for (const change of planDecision([id], byId, decision)) changes.set(change.id, change);
  }
  return {
    changes: [...changes.values()], keepIds, rejectIds, reviewIds,
    resolvedStackKeys: stacks.filter((stack) => stack.photoIds.every((id) => protectedPhoto(id) || decisions.has(id))).map((stack) => stack.key),
  };
}
