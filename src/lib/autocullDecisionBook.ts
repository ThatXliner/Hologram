import {
  loadPairwisePreferences,
  loadPreferenceFeatureSnapshots,
  loadPreferenceRefinements,
  pointwiseSignal,
  PREFERENCE_FEATURE_VERSION,
  type AutoCullPreferenceRefinement,
  type PreferenceFeatureSnapshot,
} from "./autocull.ts";
import type { AutoCullPairwisePreference, CullFlag, Photo } from "./types.ts";

const MAX_FLOAT32 = 3.4028234663852886e38;
const BACKENDS = new Set(["perceptual-dct-focus-v4", "dinov2-small-transformersjs+perceptual-dct-focus-v4"]);

export interface DecisionBookDataset {
  schema_version: 1;
  kind: "human";
  feature_version: string;
  backend: string;
  profile_id: string;
  shoots: string[];
  photos: { id: string; shootId: string; features: number[] }[];
  pointwise: { photoId: string; signal: number; confidence: number; provenance: "manual" }[];
  pairs: { winnerId: string; loserId: string; confidence: number; provenance: "manual" }[];
}

export interface DecisionBook {
  schema_version: 1;
  kind: "hologram-decision-book";
  created_at: string;
  grouping: "source-folder-unverified";
  summary: {
    manual_decisions: number;
    comparisons: number;
    photos: number;
    shoots: number;
    datasets: number;
    omitted_decisions: number;
    omitted_comparisons: number;
    unavailable_features: number;
    missing_shoot: number;
  };
  photos: { id: string; shootId: string; backend: string; feature_version: string; features: number[]; embedding: number[] }[];
  reviews: { photoId: string; flag: CullFlag; rating: number; confidence: number; updated_at: string }[];
  datasets: DecisionBookDataset[];
}

type BookInput = {
  refinements: AutoCullPreferenceRefinement[];
  pairs: AutoCullPairwisePreference[];
  snapshots: ReadonlyMap<string, PreferenceFeatureSnapshot>;
  createdAt?: string;
};

export function buildDecisionBook({ refinements, pairs, snapshots, createdAt = new Date().toISOString() }: BookInput): DecisionBook {
  const decisions = new Map(refinements.filter((row) => row.source === "manual_decision").map((row) => [row.photo_id, row]));
  const comparisons = new Map<string, AutoCullPairwisePreference>();
  for (const pair of pairs) {
    if (pair.source !== "manual" && pair.source !== "cluster_winner") continue;
    comparisons.set(JSON.stringify([pair.winner_photo_id, pair.loser_photo_id].sort()), pair);
  }
  const referenced = new Set(decisions.keys());
  for (const pair of comparisons.values()) {
    referenced.add(pair.winner_photo_id);
    referenced.add(pair.loser_photo_id);
  }
  const summary: DecisionBook["summary"] = {
    manual_decisions: 0, comparisons: 0, photos: 0, shoots: 0, datasets: 0,
    omitted_decisions: 0, omitted_comparisons: 0, unavailable_features: 0, missing_shoot: 0,
  };
  const usable = new Map<string, PreferenceFeatureSnapshot>();
  for (const id of [...referenced].sort()) {
    const snapshot = snapshots.get(id);
    if (!snapshot) { summary.unavailable_features++; continue; }
    if (snapshot.version !== PREFERENCE_FEATURE_VERSION || !BACKENDS.has(snapshot.backend)
      || snapshot.rankerFeatures.length !== 267 || !snapshot.rankerFeatures.every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_FLOAT32)
      || !snapshot.embedding.length || !snapshot.embedding.every(Number.isFinite) || !snapshot.embedding.some((value) => value !== 0)) {
      summary.unavailable_features++;
      continue;
    }
    if (typeof snapshot.sourceGroup !== "string" || !/^folder-sha256:[a-f0-9]{64}$/.test(snapshot.sourceGroup)) {
      summary.missing_shoot++;
      continue;
    }
    usable.set(id, snapshot);
  }
  const acceptedPairs = [...comparisons.values()].filter((pair) => {
    const winner = usable.get(pair.winner_photo_id), loser = usable.get(pair.loser_photo_id);
    return pair.winner_photo_id !== pair.loser_photo_id && winner && loser && winner.backend === loser.backend;
  });
  const acceptedIds = new Set([...decisions.keys()].filter((id) => usable.has(id)));
  for (const pair of acceptedPairs) {
    acceptedIds.add(pair.winner_photo_id);
    acceptedIds.add(pair.loser_photo_id);
  }
  const photoAliases = new Map([...acceptedIds].sort().map((id, index) => [id, `photo-${index + 1}`]));
  const shootAliases = new Map<string, string>();
  const photos: DecisionBook["photos"] = [];
  const partitions = new Map<string, DecisionBookDataset>();
  for (const [id, alias] of photoAliases) {
    const snapshot = usable.get(id);
    if (!snapshot || !snapshot.sourceGroup) continue;
    const shootId = shootAliases.get(snapshot.sourceGroup) ?? `shoot-${shootAliases.size + 1}`;
    shootAliases.set(snapshot.sourceGroup, shootId);
    photos.push({ id: alias, shootId, backend: snapshot.backend, feature_version: snapshot.version,
      features: [...snapshot.rankerFeatures], embedding: [...snapshot.embedding] });
    let dataset = partitions.get(snapshot.backend);
    if (!dataset) {
      dataset = { schema_version: 1, kind: "human", feature_version: PREFERENCE_FEATURE_VERSION, backend: snapshot.backend,
        profile_id: "profile-1", shoots: [], photos: [], pointwise: [], pairs: [] };
      partitions.set(snapshot.backend, dataset);
    }
    if (!dataset.shoots.includes(shootId)) dataset.shoots.push(shootId);
    dataset.photos.push({ id: alias, shootId, features: [...snapshot.rankerFeatures] });
  }
  const reviews: DecisionBook["reviews"] = [];
  for (const [id, row] of decisions) {
    const alias = photoAliases.get(id), snapshot = usable.get(id);
    const dataset = snapshot ? partitions.get(snapshot.backend) : undefined;
    if (!alias || !dataset) continue;
    const confidence = Math.min(1.25, Math.max(0.1, row.confidence));
    const rating = Math.min(5, Math.max(0, Math.round(row.rating)));
    reviews.push({ photoId: alias, flag: row.flag, rating, confidence, updated_at: row.updated_at });
    if (row.flag === "none" && rating <= 0) continue;
    dataset.pointwise.push({ photoId: alias, signal: pointwiseSignal(row.flag, rating), confidence, provenance: "manual" });
  }
  for (const pair of acceptedPairs) {
    const winnerId = photoAliases.get(pair.winner_photo_id), loserId = photoAliases.get(pair.loser_photo_id);
    const snapshot = usable.get(pair.winner_photo_id);
    const dataset = snapshot ? partitions.get(snapshot.backend) : undefined;
    if (!winnerId || !loserId || !dataset) continue;
    dataset.pairs.push({ winnerId, loserId, confidence: Math.min(1.25, Math.max(0.1, pair.confidence)), provenance: "manual" });
  }
  const datasets = [...partitions.values()].sort((left, right) => left.backend.localeCompare(right.backend));
  summary.manual_decisions = reviews.length;
  summary.comparisons = acceptedPairs.length;
  summary.photos = photos.length;
  summary.shoots = shootAliases.size;
  summary.datasets = datasets.length;
  summary.omitted_decisions = decisions.size - reviews.length;
  summary.omitted_comparisons = comparisons.size - acceptedPairs.length;
  return { schema_version: 1, kind: "hologram-decision-book", created_at: createdAt, grouping: "source-folder-unverified",
    summary, photos, reviews, datasets };
}

export async function createDecisionBook(profileId: string, photos: Photo[] = []): Promise<DecisionBook> {
  const refinements = loadPreferenceRefinements(profileId);
  const pairs = loadPairwisePreferences(profileId);
  const ids = new Set(refinements.map((row) => row.photo_id));
  for (const pair of pairs) { ids.add(pair.winner_photo_id); ids.add(pair.loser_photo_id); }
  const snapshots = await loadPreferenceFeatureSnapshots([...ids], photos);
  return buildDecisionBook({ refinements, pairs, snapshots });
}
