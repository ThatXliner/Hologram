import type { AutoCullPreferenceRefinement } from "./autocull.ts";
import type {
  AutoCullCluster,
  AutoCullPairwisePreference,
  AutoCullPhoto,
  AutoCullSession,
  CullFlag,
  Photo,
} from "./types.ts";

export type ReviewFilter = "all" | "todo" | "issues";
export type StackStatus = "todo" | "partial" | "done";
export type StackIssue = "preview-missing" | "low-quality" | "close-call";

export const CLOSE_CALL_MARGIN = 0.04;
// Matches the "Low detail or exposure score" reason produced by the ranker.
export const LOW_TECHNICAL_SCORE = 0.42;
export const HISTORY_LIMIT = 100;

export interface ReviewStack {
  /** Order-independent signature of the member ids; survives re-analysis. */
  key: string;
  kind: AutoCullCluster["kind"];
  /** Members in capture order. */
  photoIds: string[];
  /** The analysis's preferred frame, only for multi-frame stacks with an analyzed preview. */
  suggestedId: string | null;
  closeCall: boolean;
  similarity: number | null;
  startTime: string | null;
}

export interface PhotoDecision {
  flag: CullFlag;
  rating: number;
}

export interface DecisionChange {
  id: string;
  before: PhotoDecision;
  after: PhotoDecision;
}

export interface StackResolution {
  resolved_at: string;
  trained: boolean;
  decision_signature?: string;
}

export type ResolutionMap = Record<string, StackResolution>;

export interface ReviewProgress {
  stacks: number;
  done: number;
  partial: number;
  photos: number;
  decidedPhotos: number;
  kept: number;
  rejected: number;
  complete: boolean;
}

export interface ReviewSnapshot {
  label: string;
  folderPath: string | null;
  profileId: string;
  decisions: DecisionChange[];
  automatic: Record<string, PhotoDecision | null>;
  /** Refinement entries as they were before the action, keyed by photo id (null = absent). */
  refinements: Record<string, AutoCullPreferenceRefinement | null>;
  pairwise: {
    added: AutoCullPairwisePreference[];
    replaced: AutoCullPairwisePreference[];
    removed: AutoCullPairwisePreference[];
  };
  /** Resolution entries before the action, keyed by stack key (null = absent). */
  resolutions: Record<string, StackResolution | null>;
  selection: { photoId: string | null };
}

export type DecisionLookup = (id: string) => PhotoDecision;

export function normalizeDecision(photo: Pick<Photo, "flag" | "rating"> | null | undefined): PhotoDecision {
  const flag = photo?.flag === "pick" || photo?.flag === "reject" ? photo.flag : "none";
  const rating = Math.max(0, Math.min(5, Math.round(photo?.rating ?? 0)));
  return { flag, rating };
}

export function isDecided(decision: PhotoDecision): boolean {
  return decision.flag !== "none" || decision.rating > 0;
}

export function sameDecision(left: PhotoDecision, right: PhotoDecision): boolean {
  return left.flag === right.flag && left.rating === right.rating;
}

export function pairedIds(id: string, byId: Map<string, Photo>): string[] {
  const partner = byId.get(id)?.paired_with;
  return partner && partner !== id ? [id, partner] : [id];
}

export function planDecision(
  ids: string[],
  byId: Map<string, Photo>,
  patch: Partial<PhotoDecision>,
): DecisionChange[] {
  const changes: DecisionChange[] = [];
  const seen = new Set<string>();
  for (const id of ids.flatMap((item) => pairedIds(item, byId))) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const before = normalizeDecision(byId.get(id));
    const after = normalizeDecision({ flag: patch.flag ?? before.flag, rating: patch.rating ?? before.rating });
    if (!sameDecision(before, after)) changes.push({ id, before, after });
  }
  return changes;
}

export function planKeepSuggested(stack: ReviewStack, byId: Map<string, Photo>): DecisionChange[] {
  if (!canKeepSuggested(stack, byId)) return [];
  return planDecision([stack.suggestedId!], byId, { flag: "pick" });
}

export function canKeepSuggested(stack: ReviewStack, byId: Map<string, Photo>): boolean {
  if (!stack.suggestedId) return false;
  // A manual reject wins over the suggestion; the photographer must clear it first.
  return byId.has(stack.suggestedId)
    && normalizeDecision(byId.get(stack.suggestedId)).flag === "none"
    && pairedIds(stack.suggestedId, byId).every((id) => normalizeDecision(byId.get(id)).flag !== "reject");
}

export function undecidedOthers(stack: ReviewStack, selectedId: string, byId: Map<string, Photo>): string[] {
  const selectedPair = new Set(pairedIds(selectedId, byId));
  return stack.photoIds.filter((id) => (
    !selectedPair.has(id)
    && pairedIds(id, byId).every((member) => !isDecided(normalizeDecision(byId.get(member))))
  ));
}

/**
 * Keep the selected frame and reject only frames with no saved decision. Existing
 * picks, ratings and rejects are left alone, and the kept frame keeps its stars.
 */
export function planKeepSelectedRejectRest(
  stack: ReviewStack,
  selectedId: string,
  byId: Map<string, Photo>,
): DecisionChange[] {
  if (!stack.photoIds.includes(selectedId)) return [];
  const keep = planDecision([selectedId], byId, { flag: "pick" });
  const reject = planDecision(undecidedOthers(stack, selectedId, byId), byId, { flag: "reject" });
  return [...keep, ...reject];
}

export function applyChanges(byId: Map<string, Photo>, changes: DecisionChange[], direction: "after" | "before"): Map<string, Photo> {
  const next = new Map(byId);
  for (const change of changes) {
    const photo = next.get(change.id);
    if (photo) next.set(change.id, { ...photo, ...change[direction] });
  }
  return next;
}

export function stackKey(photoIds: string[]): string {
  return [...photoIds].sort().join("|");
}

export function captureTimeMs(photo: Photo): number | null {
  const value = photo.exif?.date_taken;
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function compareCaptureOrder(left: Photo, right: Photo): number {
  const leftTime = captureTimeMs(left) ?? Number.MAX_SAFE_INTEGER;
  const rightTime = captureTimeMs(right) ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.file_name.localeCompare(right.file_name, undefined, { numeric: true })
    || left.id.localeCompare(right.id);
}

/**
 * Every visible photo appears in exactly one stack: analysis clusters become
 * multi-frame stacks and everything else is a single. Stacks are ordered by their
 * earliest frame, so the queue stays in capture order regardless of scores.
 */
export function buildReviewQueue(photos: Photo[], session: AutoCullSession | null): ReviewStack[] {
  const ordered = [...photos].sort(compareCaptureOrder);
  const position = new Map(ordered.map((photo, index) => [photo.id, index]));
  const recommendations = new Map((session?.photos ?? []).map((item) => [item.photo_id, item]));
  const claimed = new Set<string>();
  const stacks: { first: number; stack: ReviewStack }[] = [];

  for (const cluster of session?.clusters ?? []) {
    const ids = cluster.photo_ids
      .filter((id) => position.has(id) && !claimed.has(id))
      .sort((a, b) => position.get(a)! - position.get(b)!);
    if (ids.length === 0) continue;
    for (const id of ids) claimed.add(id);
    const multi = ids.length > 1;
    const suggestion = recommendations.get(cluster.top_pick_id);
    const suggestedId = multi
      && ids.includes(cluster.top_pick_id)
      && suggestion?.embedding
      && suggestion.recommendation !== "REJECT"
      ? cluster.top_pick_id
      : null;
    stacks.push({
      first: position.get(ids[0])!,
      stack: {
        key: stackKey(ids),
        kind: multi ? cluster.kind : "single",
        photoIds: ids,
        suggestedId,
        closeCall: Boolean(suggestedId) && cluster.pick_margin < CLOSE_CALL_MARGIN,
        similarity: multi ? cluster.confidence : null,
        startTime: cluster.start_time ?? null,
      },
    });
  }

  for (const photo of ordered) {
    if (claimed.has(photo.id)) continue;
    const time = captureTimeMs(photo);
    stacks.push({
      first: position.get(photo.id)!,
      stack: {
        key: stackKey([photo.id]),
        kind: "single",
        photoIds: [photo.id],
        suggestedId: null,
        closeCall: false,
        similarity: null,
        startTime: time == null ? null : new Date(time).toISOString(),
      },
    });
  }

  return stacks.sort((a, b) => a.first - b.first).map((item) => item.stack);
}

export function decisionSignature(stack: ReviewStack, decisionOf: DecisionLookup): string {
  return JSON.stringify([...stack.photoIds].sort().map((id) => {
    const decision = decisionOf(id);
    return [id, decision.flag, decision.rating];
  }));
}

export function resolutionIsCurrent(
  stack: ReviewStack,
  decisionOf: DecisionLookup,
  resolution: StackResolution | null | undefined,
): boolean {
  return typeof resolution?.decision_signature === "string"
    && resolution.decision_signature === decisionSignature(stack, decisionOf);
}

export function stackStatus(stack: ReviewStack, decisionOf: DecisionLookup, resolved: boolean): StackStatus {
  const decided = stack.photoIds.filter((id) => isDecided(decisionOf(id))).length;
  if (stack.photoIds.length === 1 && decided === 1) return "done";
  // A resolution only counts while a choice backs it; clearing every decision reopens the stack.
  if (decided > 0) return resolved ? "done" : "partial";
  return "todo";
}

export function stackIssues(stack: ReviewStack, recommendations: Map<string, AutoCullPhoto>): StackIssue[] {
  if (recommendations.size === 0) return [];
  const issues: StackIssue[] = [];
  const recs = stack.photoIds.map((id) => recommendations.get(id));
  if (recs.some((rec) => !rec?.embedding)) issues.push("preview-missing");
  if (recs.some((rec) => rec?.embedding && rec.technical_score < LOW_TECHNICAL_SCORE)) issues.push("low-quality");
  if (stack.closeCall) issues.push("close-call");
  return issues;
}

export function summarizeProgress(
  stacks: ReviewStack[],
  statusOf: (stack: ReviewStack) => StackStatus,
  decisionOf: DecisionLookup,
): ReviewProgress {
  let done = 0;
  let partial = 0;
  let photos = 0;
  let decidedPhotos = 0;
  let kept = 0;
  let rejected = 0;
  for (const stack of stacks) {
    const status = statusOf(stack);
    if (status === "done") done++;
    else if (status === "partial") partial++;
    for (const id of stack.photoIds) {
      const decision = decisionOf(id);
      photos++;
      if (isDecided(decision)) decidedPhotos++;
      if (decision.flag === "pick") kept++;
      if (decision.flag === "reject") rejected++;
    }
  }
  return {
    stacks: stacks.length,
    done,
    partial,
    photos,
    decidedPhotos,
    kept,
    rejected,
    complete: stacks.length > 0 && done === stacks.length,
  };
}

/**
 * Filtered view of the queue. The pinned stack (the one under review) stays visible
 * even after it stops matching, so finishing a frame never yanks it away.
 */
export function filterQueue(
  stacks: ReviewStack[],
  filter: ReviewFilter,
  statusOf: (stack: ReviewStack) => StackStatus,
  issuesOf: (stack: ReviewStack) => StackIssue[],
  pinnedKey: string | null = null,
): ReviewStack[] {
  if (filter === "all") return stacks;
  return stacks.filter((stack) => (
    stack.key === pinnedKey
    || (filter === "todo" ? statusOf(stack) !== "done" : issuesOf(stack).length > 0)
  ));
}

/** Next/previous stack in a (filtered) list, falling back to queue order if the current one is hidden. */
export function adjacentStackKey(
  all: ReviewStack[],
  visible: ReviewStack[],
  currentKey: string | null,
  delta: 1 | -1,
): string | null {
  if (visible.length === 0) return null;
  const visibleIndex = visible.findIndex((stack) => stack.key === currentKey);
  if (visibleIndex >= 0) return visible[visibleIndex + delta]?.key ?? null;
  const visibleKeys = new Set(visible.map((stack) => stack.key));
  const start = all.findIndex((stack) => stack.key === currentKey);
  if (start < 0) return delta > 0 ? visible[0].key : visible[visible.length - 1].key;
  for (let index = start + delta; index >= 0 && index < all.length; index += delta) {
    if (visibleKeys.has(all[index].key)) return all[index].key;
  }
  return null;
}

/** The next stack still needing review after the current one, wrapping once; null when finished. */
export function nextPendingKey(
  stacks: ReviewStack[],
  currentKey: string | null,
  statusOf: (stack: ReviewStack) => StackStatus,
): string | null {
  const start = stacks.findIndex((stack) => stack.key === currentKey);
  for (let offset = 1; offset <= stacks.length; offset++) {
    const stack = stacks[(Math.max(start, -1) + offset + stacks.length) % stacks.length];
    if (stack.key !== currentKey && statusOf(stack) !== "done") return stack.key;
  }
  return null;
}

export function landingPhotoId(stack: ReviewStack): string {
  return stack.suggestedId ?? stack.photoIds[0];
}

export type FinishCheck = { ok: true } | { ok: false; reason: string };

export function canFinishStack(stack: ReviewStack, decisionOf: DecisionLookup): FinishCheck {
  if (stack.photoIds.some((id) => isDecided(decisionOf(id)))) return { ok: true };
  return {
    ok: false,
    reason: stack.photoIds.length > 1
      ? "Keep, reject or rate a frame before finishing this stack."
      : "Keep, reject or rate this photo before finishing.",
  };
}

export function trainingPreferences(
  stack: ReviewStack,
  decisionOf: DecisionLookup,
  createdAt: string,
): AutoCullPairwisePreference[] {
  const winners = stack.photoIds.filter((id) => decisionOf(id).flag === "pick");
  const losers = stack.photoIds.filter((id) => decisionOf(id).flag !== "pick");
  return winners.flatMap((winner) => losers.map((loser) => ({
    winner_photo_id: winner,
    loser_photo_id: loser,
    confidence: 1,
    source: "cluster_winner" as const,
    created_at: createdAt,
  })));
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

function preferenceScope(folderPath: string | null): string {
  return folderPath?.trim() || "global";
}

export function resolutionStorageKey(folderPath: string | null, profileId: string): string {
  return `hologram.autocull.review.v1.${preferenceScope(folderPath)}.${encodeURIComponent(profileId)}`;
}

/** Earlier builds stored "confirmed" cluster signatures per folder (default profile only). */
export function legacyConfirmedStorageKey(folderPath: string | null): string {
  return `hologram.autocull.confirmed:${folderPath ?? "none"}`;
}

export function parseResolutions(raw: string | null, legacyRaw: string | null = null): ResolutionMap {
  const result: ResolutionMap = {};
  try {
    const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
    if (Array.isArray(legacy)) {
      for (const key of legacy) {
        if (typeof key === "string") result[key] = { resolved_at: "1970-01-01T00:00:00.000Z", trained: true };
      }
    }
  } catch {
    /* ignore malformed legacy data */
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const item = value as Partial<StackResolution> | null;
        if (item && typeof item.resolved_at === "string") {
          result[key] = {
            resolved_at: item.resolved_at,
            trained: Boolean(item.trained),
            ...(typeof item.decision_signature === "string" ? { decision_signature: item.decision_signature } : {}),
          };
        }
      }
    }
  } catch {
    /* ignore malformed data */
  }
  return result;
}

export function loadResolutions(
  storage: StorageLike | null,
  folderPath: string | null,
  profileId: string,
  defaultProfileId = "default",
): ResolutionMap {
  if (!storage) return {};
  try {
    const current = storage.getItem(resolutionStorageKey(folderPath, profileId));
    const legacy = current === null && profileId === defaultProfileId
      ? storage.getItem(legacyConfirmedStorageKey(folderPath))
      : null;
    return parseResolutions(current, legacy);
  } catch {
    return {};
  }
}

export function saveResolutions(
  storage: StorageLike | null,
  folderPath: string | null,
  profileId: string,
  resolutions: ResolutionMap,
) {
  try {
    storage?.setItem(resolutionStorageKey(folderPath, profileId), JSON.stringify(resolutions));
  } catch {
    /* storage unavailable: keep the in-memory map */
  }
}

export function withResolutions(current: ResolutionMap, patch: Record<string, StackResolution | null>): ResolutionMap {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}

export function pushHistory<T>(history: T[], entry: T, limit = HISTORY_LIMIT): T[] {
  return [...history, entry].slice(-limit);
}

export function pairwiseKey(preference: Pick<AutoCullPairwisePreference, "winner_photo_id" | "loser_photo_id">): string {
  return JSON.stringify([preference.winner_photo_id, preference.loser_photo_id].sort());
}

/** Existing comparisons that a new batch would overwrite (one per unordered pair). */
export function replacedPairwise(
  current: AutoCullPairwisePreference[],
  added: AutoCullPairwisePreference[],
): AutoCullPairwisePreference[] {
  const keys = new Set(added.map(pairwiseKey));
  const latest = new Map<string, AutoCullPairwisePreference>();
  for (const preference of current) {
    const key = pairwiseKey(preference);
    if (keys.has(key)) latest.set(key, preference);
  }
  return [...latest.values()];
}

export function stackPairwise(
  preferences: AutoCullPairwisePreference[],
  photoIds: string[],
): AutoCullPairwisePreference[] {
  const members = new Set(photoIds);
  return preferences.filter((preference) => preference.source === "cluster_winner"
    && members.has(preference.winner_photo_id)
    && members.has(preference.loser_photo_id));
}

export function revertPairwise(
  current: AutoCullPairwisePreference[],
  added: AutoCullPairwisePreference[],
  replaced: AutoCullPairwisePreference[],
): AutoCullPairwisePreference[] {
  const addedKeys = new Set(added.map(pairwiseKey));
  return [...current.filter((preference) => !addedKeys.has(pairwiseKey(preference))), ...replaced];
}

export function snapshotRefinements(
  current: AutoCullPreferenceRefinement[],
  ids: string[],
): Record<string, AutoCullPreferenceRefinement | null> {
  const byId = new Map(current.map((item) => [item.photo_id, item]));
  return Object.fromEntries(ids.map((id) => [id, byId.get(id) ?? null]));
}

export function restoreRefinements(
  current: AutoCullPreferenceRefinement[],
  before: Record<string, AutoCullPreferenceRefinement | null>,
): AutoCullPreferenceRefinement[] {
  const restored = current.filter((item) => !(item.photo_id in before));
  for (const item of Object.values(before)) if (item) restored.push(item);
  return restored.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

const USER_DECISION_REASON = /^(You marked this photo|Your star rating)/;

/**
 * Reasons from the analysis, minus the ones that only restate a saved decision.
 * Saved decisions are shown live from the photo, never from a possibly stale analysis.
 */
export function suggestionReasons(rec: AutoCullPhoto | null | undefined): string[] {
  return (rec?.reasons ?? []).filter((reason) => !USER_DECISION_REASON.test(reason));
}
