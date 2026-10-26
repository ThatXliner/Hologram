import { cosineSimilarity, type AutoCullPreferenceRefinement } from "./autocull.ts";
import {
  buildReviewQueue, isDecided, normalizeDecision, pairedIds, planDecision, sameDecision,
  type DecisionChange, type PhotoDecision, type ReviewStack, type StorageLike,
} from "./autocullReview.ts";
import type { AutoCullPairwisePreference, AutoCullPhoto, AutoCullSession, Photo } from "./types.ts";

type AutomaticDecision = PhotoDecision & { alternatives?: PhotoDecision[] };
export type AutomaticDecisions = Record<string, AutomaticDecision>;
type AutomaticStorage = StorageLike & Partial<Pick<Storage, "length" | "key">>;
const AUTOMATIC_KEY = "hologram.autocull.automatic.v2";
const LEGACY_PREFIX = "hologram.autocull.automatic.v1.";

function parseDecision(value: unknown): PhotoDecision | undefined {
  if (!value || typeof value !== "object" || !("flag" in value) || !("rating" in value)) return;
  if (value.flag !== "pick" && value.flag !== "reject") return;
  if (typeof value.rating !== "number" || !Number.isInteger(value.rating) || value.rating < 0 || value.rating > 5) return;
  return { flag: value.flag, rating: value.rating };
}

function parseAutomatic(raw: string | null): AutomaticDecisions {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries: [string, AutomaticDecision][] = [];
    for (const [id, item] of Object.entries(value)) {
      const decision = parseDecision(item);
      if (!decision) continue;
      const alternatives = item && typeof item === "object" && "alternatives" in item && Array.isArray(item.alternatives)
        ? item.alternatives.flatMap((candidate: unknown) => { const parsed = parseDecision(candidate); return parsed ? [parsed] : []; }) : [];
      entries.push([id, alternatives.length ? { ...decision, alternatives } : decision]);
    }
    return Object.fromEntries(entries);
  } catch { return {}; }
}

export function loadAutomaticDecisions(storage: AutomaticStorage | null, folderPath: string | null): AutomaticDecisions {
  try {
    const current = storage?.getItem(AUTOMATIC_KEY) ?? null;
    if (current !== null) return parseAutomatic(current);
    const keys = new Set([`${LEGACY_PREFIX}${folderPath?.trim() || "global"}`]);
    if (storage && typeof storage.length === "number" && typeof storage.key === "function") {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(LEGACY_PREFIX)) keys.add(key);
      }
    }
    const automatic = new Map<string, AutomaticDecision>();
    for (const key of keys) {
      for (const [id, decision] of Object.entries(parseAutomatic(storage?.getItem(key) ?? null))) {
        const previous = automatic.get(id);
        if (!previous) { automatic.set(id, decision); continue; }
        const choices = [previous, ...(previous.alternatives ?? [])];
        if (!choices.some((item) => sameDecision(item, decision))) {
          automatic.set(id, { ...previous, alternatives: [...(previous.alternatives ?? []), decision] });
        }
      }
    }
    const result = Object.fromEntries(automatic);
    saveAutomaticDecisions(storage, folderPath, result);
    return result;
  } catch { return {}; }
}

export function saveAutomaticDecisions(storage: StorageLike | null, _folderPath: string | null, automatic: AutomaticDecisions): void {
  try { storage?.setItem(AUTOMATIC_KEY, JSON.stringify(automatic)); } catch {}
}

export function automaticPhotoIds(photos: Pick<Photo, "id" | "flag" | "rating">[], automatic: AutomaticDecisions): Set<string> {
  return new Set(photos.filter((photo) => {
    const decision = Object.hasOwn(automatic, photo.id) ? automatic[photo.id] : undefined;
    return decision && [decision, ...(decision.alternatives ?? [])].some((candidate) => sameDecision(normalizeDecision(photo), candidate));
  }).map((photo) => photo.id));
}

export function automaticFeedbackPhotoIds({ photos = [], refinements, pairs, automatic }: {
  photos?: Pick<Photo, "id" | "flag" | "rating">[];
  refinements: AutoCullPreferenceRefinement[];
  pairs: AutoCullPairwisePreference[];
  automatic: AutomaticDecisions;
}): Set<string> {
  const excluded = automaticPhotoIds([
    ...photos,
    ...refinements.map((row) => ({ id: row.photo_id, flag: row.flag, rating: row.rating })),
  ], automatic);
  for (const pair of pairs) {
    for (const id of [pair.winner_photo_id, pair.loser_photo_id]) if (Object.hasOwn(automatic, id)) excluded.add(id);
  }
  return excluded;
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
