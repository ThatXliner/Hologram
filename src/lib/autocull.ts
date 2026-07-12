import type {
  AutoCullCluster,
  AutoCullLabel,
  AutoCullPairwisePreference,
  AutoCullPhoto,
  AutoCullSession,
  CullFlag,
  Photo,
  VisualIndexProgress,
} from "./types.ts";
import { invoke } from "@tauri-apps/api/core";
import { photoPreviewSrc } from "./photoPreview.ts";
import { heavyMediaConcurrency } from "./concurrency.ts";

const DINO_MODEL_ID = "onnx-community/dinov2-small";
const TRANSFORMER_EMBEDDING_BACKEND = "dinov2-small-transformersjs";
const PERCEPTUAL_EMBEDDING_BACKEND = "perceptual-dct-focus-v3";
const EMBEDDING_BACKEND = `${TRANSFORMER_EMBEDDING_BACKEND}+${PERCEPTUAL_EMBEDDING_BACKEND}`;
const RANKER_VERSION = "gbdt-personal-ranker-v1";
const SPATIAL_GRID = 32;
const HISTOGRAM_BINS = 16;
const SAMPLE_SIZE = 160;
const TRANSFORMER_SAMPLE_SIZE = 224;
const DCT_SIZE = 32;
const DCT_COEFFICIENTS = 10;
const GRADIENT_CELLS = 4;
const GRADIENT_BINS = 8;
const TRANSFORMER_MODEL_TIMEOUT_MS = 12_000;
const TRANSFORMER_INFERENCE_TIMEOUT_MS = 8_000;
const EMBEDDING_RANKER_FEATURES = 256;
const BURST_WINDOW_MS = 3_000;
const LOOSE_BURST_WINDOW_MS = 8_000;
const BURST_VISUAL_SIMILARITY = 0.78;
const SEQUENCE_VISUAL_SIMILARITY = 0.84;
const MAX_BURST_SIZE = 18;
// Visual near-duplicate pass: groups look-alike frames that aren't temporally adjacent.
const SIMILAR_CLUSTER_SIMILARITY = 0.9;
const SIMILAR_PASS_MAX_PHOTOS = 2_500;
const GBDT_TREES = 48;
const GBDT_MAX_DEPTH = 3;
const GBDT_LEARNING_RATE = 0.08;
const GBDT_L2_REGULARIZATION = 1.2;
const GBDT_MIN_LEAF_WEIGHT = 0.08;
const GBDT_MIN_SPLIT_GAIN = 0.0008;
const FEATURE_CACHE_DB = "hologram-autocull-cache";
const FEATURE_CACHE_STORE = "pixel-features";
const FEATURE_CACHE_VERSION = [
  EMBEDDING_BACKEND,
  "sample",
  SAMPLE_SIZE,
  "transformer",
  TRANSFORMER_SAMPLE_SIZE,
  "spatial",
  SPATIAL_GRID,
  "dct",
  DCT_SIZE,
  DCT_COEFFICIENTS,
  "grad",
  GRADIENT_CELLS,
  GRADIENT_BINS,
].join(":");
const MEMORY_FEATURE_CACHE_LIMIT = 800;
const PERSISTENT_FEATURE_CACHE_LIMIT = 4_000;
export const DEFAULT_PREFERENCE_PROFILE_ID = "default";

type PixelFeatures = {
  embedding: number[];
  technicalScore: number;
  backend: string;
};

type CachedPixelFeaturesEntry = {
  key: string;
  version: string;
  cached_at: string;
  file_path: string;
  file_size: number;
  modified_at: string;
  features: PixelFeatures | null;
};

type SqlFeatureCacheEntry = Omit<CachedPixelFeaturesEntry, "cached_at">;

const pixelFeatureMemoryCache = new Map<string, PixelFeatures | null>();
let featureCacheDbPromise: Promise<IDBDatabase | null> | null = null;
let featureCachePrunePromise: Promise<void> | null = null;

export type AutoCullPreferenceProfile = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type AutoCullPreferenceRefinement = {
  photo_id: string;
  flag: CullFlag;
  rating: number;
  confidence: number;
  source: "manual_decision";
  updated_at: string;
  ranker_features?: number[];
  embedding?: number[];
};

type RankedExample = {
  vector: number[];
  features: number[];
  signal: number;
  confidence: number;
};

type PairwiseExample = {
  winnerFeatures: number[];
  loserFeatures: number[];
  confidence: number;
};

type FeatureRecord = {
  photo: Photo;
  embedding?: number[];
  technicalScore: number;
  rankerFeatures: number[];
};

type BoostingRow = {
  features: number[];
  target: number;
  weight: number;
};

type RegressionTree =
  | { value: number }
  | { feature: number; threshold: number; left: RegressionTree; right: RegressionTree };

type EmbeddingTensor = {
  data: ArrayLike<number | bigint>;
  dims: number[];
  dispose?: () => void;
};

type ImageFeatureExtractor = (
  image: HTMLCanvasElement | OffscreenCanvas | string,
  options?: { pool?: boolean },
) => Promise<EmbeddingTensor>;

type ScoredPhoto = AutoCullPhoto & {
  source: Photo;
  captureMs: number | null;
  sortTimeMs: number | null;
  sequence: SequenceInfo | null;
};

type SequenceInfo = {
  prefix: string;
  number: number;
};

type RankingModel = {
  score: (features: number[] | undefined) => number | null;
  examples: RankedExample[];
};

function preferenceScope(folderPath: string | null): string {
  return folderPath?.trim() || "global";
}

function defaultPreferenceProfile(): AutoCullPreferenceProfile {
  return {
    id: DEFAULT_PREFERENCE_PROFILE_ID,
    name: "Default",
    created_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function preferenceProfilesKey(folderPath: string | null): string {
  return `hologram.autocull.preferenceProfiles.${preferenceScope(folderPath)}`;
}

function activePreferenceProfileKey(folderPath: string | null): string {
  return `hologram.autocull.activePreferenceProfile.${preferenceScope(folderPath)}`;
}

function preferenceRefinementsKey(
  folderPath: string | null,
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
): string {
  return `hologram.autocull.preferenceRefinements.${preferenceScope(folderPath)}.${encodeURIComponent(profileId)}`;
}

export function pairwisePreferenceKey(
  folderPath: string | null,
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
): string {
  const base = `hologram.autocull.pairwise.${preferenceScope(folderPath)}`;
  return profileId === DEFAULT_PREFERENCE_PROFILE_ID
    ? base
    : `${base}.profile.${encodeURIComponent(profileId)}`;
}

export function loadPreferenceProfiles(folderPath: string | null): AutoCullPreferenceProfile[] {
  const fallback = [defaultPreferenceProfile()];
  if (typeof localStorage === "undefined") return fallback;

  try {
    const raw = localStorage.getItem(preferenceProfilesKey(folderPath));
    const parsed = raw ? JSON.parse(raw) : [];
    const profiles = Array.isArray(parsed)
      ? parsed.filter(isPreferenceProfile)
      : [];
    return normalizePreferenceProfiles(profiles);
  } catch {
    return fallback;
  }
}

export function savePreferenceProfiles(
  folderPath: string | null,
  profiles: AutoCullPreferenceProfile[],
) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(preferenceProfilesKey(folderPath), JSON.stringify(normalizePreferenceProfiles(profiles)));
}

export function loadActivePreferenceProfileId(folderPath: string | null): string {
  const profiles = loadPreferenceProfiles(folderPath);
  const fallback = profiles[0]?.id ?? DEFAULT_PREFERENCE_PROFILE_ID;
  if (typeof localStorage === "undefined") return fallback;

  const saved = localStorage.getItem(activePreferenceProfileKey(folderPath));
  return saved && profiles.some((profile) => profile.id === saved)
    ? saved
    : fallback;
}

export function saveActivePreferenceProfileId(folderPath: string | null, profileId: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(activePreferenceProfileKey(folderPath), profileId);
}

export function createPreferenceProfile(
  folderPath: string | null,
  name: string,
): AutoCullPreferenceProfile {
  const now = new Date().toISOString();
  const profile = {
    id: newPreferenceProfileId(),
    name: name.trim() || `Profile ${loadPreferenceProfiles(folderPath).length + 1}`,
    created_at: now,
    updated_at: now,
  };
  savePreferenceProfiles(folderPath, [...loadPreferenceProfiles(folderPath), profile]);
  saveActivePreferenceProfileId(folderPath, profile.id);
  return profile;
}

export function loadPreferenceRefinements(
  folderPath: string | null,
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
): AutoCullPreferenceRefinement[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(preferenceRefinementsKey(folderPath, profileId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? dedupePreferenceRefinements(parsed.filter(isPreferenceRefinement)) : [];
  } catch {
    return [];
  }
}

export function savePreferenceRefinements(
  folderPath: string | null,
  profileId: string,
  refinements: AutoCullPreferenceRefinement[],
) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    preferenceRefinementsKey(folderPath, profileId),
    JSON.stringify(dedupePreferenceRefinements(refinements).slice(-4_000)),
  );
  touchPreferenceProfile(folderPath, profileId);
}

export function recordPreferenceRefinement(
  folderPath: string | null,
  profileId: string,
  photoId: string,
  flag: CullFlag,
  rating: number,
  photo?: Photo,
  analysis?: AutoCullPhoto,
) {
  const now = new Date().toISOString();
  savePreferenceRefinements(folderPath, profileId, [
    ...loadPreferenceRefinements(folderPath, profileId),
    {
      photo_id: photoId,
      flag: normalizeFlag(flag),
      rating: clamp(Math.round(rating), 0, 5),
      confidence: normalizeFlag(flag) === "none" ? 0.62 : 1,
      source: "manual_decision",
      updated_at: now,
      ...(photo ? {
        ranker_features: rankerFeatureVector(
          photo,
          analysis?.embedding ? {
            embedding: analysis.embedding,
            technicalScore: analysis.technical_score,
            backend: analysis.embedding_backend ?? PERCEPTUAL_EMBEDDING_BACKEND,
          } : null,
          analysis?.technical_score ?? fallbackTechnicalScore(photo),
        ),
        embedding: analysis?.embedding ? [...analysis.embedding] : [],
      } : {}),
    },
  ]);
}

export function loadPairwisePreferences(
  folderPath: string | null,
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
): AutoCullPairwisePreference[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(pairwisePreferenceKey(folderPath, profileId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPairwisePreference) : [];
  } catch {
    return [];
  }
}

export function savePairwisePreferences(
  folderPath: string | null,
  preferences: AutoCullPairwisePreference[],
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(pairwisePreferenceKey(folderPath, profileId), JSON.stringify(dedupePairwise(preferences)));
  touchPreferenceProfile(folderPath, profileId);
}

export function addPairwisePreferences(
  folderPath: string | null,
  preferences: AutoCullPairwisePreference[],
  profileId = DEFAULT_PREFERENCE_PROFILE_ID,
) {
  savePairwisePreferences(folderPath, [
    ...loadPairwisePreferences(folderPath, profileId),
    ...preferences,
  ], profileId);
}

function isPreferenceProfile(value: unknown): value is AutoCullPreferenceProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<AutoCullPreferenceProfile>;
  return (
    typeof profile.id === "string"
    && typeof profile.name === "string"
    && typeof profile.created_at === "string"
    && typeof profile.updated_at === "string"
  );
}

function isPreferenceRefinement(value: unknown): value is AutoCullPreferenceRefinement {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AutoCullPreferenceRefinement>;
  return (
    typeof item.photo_id === "string"
    && (item.flag === "none" || item.flag === "pick" || item.flag === "reject")
    && typeof item.rating === "number"
    && typeof item.confidence === "number"
    && item.source === "manual_decision"
    && typeof item.updated_at === "string"
  );
}

function dedupePreferenceRefinements(
  refinements: AutoCullPreferenceRefinement[],
): AutoCullPreferenceRefinement[] {
  const byPhotoId = new Map<string, AutoCullPreferenceRefinement>();
  for (const refinement of refinements) {
    byPhotoId.set(refinement.photo_id, {
      ...refinement,
      flag: normalizeFlag(refinement.flag),
      rating: clamp(Math.round(refinement.rating), 0, 5),
      confidence: clamp(refinement.confidence, 0.1, 1.25),
    });
  }
  return [...byPhotoId.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

function normalizePreferenceProfiles(
  profiles: AutoCullPreferenceProfile[],
): AutoCullPreferenceProfile[] {
  const defaultProfile = defaultPreferenceProfile();
  const seen = new Set<string>([defaultProfile.id]);
  const result = [defaultProfile];

  for (const profile of profiles) {
    if (profile.id === DEFAULT_PREFERENCE_PROFILE_ID || seen.has(profile.id)) continue;
    seen.add(profile.id);
    result.push({
      id: profile.id,
      name: profile.name.trim() || "Untitled",
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    });
  }

  return result;
}

function newPreferenceProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function touchPreferenceProfile(folderPath: string | null, profileId: string) {
  if (profileId === DEFAULT_PREFERENCE_PROFILE_ID || typeof localStorage === "undefined") return;
  const profiles = loadPreferenceProfiles(folderPath);
  const now = new Date().toISOString();
  savePreferenceProfiles(folderPath, profiles.map((profile) => (
    profile.id === profileId ? { ...profile, updated_at: now } : profile
  )));
}

export async function buildAutoCullSession(
  photos: Photo[],
  preferences: AutoCullPairwisePreference[] = [],
  onProgress: (progress: VisualIndexProgress) => void = () => {},
  refinements: AutoCullPreferenceRefinement[] = [],
  learnFromPhotoMetadata = true,
  folderPath: string | null = null,
): Promise<AutoCullSession> {
  const featuresById = new Map<string, PixelFeatures | null>();
  const total = photos.length;
  const sqlCache = await readSqlFeatureCache(photos, folderPath);
  const pendingSqlEntries: SqlFeatureCacheEntry[] = [];
  let completed = 0;
  await parallelForEach(photos, heavyMediaConcurrency(), async (photo) => {
    await idleTick();
    const features = await extractCachedPixelFeatures(photo, sqlCache, pendingSqlEntries);
    featuresById.set(photo.id, features);
    completed++;
    onProgress({ current: completed, total, current_file: photo.file_name });
  });
  await writeSqlFeatureCache(pendingSqlEntries, folderPath);

  const featureRecordsById = buildFeatureRecords(photos, featuresById);
  const examples = buildRankedExamples(photos, featureRecordsById, refinements, learnFromPhotoMetadata);
  const pairwiseExamples = buildPairwiseExamples(preferences, featureRecordsById);
  const model = trainRankingModel(examples, pairwiseExamples);

  let scored = photos.map((photo) => {
    const record = featureRecordsById.get(photo.id);
    const technicalScore = record?.technicalScore ?? fallbackTechnicalScore(photo);
    const embedding = record?.embedding;
    const behaviorSignalValue = behaviorSignal(photo);
    const neutral = neutralPersonalScore(technicalScore);
    const boostedScore = model.score(record?.rankerFeatures);
    const learnedDelta = nearestNeighborDelta(embedding, model.examples);
    const personalScore = clamp01(
      neutral
        + (boostedScore == null ? 0 : (boostedScore - 0.5) * 0.72)
        + learnedDelta
        + behaviorSignalValue,
    );
    const finalScore = blendScores(technicalScore, personalScore);
    return {
      source: photo,
      photo_id: photo.id,
      cluster_id: "",
      technical_score: technicalScore,
      personal_score: personalScore,
      final_score: finalScore,
      behavior_signal: behaviorSignalValue,
      recommendation: recommendationFor(photo, finalScore, personalScore),
      confidence: recommendationConfidence(photo, finalScore, embedding),
      embedding,
      embedding_backend: record?.embedding ? (featuresById.get(photo.id)?.backend ?? PERCEPTUAL_EMBEDDING_BACKEND) : undefined,
      captureMs: captureTimestampMs(photo),
      sortTimeMs: sortTimestampMs(photo),
      sequence: filenameSequence(photo.file_name),
    } satisfies ScoredPhoto;
  });

  const clusters = buildClusters(scored);
  const clusterByPhotoId = new Map<string, string>();
  for (const cluster of clusters) {
    for (const photoId of cluster.photo_ids) clusterByPhotoId.set(photoId, cluster.id);
  }
  scored = scored.map((photo) => ({
    ...photo,
    cluster_id: clusterByPhotoId.get(photo.photo_id) ?? `single-${photo.photo_id}`,
  }));

  const outputPhotos: AutoCullPhoto[] = scored.map(({
    source: _source,
    captureMs: _captureMs,
    sortTimeMs: _sortTimeMs,
    sequence: _sequence,
    ...photo
  }) => photo);
  onProgress({ current: total, total });
  return {
    embedding_backend: EMBEDDING_BACKEND,
    ranker_version: RANKER_VERSION,
    generated_at: new Date().toISOString(),
    photos: outputPhotos,
    clusters,
    stats: {
      total,
      indexed: outputPhotos.filter((photo) => photo.embedding?.length).length,
      select: outputPhotos.filter((photo) => photo.recommendation === "SELECT").length,
      maybe: outputPhotos.filter((photo) => photo.recommendation === "MAYBE").length,
      reject: outputPhotos.filter((photo) => photo.recommendation === "REJECT").length,
      needs_review: outputPhotos.filter((photo) => photo.recommendation === "NEEDS_REVIEW").length,
    },
  };
}

async function parallelForEach<T>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await work(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

function isPairwisePreference(value: unknown): value is AutoCullPairwisePreference {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AutoCullPairwisePreference>;
  return (
    typeof item.winner_photo_id === "string"
    && typeof item.loser_photo_id === "string"
    && typeof item.confidence === "number"
    && typeof item.created_at === "string"
  );
}

function dedupePairwise(preferences: AutoCullPairwisePreference[]): AutoCullPairwisePreference[] {
  const seen = new Set<string>();
  const result: AutoCullPairwisePreference[] = [];
  for (const preference of preferences.slice().reverse()) {
    const key = `${preference.winner_photo_id}:${preference.loser_photo_id}:${preference.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(preference);
  }
  return result.reverse().slice(-2_000);
}

async function extractCachedPixelFeatures(
  photo: Photo,
  sqlCache: Map<string, PixelFeatures | null>,
  pendingSqlEntries: SqlFeatureCacheEntry[],
): Promise<PixelFeatures | null> {
  const cacheKey = pixelFeatureCacheKey(photo);
  if (pixelFeatureMemoryCache.has(cacheKey)) {
    return clonePixelFeatures(pixelFeatureMemoryCache.get(cacheKey));
  }

  if (sqlCache.has(cacheKey)) {
    const features = sqlCache.get(cacheKey) ?? null;
    rememberPixelFeatures(cacheKey, features);
    return clonePixelFeatures(features);
  }

  const persisted = await readCachedPixelFeatures(cacheKey);
  if (persisted !== undefined) {
    rememberPixelFeatures(cacheKey, persisted);
    pendingSqlEntries.push(sqlFeatureCacheEntry(cacheKey, photo, persisted));
    return clonePixelFeatures(persisted);
  }

  const features = await extractPixelFeatures(photo);
  rememberPixelFeatures(cacheKey, features);
  pendingSqlEntries.push(sqlFeatureCacheEntry(cacheKey, photo, features));
  void writeCachedPixelFeatures(cacheKey, photo, features);
  return features;
}

function sqlFeatureCacheEntry(
  key: string,
  photo: Photo,
  features: PixelFeatures | null,
): SqlFeatureCacheEntry {
  return {
    key,
    version: FEATURE_CACHE_VERSION,
    file_path: photo.file_path,
    file_size: photo.file_size,
    modified_at: photo.modified_at,
    features: clonePixelFeatures(features),
  };
}

async function readSqlFeatureCache(
  photos: Photo[],
  folderPath: string | null,
): Promise<Map<string, PixelFeatures | null>> {
  try {
    const entries = await invoke<SqlFeatureCacheEntry[]>("read_autocull_feature_cache", {
      folderPath,
      cacheKeys: photos.map(pixelFeatureCacheKey),
    });
    return new Map(
      entries
        .filter((entry) => entry.version === FEATURE_CACHE_VERSION)
        .map((entry) => [entry.key, clonePixelFeatures(entry.features)]),
    );
  } catch {
    // Browser-only development has no Tauri SQL backend; IndexedDB remains its fallback.
    return new Map();
  }
}

async function writeSqlFeatureCache(
  entries: SqlFeatureCacheEntry[],
  folderPath: string | null,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await invoke("write_autocull_feature_cache", { folderPath, entries });
  } catch {
    // IndexedDB has already received newly computed entries as a browser fallback.
  }
}

function pixelFeatureCacheKey(photo: Photo): string {
  return JSON.stringify([
    FEATURE_CACHE_VERSION,
    photo.file_path,
    photo.file_type,
    photo.file_size,
    photo.modified_at,
    photo.exif?.orientation ?? null,
    thumbnailFingerprint(photo),
  ]);
}

function thumbnailFingerprint(photo: Photo): string {
  if (!photo.thumbnail) return "none";
  return [
    photo.thumbnail.length,
    photo.thumbnail.slice(0, 32),
    photo.thumbnail.slice(-16),
  ].join(":");
}

function clonePixelFeatures(features: PixelFeatures | null | undefined): PixelFeatures | null {
  if (!features) return null;
  return {
    embedding: [...features.embedding],
    technicalScore: features.technicalScore,
    backend: features.backend,
  };
}

function rememberPixelFeatures(cacheKey: string, features: PixelFeatures | null) {
  if (pixelFeatureMemoryCache.has(cacheKey)) pixelFeatureMemoryCache.delete(cacheKey);
  pixelFeatureMemoryCache.set(cacheKey, clonePixelFeatures(features));

  while (pixelFeatureMemoryCache.size > MEMORY_FEATURE_CACHE_LIMIT) {
    const oldestKey = pixelFeatureMemoryCache.keys().next().value;
    if (!oldestKey) break;
    pixelFeatureMemoryCache.delete(oldestKey);
  }
}

function openFeatureCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (featureCacheDbPromise) return featureCacheDbPromise;

  featureCacheDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(FEATURE_CACHE_DB, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(FEATURE_CACHE_STORE)
        ? request.transaction?.objectStore(FEATURE_CACHE_STORE)
        : db.createObjectStore(FEATURE_CACHE_STORE, { keyPath: "key" });

      if (store && !store.indexNames.contains("cached_at")) {
        store.createIndex("cached_at", "cached_at");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return featureCacheDbPromise;
}

async function readCachedPixelFeatures(cacheKey: string): Promise<PixelFeatures | null | undefined> {
  const db = await openFeatureCacheDb();
  if (!db) return undefined;

  return new Promise((resolve) => {
    const transaction = db.transaction(FEATURE_CACHE_STORE, "readonly");
    const request = transaction.objectStore(FEATURE_CACHE_STORE).get(cacheKey);

    request.onsuccess = () => {
      const entry = request.result as CachedPixelFeaturesEntry | undefined;
      if (!entry || entry.version !== FEATURE_CACHE_VERSION) {
        resolve(undefined);
        return;
      }
      resolve(clonePixelFeatures(entry.features));
    };

    request.onerror = () => resolve(undefined);
    transaction.onerror = () => resolve(undefined);
  });
}

async function writeCachedPixelFeatures(cacheKey: string, photo: Photo, features: PixelFeatures | null) {
  const db = await openFeatureCacheDb();
  if (!db) return;

  const entry: CachedPixelFeaturesEntry = {
    key: cacheKey,
    version: FEATURE_CACHE_VERSION,
    cached_at: new Date().toISOString(),
    file_path: photo.file_path,
    file_size: photo.file_size,
    modified_at: photo.modified_at,
    features: clonePixelFeatures(features),
  };

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(FEATURE_CACHE_STORE, "readwrite");
    transaction.objectStore(FEATURE_CACHE_STORE).put(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });

  scheduleFeatureCachePrune(db);
}

function scheduleFeatureCachePrune(db: IDBDatabase) {
  if (featureCachePrunePromise) return;
  featureCachePrunePromise = pruneFeatureCache(db).finally(() => {
    featureCachePrunePromise = null;
  });
}

async function pruneFeatureCache(db: IDBDatabase) {
  const count = await new Promise<number>((resolve) => {
    const transaction = db.transaction(FEATURE_CACHE_STORE, "readonly");
    const request = transaction.objectStore(FEATURE_CACHE_STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(0);
    transaction.onerror = () => resolve(0);
  });

  if (count <= PERSISTENT_FEATURE_CACHE_LIMIT) return;
  let remaining = count - PERSISTENT_FEATURE_CACHE_LIMIT;

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(FEATURE_CACHE_STORE, "readwrite");
    const request = transaction.objectStore(FEATURE_CACHE_STORE).index("cached_at").openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || remaining <= 0) return;
      cursor.delete();
      remaining--;
      cursor.continue();
    };

    request.onerror = () => resolve();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

async function extractPixelFeatures(photo: Photo): Promise<PixelFeatures | null> {
  const src = photoPreviewSrc(photo);
  if (!src || typeof document === "undefined") return null;

  try {
    const image = await loadImage(src);
    const grid = drawImageData(image, SPATIAL_GRID, SPATIAL_GRID);
    const sample = drawImageData(image, SAMPLE_SIZE, SAMPLE_SIZE);
    const perceptualEmbedding = perceptualImageEmbedding(
      grid,
      sample,
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
    );
    const transformerEmbedding = await extractTransformerEmbedding(image);
    return {
      embedding: combineVisionEmbeddings(transformerEmbedding, perceptualEmbedding),
      technicalScore: estimateTechnicalScore(sample),
      backend: transformerEmbedding ? EMBEDDING_BACKEND : PERCEPTUAL_EMBEDDING_BACKEND,
    };
  } catch {
    return null;
  }
}

let dinoExtractorPromise: Promise<ImageFeatureExtractor | null> | null = null;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Preview could not be decoded"));
    image.src = src;
  });
}

function drawImageCanvas(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

function drawImageData(image: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = drawImageCanvas(image, width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  return ctx.getImageData(0, 0, width, height);
}

async function extractTransformerEmbedding(image: HTMLImageElement): Promise<number[] | null> {
  if (transformerEmbeddingsDisabled()) return null;

  try {
    const extractor = await withTimeout(loadDinoExtractor(), TRANSFORMER_MODEL_TIMEOUT_MS, null);
    if (!extractor) return null;

    const canvas = drawImageCanvas(image, TRANSFORMER_SAMPLE_SIZE, TRANSFORMER_SAMPLE_SIZE);
    const tensor = await withTimeout(extractor(canvas), TRANSFORMER_INFERENCE_TIMEOUT_MS, null);
    if (!tensor) return null;

    const embedding = tensorToEmbedding(tensor);
    tensor.dispose?.();
    return embedding.length ? normalizeVector(embedding) : null;
  } catch {
    return null;
  }
}

function transformerEmbeddingsDisabled(): boolean {
  if (typeof window === "undefined") return true;
  return Boolean((window as typeof window & {
    __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__?: boolean;
  }).__HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__);
}

async function loadDinoExtractor(): Promise<ImageFeatureExtractor | null> {
  if (dinoExtractorPromise) return dinoExtractorPromise;
  dinoExtractorPromise = (async () => {
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      const extractor = await pipeline("image-feature-extraction", DINO_MODEL_ID, {
        dtype: "q8",
      });
      return extractor as unknown as ImageFeatureExtractor;
    } catch {
      return null;
    }
  })();
  return dinoExtractorPromise;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function tensorToEmbedding(tensor: EmbeddingTensor): number[] {
  const data = Array.from(tensor.data, Number).filter(Number.isFinite);
  if (tensor.dims.length === 3) {
    const tokenCount = tensor.dims[1] ?? 0;
    const dimensions = tensor.dims[2] ?? 0;
    if (tokenCount <= 0 || dimensions <= 0) return [];

    const result: number[] = [];
    for (let feature = 0; feature < dimensions; feature++) {
      const clsValue = data[feature] ?? 0;
      let patchSum = 0;
      let patchCount = 0;
      for (let token = 1; token < tokenCount; token++) {
        patchSum += data[(token * dimensions) + feature] ?? 0;
        patchCount++;
      }
      const patchMean = patchCount ? patchSum / patchCount : clsValue;
      result.push((clsValue * 0.55) + (patchMean * 0.45));
    }
    return result;
  }

  if (tensor.dims.length === 2) {
    const dimensions = tensor.dims[1] ?? data.length;
    return data.slice(0, dimensions);
  }

  return data;
}

function combineVisionEmbeddings(transformerEmbedding: number[] | null, perceptualEmbedding: number[]): number[] {
  if (!transformerEmbedding?.length) return perceptualEmbedding;
  return normalizeVector([
    ...transformerEmbedding.map((value) => value * 0.82),
    ...perceptualEmbedding.map((value) => value * 0.57),
  ]);
}

function perceptualImageEmbedding(grid: ImageData, sample: ImageData, sourceWidth: number, sourceHeight: number): number[] {
  const vector: number[] = [];
  appendRgbGrid(vector, grid);
  appendOpponentGrid(vector, grid);
  appendEdgeGrid(vector, grid);
  appendGradientHistograms(vector, sample);
  appendFocusGrid(vector, sample);
  appendHistograms(vector, sample);
  appendColorMoments(vector, sample);
  appendDctFeatures(vector, sample);
  appendPerceptualHash(vector, sample);
  appendCompositionFeatures(vector, sample, sourceWidth, sourceHeight);
  return normalizeVector(vector);
}

function appendRgbGrid(vector: number[], image: ImageData) {
  for (let index = 0; index < image.data.length; index += 4) {
    vector.push(image.data[index] / 255 - 0.5);
    vector.push(image.data[index + 1] / 255 - 0.5);
    vector.push(image.data[index + 2] / 255 - 0.5);
  }
}

function appendOpponentGrid(vector: number[], image: ImageData) {
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] / 255;
    const green = image.data[index + 1] / 255;
    const blue = image.data[index + 2] / 255;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const redGreen = (red - green) * 0.5;
    const blueYellow = ((red + green) * 0.5) - blue;
    const saturation = maxChannel <= Number.EPSILON ? 0 : (maxChannel - minChannel) / maxChannel;
    vector.push(luma - 0.5);
    vector.push(redGreen);
    vector.push(blueYellow * 0.5);
    vector.push(saturation - 0.5);
  }
}

function appendEdgeGrid(vector: number[], image: ImageData) {
  const luma = lumaArray(image);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
        vector.push(0);
        continue;
      }
      const gx = -lumaAt(luma, image.width, x - 1, y - 1) + lumaAt(luma, image.width, x + 1, y - 1)
        - (2 * lumaAt(luma, image.width, x - 1, y))
        + (2 * lumaAt(luma, image.width, x + 1, y))
        - lumaAt(luma, image.width, x - 1, y + 1)
        + lumaAt(luma, image.width, x + 1, y + 1);
      const gy = -lumaAt(luma, image.width, x - 1, y - 1)
        - (2 * lumaAt(luma, image.width, x, y - 1))
        - lumaAt(luma, image.width, x + 1, y - 1)
        + lumaAt(luma, image.width, x - 1, y + 1)
        + (2 * lumaAt(luma, image.width, x, y + 1))
        + lumaAt(luma, image.width, x + 1, y + 1);
      vector.push(clamp(Math.sqrt((gx * gx) + (gy * gy)) / 4, 0, 1));
    }
  }
}

function appendGradientHistograms(vector: number[], image: ImageData) {
  const luma = lumaArray(image);
  const histogramCount = GRADIENT_CELLS * GRADIENT_CELLS * GRADIENT_BINS;
  const histograms = Array.from({ length: histogramCount }, () => 0);
  const totals = Array.from({ length: GRADIENT_CELLS * GRADIENT_CELLS }, () => 0);

  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const gx = lumaAt(luma, image.width, x + 1, y) - lumaAt(luma, image.width, x - 1, y);
      const gy = lumaAt(luma, image.width, x, y + 1) - lumaAt(luma, image.width, x, y - 1);
      const magnitude = Math.sqrt((gx * gx) + (gy * gy));
      if (magnitude <= Number.EPSILON) continue;

      const cellX = Math.min(GRADIENT_CELLS - 1, Math.floor((x / image.width) * GRADIENT_CELLS));
      const cellY = Math.min(GRADIENT_CELLS - 1, Math.floor((y / image.height) * GRADIENT_CELLS));
      const cell = (cellY * GRADIENT_CELLS) + cellX;
      const angle = Math.atan2(gy, gx) + Math.PI;
      const bin = Math.min(GRADIENT_BINS - 1, Math.floor((angle / (Math.PI * 2)) * GRADIENT_BINS));
      histograms[(cell * GRADIENT_BINS) + bin] += magnitude;
      totals[cell] += magnitude;
    }
  }

  for (let cell = 0; cell < totals.length; cell++) {
    const total = Math.max(Number.EPSILON, totals[cell]);
    for (let bin = 0; bin < GRADIENT_BINS; bin++) {
      vector.push((histograms[(cell * GRADIENT_BINS) + bin] / total) - (1 / GRADIENT_BINS));
    }
  }
}

function appendFocusGrid(vector: number[], image: ImageData) {
  const luma = lumaArray(image);
  const sums = Array.from({ length: GRADIENT_CELLS * GRADIENT_CELLS }, () => 0);
  const counts = Array.from({ length: GRADIENT_CELLS * GRADIENT_CELLS }, () => 0);

  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const center = lumaAt(luma, image.width, x, y) * 4;
      const neighbors = lumaAt(luma, image.width, x - 1, y)
        + lumaAt(luma, image.width, x + 1, y)
        + lumaAt(luma, image.width, x, y - 1)
        + lumaAt(luma, image.width, x, y + 1);
      const cellX = Math.min(GRADIENT_CELLS - 1, Math.floor((x / image.width) * GRADIENT_CELLS));
      const cellY = Math.min(GRADIENT_CELLS - 1, Math.floor((y / image.height) * GRADIENT_CELLS));
      const cell = (cellY * GRADIENT_CELLS) + cellX;
      sums[cell] += (center - neighbors) ** 2;
      counts[cell]++;
    }
  }

  for (let index = 0; index < sums.length; index++) {
    const focus = counts[index] ? Math.sqrt(sums[index] / counts[index]) : 0;
    vector.push(clamp(focus * 4.8, 0, 1) - 0.5);
  }
}

function appendHistograms(vector: number[], image: ImageData) {
  const histograms = Array.from({ length: HISTOGRAM_BINS * 5 }, () => 0);
  const total = Math.max(1, image.width * image.height);

  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] / 255;
    const green = image.data[index + 1] / 255;
    const blue = image.data[index + 2] / 255;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const saturation = maxChannel <= Number.EPSILON ? 0 : (maxChannel - minChannel) / maxChannel;
    histograms[histogramIndex(0, red)] += 1;
    histograms[histogramIndex(1, green)] += 1;
    histograms[histogramIndex(2, blue)] += 1;
    histograms[histogramIndex(3, luma)] += 1;
    histograms[histogramIndex(4, saturation)] += 1;
  }

  for (const value of histograms) vector.push(value / total);
}

function appendColorMoments(vector: number[], image: ImageData) {
  const channels = Array.from({ length: 5 }, () => [] as number[]);

  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] / 255;
    const green = image.data[index + 1] / 255;
    const blue = image.data[index + 2] / 255;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    channels[0].push(red);
    channels[1].push(green);
    channels[2].push(blue);
    channels[3].push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
    channels[4].push(maxChannel <= Number.EPSILON ? 0 : (maxChannel - minChannel) / maxChannel);
  }

  for (const channel of channels) {
    const mean = channel.reduce((sum, value) => sum + value, 0) / Math.max(1, channel.length);
    const variance = channel.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, channel.length);
    const standardDeviation = Math.sqrt(variance);
    const skew = channel.reduce((sum, value) => sum + ((value - mean) ** 3), 0) / Math.max(1, channel.length);
    vector.push(mean - 0.5);
    vector.push(standardDeviation - 0.25);
    vector.push(clamp(skew * 4, -1, 1));
  }
}

function appendDctFeatures(vector: number[], image: ImageData) {
  const coefficients = lowFrequencyDct(image, DCT_COEFFICIENTS);
  for (const coefficient of coefficients) vector.push(clamp(coefficient * 1.8, -1, 1));
}

function appendPerceptualHash(vector: number[], image: ImageData) {
  const coefficients = lowFrequencyDct(image, 8).slice(1);
  if (!coefficients.length) return;
  const threshold = median(coefficients);
  for (const coefficient of coefficients) vector.push(coefficient >= threshold ? 0.5 : -0.5);
}

function appendCompositionFeatures(
  vector: number[],
  image: ImageData,
  sourceWidth: number,
  sourceHeight: number,
) {
  const cellWidth = Math.max(1, Math.floor(image.width / 3));
  const cellHeight = Math.max(1, Math.floor(image.height / 3));

  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const startX = column * cellWidth;
      const startY = row * cellHeight;
      const endX = column === 2 ? image.width : Math.min(image.width, (column + 1) * cellWidth);
      const endY = row === 2 ? image.height : Math.min(image.height, (row + 1) * cellHeight);
      let lumaSum = 0;
      let saturationSum = 0;
      let count = 0;

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const index = ((y * image.width) + x) * 4;
          const red = image.data[index] / 255;
          const green = image.data[index + 1] / 255;
          const blue = image.data[index + 2] / 255;
          const maxChannel = Math.max(red, green, blue);
          const minChannel = Math.min(red, green, blue);
          lumaSum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          saturationSum += maxChannel <= Number.EPSILON ? 0 : (maxChannel - minChannel) / maxChannel;
          count++;
        }
      }

      vector.push(count ? lumaSum / count - 0.5 : 0);
      vector.push(count ? saturationSum / count - 0.5 : 0);
    }
  }

  const aspectRatio = sourceWidth / Math.max(1, sourceHeight);
  vector.push(clamp(aspectRatio / 3, 0, 1));
  vector.push(aspectRatio >= 1 ? 1 : -1);
}

function lowFrequencyDct(image: ImageData, coefficientCount: number): number[] {
  const luma = downsampleLuma(image, DCT_SIZE);
  const coefficients: number[] = [];
  for (let yFrequency = 0; yFrequency < coefficientCount; yFrequency++) {
    for (let xFrequency = 0; xFrequency < coefficientCount; xFrequency++) {
      const coefficient = dctCoefficient(luma, DCT_SIZE, xFrequency, yFrequency);
      coefficients.push(coefficient);
    }
  }
  return coefficients;
}

function downsampleLuma(image: ImageData, size: number): number[] {
  const result: number[] = [];
  for (let targetY = 0; targetY < size; targetY++) {
    for (let targetX = 0; targetX < size; targetX++) {
      const startX = Math.floor((targetX * image.width) / size);
      const endX = Math.max(startX + 1, Math.floor(((targetX + 1) * image.width) / size));
      const startY = Math.floor((targetY * image.height) / size);
      const endY = Math.max(startY + 1, Math.floor(((targetY + 1) * image.height) / size));
      let sum = 0;
      let count = 0;

      for (let y = startY; y < Math.min(image.height, endY); y++) {
        for (let x = startX; x < Math.min(image.width, endX); x++) {
          const index = ((y * image.width) + x) * 4;
          sum += (
            (0.2126 * image.data[index])
            + (0.7152 * image.data[index + 1])
            + (0.0722 * image.data[index + 2])
          ) / 255;
          count++;
        }
      }

      result.push(count ? sum / count - 0.5 : 0);
    }
  }
  return result;
}

function dctCoefficient(values: number[], size: number, xFrequency: number, yFrequency: number): number {
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sum += (values[(y * size) + x] ?? 0)
        * Math.cos(((2 * x + 1) * xFrequency * Math.PI) / (2 * size))
        * Math.cos(((2 * y + 1) * yFrequency * Math.PI) / (2 * size));
    }
  }
  const xScale = xFrequency === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
  const yScale = yFrequency === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
  return xScale * yScale * sum;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function estimateTechnicalScore(image: ImageData): number {
  const luma = lumaArray(image);
  if (image.width < 3 || image.height < 3 || luma.length === 0) return 0.25;

  const mean = luma.reduce((sum, value) => sum + value, 0) / luma.length;
  const contrast = Math.sqrt(
    luma.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / luma.length,
  );
  const clipped = luma.filter((value) => value < 0.02 || value > 0.98).length;
  const laplacians: number[] = [];

  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const center = lumaAt(luma, image.width, x, y) * 4;
      const neighbors = lumaAt(luma, image.width, x - 1, y)
        + lumaAt(luma, image.width, x + 1, y)
        + lumaAt(luma, image.width, x, y - 1)
        + lumaAt(luma, image.width, x, y + 1);
      laplacians.push(center - neighbors);
    }
  }

  const laplacianMean = laplacians.reduce((sum, value) => sum + value, 0) / Math.max(1, laplacians.length);
  const laplacianVariance = laplacians.reduce(
    (sum, value) => sum + ((value - laplacianMean) ** 2),
    0,
  ) / Math.max(1, laplacians.length);

  const sharpnessScore = clamp(laplacianVariance * 85, 0, 1);
  const exposureScore = clamp(1 - Math.abs(mean - 0.5) * 1.65, 0, 1);
  const contrastScore = clamp(contrast * 3.2, 0, 1);
  const clippingScore = clamp(1 - (clipped / luma.length) * 3, 0, 1);
  return clamp01(
    sharpnessScore * 0.46
      + exposureScore * 0.24
      + contrastScore * 0.18
      + clippingScore * 0.12,
  );
}

function fallbackTechnicalScore(photo: Photo): number {
  let score = 0.54;
  const iso = photo.exif.iso ?? 0;
  if (iso >= 6400) score -= 0.12;
  else if (iso >= 3200) score -= 0.08;
  else if (iso > 0 && iso <= 400) score += 0.04;

  const shutter = shutterSeconds(photo.exif.shutter_speed);
  const focal = photo.exif.focal_length ?? 50;
  if (shutter && shutter > 1 / Math.max(30, focal)) score -= 0.08;
  if ((photo.exif.aperture ?? 99) <= 2.0) score += 0.02;
  if ((photo.exif.width ?? 0) > 0 && (photo.exif.height ?? 0) > 0) score += 0.02;
  return clamp01(score);
}

function buildFeatureRecords(
  photos: Photo[],
  featuresById: Map<string, PixelFeatures | null>,
): Map<string, FeatureRecord> {
  const records = new Map<string, FeatureRecord>();
  for (const photo of photos) {
    const pixelFeatures = featuresById.get(photo.id);
    const technicalScore = pixelFeatures?.technicalScore ?? fallbackTechnicalScore(photo);
    records.set(photo.id, {
      photo,
      embedding: pixelFeatures?.embedding,
      technicalScore,
      rankerFeatures: rankerFeatureVector(photo, pixelFeatures, technicalScore),
    });
  }
  return records;
}

function rankerFeatureVector(
  photo: Photo,
  pixelFeatures: PixelFeatures | null | undefined,
  technicalScore: number,
): number[] {
  const iso = photo.exif.iso ?? 0;
  const shutter = shutterSeconds(photo.exif.shutter_speed) ?? 0;
  const aperture = photo.exif.aperture ?? 0;
  const focal = photo.exif.focal_length ?? 0;
  const width = photo.exif.width ?? 0;
  const height = photo.exif.height ?? 0;
  const aspect = width > 0 && height > 0 ? width / height : 0;
  const exposureBias = photo.exif.exposure_bias ?? 0;
  const ev100 = photo.exif.ev100 ?? 0;
  const fileType = photo.file_type.toUpperCase();
  const embedding = pixelFeatures?.embedding;
  const features = [
    technicalScore,
    iso ? clamp(1 - (Math.log2(Math.max(100, iso) / 100) / 7), 0, 1) : 0.55,
    aperture ? clamp(aperture / 16, 0, 1) : 0,
    shutter ? clamp((Math.log2(shutter + (1 / 8000)) + 13) / 18, 0, 1) : 0,
    focal ? clamp(focal / 300, 0, 1) : 0,
    aspect ? clamp(aspect / 3, 0, 1) : 0,
    aspect && aspect < 1 ? 1 : 0,
    clamp((exposureBias + 5) / 10, 0, 1),
    ev100 ? clamp(ev100 / 18, 0, 1) : 0,
    ["CR2", "CR3", "NEF", "ARW", "DNG", "RAF", "ORF", "RW2"].includes(fileType) ? 1 : 0,
    photo.paired_with ? 1 : 0,
  ];

  for (let index = 0; index < EMBEDDING_RANKER_FEATURES; index++) {
    features.push(embedding ? sampledVectorValue(embedding, index, EMBEDDING_RANKER_FEATURES) : 0);
  }

  return features;
}

function sampledVectorValue(vector: number[], index: number, targetLength: number): number {
  if (!vector.length) return 0;
  const start = Math.floor((index * vector.length) / targetLength);
  const end = Math.max(start + 1, Math.floor(((index + 1) * vector.length) / targetLength));
  let sum = 0;
  let count = 0;
  for (let sourceIndex = start; sourceIndex < Math.min(vector.length, end); sourceIndex++) {
    sum += vector[sourceIndex] ?? 0;
    count++;
  }
  return count ? sum / count : 0;
}

function buildRankedExamples(
  photos: Photo[],
  recordsById: Map<string, FeatureRecord>,
  refinements: AutoCullPreferenceRefinement[],
  learnFromPhotoMetadata: boolean,
): RankedExample[] {
  const examples: RankedExample[] = [];
  const refinementsByPhotoId = new Map(refinements.map((refinement) => [refinement.photo_id, refinement]));

  for (const photo of photos) {
    const record = recordsById.get(photo.id);
    if (!record) continue;
    const refinement = refinementsByPhotoId.get(photo.id);
    const rating = refinement?.rating ?? (learnFromPhotoMetadata ? photo.rating ?? 0 : 0);
    const flag = refinement ? normalizeFlag(refinement.flag) : (learnFromPhotoMetadata ? normalizeFlag(photo.flag) : "none");
    if (flag === "none" && rating <= 0) continue;
    examples.push({
      vector: record.embedding ?? [],
      features: record.rankerFeatures,
      signal: pointwiseSignal(flag, rating),
      confidence: refinement?.confidence ?? (flag === "none" ? 0.62 : 1),
    });
  }
  const activePhotoIds = new Set(photos.map((photo) => photo.id));
  for (const refinement of refinements) {
    if (activePhotoIds.has(refinement.photo_id) || !refinement.ranker_features?.length) continue;
    examples.push({
      vector: refinement.embedding ?? [],
      features: refinement.ranker_features,
      signal: pointwiseSignal(normalizeFlag(refinement.flag), refinement.rating),
      confidence: refinement.confidence,
    });
  }
  return examples;
}

function buildPairwiseExamples(
  preferences: AutoCullPairwisePreference[],
  recordsById: Map<string, FeatureRecord>,
): PairwiseExample[] {
  const examples: PairwiseExample[] = [];
  for (const preference of preferences) {
    const winner = recordsById.get(preference.winner_photo_id);
    const loser = recordsById.get(preference.loser_photo_id);
    if (!winner || !loser || winner.rankerFeatures.length !== loser.rankerFeatures.length) continue;
    examples.push({
      winnerFeatures: winner.rankerFeatures,
      loserFeatures: loser.rankerFeatures,
      confidence: clamp(preference.confidence, 0.1, 1.25),
    });
  }
  return examples;
}

function trainRankingModel(examples: RankedExample[], pairwiseExamples: PairwiseExample[]): RankingModel {
  const dimensions = examples[0]?.features.length ?? pairwiseExamples[0]?.winnerFeatures.length ?? 0;
  const usableExamples = examples.filter((example) => example.features.length === dimensions);
  const usablePairwiseExamples = pairwiseExamples.filter((example) => (
    example.winnerFeatures.length === dimensions && example.loserFeatures.length === dimensions
  ));
  const rows = buildBoostingRows(usableExamples, usablePairwiseExamples);
  if (!dimensions || rows.length === 0) {
    return { examples: usableExamples, score: () => null };
  }

  const baseScore = clamp(weightedMean(rows), 0.02, 0.98);
  const baseRaw = logit(baseScore);
  const rawPredictions = rows.map(() => baseRaw);
  const trees: RegressionTree[] = [];
  const allIndices = rows.map((_, index) => index);

  for (let treeIndex = 0; treeIndex < GBDT_TREES; treeIndex++) {
    const gradients: number[] = [];
    const hessians: number[] = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const prediction = sigmoid(rawPredictions[rowIndex] ?? baseRaw);
      gradients.push((row.target - prediction) * row.weight);
      hessians.push(Math.max(0.0001, prediction * (1 - prediction) * row.weight));
    }

    const tree = fitBoostedTree(rows, gradients, hessians, allIndices, dimensions, 0);
    trees.push(tree);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      rawPredictions[rowIndex] += GBDT_LEARNING_RATE * predictTree(tree, rows[rowIndex].features);
    }
  }

  return {
    examples: usableExamples,
    score: (features) => {
      if (!features || features.length !== dimensions) return null;
      let rawScore = baseRaw;
      for (const tree of trees) rawScore += GBDT_LEARNING_RATE * predictTree(tree, features);
      return clamp01(sigmoid(rawScore));
    },
  };
}

function buildBoostingRows(examples: RankedExample[], pairwiseExamples: PairwiseExample[]): BoostingRow[] {
  const rows: BoostingRow[] = [];
  for (const example of examples) {
    rows.push({
      features: example.features,
      target: clamp(example.signal, 0.03, 0.97),
      weight: clamp(example.confidence, 0.05, 2),
    });
  }

  for (const example of pairwiseExamples) {
    const weight = clamp(example.confidence * 0.9, 0.05, 1.4);
    rows.push({ features: example.winnerFeatures, target: 0.92, weight });
    rows.push({ features: example.loserFeatures, target: 0.08, weight });
  }
  return rows;
}

function weightedMean(rows: BoostingRow[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const row of rows) {
    weightedSum += row.target * row.weight;
    totalWeight += row.weight;
  }
  return totalWeight <= Number.EPSILON ? 0.5 : weightedSum / totalWeight;
}

function logit(value: number): number {
  const probability = clamp(value, 0.0001, 0.9999);
  return Math.log(probability / (1 - probability));
}

function fitBoostedTree(
  rows: BoostingRow[],
  gradients: number[],
  hessians: number[],
  indices: number[],
  featureCount: number,
  depth: number,
): RegressionTree {
  const parent = sumGradientStats(gradients, hessians, indices);
  const leaf = { value: leafValue(parent.gradient, parent.hessian) };
  if (depth >= GBDT_MAX_DEPTH || indices.length <= 2 || parent.hessian < GBDT_MIN_LEAF_WEIGHT * 2) return leaf;

  const parentScore = splitScore(parent.gradient, parent.hessian);
  let best:
    | { gain: number; feature: number; threshold: number; left: number[]; right: number[] }
    | null = null;

  for (let feature = 0; feature < featureCount; feature++) {
    const ordered = [...indices].sort((left, right) => rows[left].features[feature] - rows[right].features[feature]);
    let leftGradient = 0;
    let leftHessian = 0;

    for (let position = 0; position < ordered.length - 1; position++) {
      const rowIndex = ordered[position];
      leftGradient += gradients[rowIndex] ?? 0;
      leftHessian += hessians[rowIndex] ?? 0;

      const currentValue = rows[rowIndex].features[feature] ?? 0;
      const nextValue = rows[ordered[position + 1]].features[feature] ?? 0;
      if (Math.abs(currentValue - nextValue) <= 0.000001) continue;

      const rightGradient = parent.gradient - leftGradient;
      const rightHessian = parent.hessian - leftHessian;
      if (leftHessian < GBDT_MIN_LEAF_WEIGHT || rightHessian < GBDT_MIN_LEAF_WEIGHT) continue;

      const gain = splitScore(leftGradient, leftHessian) + splitScore(rightGradient, rightHessian) - parentScore;
      if (gain <= GBDT_MIN_SPLIT_GAIN || (best && gain <= best.gain)) continue;

      best = {
        gain,
        feature,
        threshold: (currentValue + nextValue) / 2,
        left: ordered.slice(0, position + 1),
        right: ordered.slice(position + 1),
      };
    }
  }

  if (!best) return leaf;
  return {
    feature: best.feature,
    threshold: best.threshold,
    left: fitBoostedTree(rows, gradients, hessians, best.left, featureCount, depth + 1),
    right: fitBoostedTree(rows, gradients, hessians, best.right, featureCount, depth + 1),
  };
}

function sumGradientStats(gradients: number[], hessians: number[], indices: number[]) {
  let gradient = 0;
  let hessian = 0;
  for (const index of indices) {
    gradient += gradients[index] ?? 0;
    hessian += hessians[index] ?? 0;
  }
  return { gradient, hessian };
}

function splitScore(gradient: number, hessian: number): number {
  return (gradient * gradient) / (hessian + GBDT_L2_REGULARIZATION);
}

function leafValue(gradient: number, hessian: number): number {
  return clamp(gradient / (hessian + GBDT_L2_REGULARIZATION), -3, 3);
}

function predictTree(tree: RegressionTree, features: number[]): number {
  if ("value" in tree) return tree.value;
  return (features[tree.feature] ?? 0) <= tree.threshold
    ? predictTree(tree.left, features)
    : predictTree(tree.right, features);
}

function nearestNeighborDelta(embedding: number[] | undefined, examples: RankedExample[]): number {
  if (!embedding) return 0;
  let weightedDelta = 0;
  let totalWeight = 0;
  for (const example of examples) {
    const similarity = cosineSimilarity(embedding, example.vector);
    if (similarity < 0.72) continue;
    const weight = example.confidence * (similarity ** 4);
    weightedDelta += (example.signal - 0.5) * weight;
    totalWeight += weight;
  }
  if (totalWeight <= Number.EPSILON) return 0;
  return clamp((weightedDelta / totalWeight) * 0.45, -0.22, 0.22);
}

function buildClusters(scored: ScoredPhoto[]): AutoCullCluster[] {
  const sorted = [...scored].sort((a, b) => {
    const timeDelta = (a.sortTimeMs ?? Number.MAX_SAFE_INTEGER) - (b.sortTimeMs ?? Number.MAX_SAFE_INTEGER);
    if (timeDelta !== 0) return timeDelta;
    const leftSequence = a.sequence;
    const rightSequence = b.sequence;
    if (leftSequence && rightSequence && leftSequence.prefix === rightSequence.prefix) {
      return leftSequence.number - rightSequence.number;
    }
    return a.source.file_name.localeCompare(b.source.file_name);
  });
  const clusters: ScoredPhoto[][] = [];

  for (const photo of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push([photo]);
      continue;
    }
    if (shouldJoinBurst(current, photo)) {
      current.push(photo);
    } else {
      clusters.push([photo]);
    }
  }

  const bursts = clusters.filter((items) => items.length > 1);
  const burstClusters = bursts.map((items, index) => makeCluster(items, `burst-${index + 1}`, "burst"));

  // Second pass: group visual near-duplicates that the temporal pass missed
  // (e.g. re-shot the same frame minutes apart, or bursts with missing timestamps).
  const usedIds = new Set(bursts.flat().map((item) => item.photo_id));
  const remaining = sorted.filter((item) => !usedIds.has(item.photo_id) && item.embedding);
  const similarClusters = buildSimilarClusters(remaining).map((items, index) =>
    makeCluster(items, `similar-${index + 1}`, "similar"),
  );

  return [...burstClusters, ...similarClusters];
}

function makeCluster(items: ScoredPhoto[], id: string, kind: AutoCullCluster["kind"]): AutoCullCluster {
  const sortedByScore = [...items].sort((a, b) => b.final_score - a.final_score);
  const startTime = minCaptureTimestamp(items);
  const endTime = maxCaptureTimestamp(items);
  const anchor = items[0];
  const similarities = items
    .slice(1)
    .map((item) => (item.embedding && anchor.embedding ? cosineSimilarity(item.embedding, anchor.embedding) : 0))
    .filter((value) => value > 0);
  const averageSimilarity = similarities.length
    ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    : 0.72;
  return {
    id,
    kind,
    confidence: clamp(averageSimilarity, 0.5, 0.99),
    photo_ids: items.map((item) => item.photo_id),
    top_pick_id: sortedByScore[0].photo_id,
    start_time: startTime == null ? undefined : new Date(startTime).toISOString(),
    end_time: endTime == null ? undefined : new Date(endTime).toISOString(),
  };
}

// Greedy visual near-duplicate grouping over photos not already in a temporal burst.
function buildSimilarClusters(items: ScoredPhoto[]): ScoredPhoto[][] {
  if (items.length < 2 || items.length > SIMILAR_PASS_MAX_PHOTOS) return [];
  const used = new Set<string>();
  const groups: ScoredPhoto[][] = [];

  for (let i = 0; i < items.length; i++) {
    const anchor = items[i];
    if (used.has(anchor.photo_id)) continue;
    const group = [anchor];
    for (let j = i + 1; j < items.length; j++) {
      const candidate = items[j];
      if (used.has(candidate.photo_id) || group.length >= MAX_BURST_SIZE) continue;
      if (!sameCamera(anchor, candidate)) continue;
      const similarity = visualSimilarity(anchor, candidate);
      if (similarity != null && similarity >= SIMILAR_CLUSTER_SIMILARITY) {
        group.push(candidate);
        used.add(candidate.photo_id);
      }
    }
    if (group.length > 1) {
      used.add(anchor.photo_id);
      groups.push(group);
    }
  }

  return groups;
}

function shouldJoinBurst(current: ScoredPhoto[], photo: ScoredPhoto): boolean {
  if (current.length >= MAX_BURST_SIZE) return false;

  const previous = current[current.length - 1];
  const anchor = current[0];
  if (!sameCamera(previous, photo)) return false;

  const adjacentSimilarity = visualSimilarity(previous, photo);
  const anchorSimilarity = visualSimilarity(anchor, photo);
  const hasVisualSignal = adjacentSimilarity != null && anchorSimilarity != null;
  const sequenceGap = sequenceGapBetween(previous, photo);
  const sameSequenceRun = sequenceGap != null && sequenceGap > 0 && sequenceGap <= 2;
  const captureGap = captureGapBetween(previous, photo);
  const anchorGap = captureGapBetween(anchor, photo);

  const sequenceBurst = sameSequenceRun
    && adjacentSimilarity != null
    && adjacentSimilarity >= SEQUENCE_VISUAL_SIMILARITY
    && (anchorSimilarity == null || anchorSimilarity >= BURST_VISUAL_SIMILARITY);
  const tightTimedBurst = captureGap != null
    && captureGap <= BURST_WINDOW_MS
    && (anchorGap == null || anchorGap <= 12_000)
    && (!hasVisualSignal || adjacentSimilarity >= 0.62);
  const looseTimedBurst = captureGap != null
    && captureGap <= LOOSE_BURST_WINDOW_MS
    && anchorGap != null
    && anchorGap <= 12_000
    && adjacentSimilarity != null
    && adjacentSimilarity >= BURST_VISUAL_SIMILARITY;

  return sequenceBurst || tightTimedBurst || looseTimedBurst;
}

function visualSimilarity(left: ScoredPhoto, right: ScoredPhoto): number | null {
  if (!left.embedding || !right.embedding) return null;
  return cosineSimilarity(left.embedding, right.embedding);
}

function sameCamera(left: ScoredPhoto, right: ScoredPhoto): boolean {
  const leftCamera = left.source.exif.camera_model;
  const rightCamera = right.source.exif.camera_model;
  if (!leftCamera || !rightCamera) return true;
  return leftCamera === rightCamera;
}

function captureGapBetween(left: ScoredPhoto, right: ScoredPhoto): number | null {
  if (left.captureMs == null || right.captureMs == null) return null;
  return Math.abs(right.captureMs - left.captureMs);
}

function sequenceGapBetween(left: ScoredPhoto, right: ScoredPhoto): number | null {
  if (!left.sequence || !right.sequence) return null;
  if (left.sequence.prefix !== right.sequence.prefix) return null;
  return right.sequence.number - left.sequence.number;
}

function minCaptureTimestamp(items: ScoredPhoto[]): number | null {
  const values = items.map((item) => item.captureMs).filter((value): value is number => value != null);
  return values.length ? Math.min(...values) : null;
}

function maxCaptureTimestamp(items: ScoredPhoto[]): number | null {
  const values = items.map((item) => item.captureMs).filter((value): value is number => value != null);
  return values.length ? Math.max(...values) : null;
}

function behaviorSignal(photo: Photo): number {
  const rating = photo.rating ?? 0;
  const flag = normalizeFlag(photo.flag);
  let signal = 0;
  if (flag === "pick") signal += 0.18;
  if (flag === "reject") signal -= 0.24;
  if (rating > 0) signal += ((rating - 2.5) / 2.5) * 0.14;
  return clamp(signal, -0.3, 0.3);
}

function pointwiseSignal(flag: CullFlag, rating: number): number {
  const ratingSignal = rating > 0 ? rating / 5 : 0.5;
  if (flag === "pick") return clamp01(Math.max(0.78, ratingSignal));
  if (flag === "reject") return clamp01(Math.min(0.18, ratingSignal * 0.35));
  return clamp01(ratingSignal);
}

function recommendationFor(photo: Photo, finalScore: number, personalScore: number): AutoCullLabel {
  const flag = normalizeFlag(photo.flag);
  if (flag === "pick" || (photo.rating ?? 0) >= 4) return "SELECT";
  if (flag === "reject") return "REJECT";
  if (finalScore >= 0.68 || personalScore >= 0.72) return "SELECT";
  if (finalScore < 0.42) return "REJECT";
  if (finalScore < 0.52) return "NEEDS_REVIEW";
  return "MAYBE";
}

function recommendationConfidence(photo: Photo, finalScore: number, embedding: number[] | undefined): number {
  const manualBoost = normalizeFlag(photo.flag) !== "none" || (photo.rating ?? 0) > 0 ? 0.18 : 0;
  const distanceFromMiddle = Math.abs(finalScore - 0.5) * 1.15;
  const embeddingBoost = embedding ? 0.08 : -0.08;
  return clamp(0.45 + distanceFromMiddle + manualBoost + embeddingBoost, 0.25, 0.98);
}

function neutralPersonalScore(technicalScore: number): number {
  return clamp01(0.5 + (technicalScore - 0.5) * 0.02);
}

function blendScores(technicalScore: number, personalScore: number): number {
  return clamp01(technicalScore * 0.35 + personalScore * 0.65);
}

function normalizeFlag(flag: CullFlag | undefined): CullFlag {
  return flag === "pick" || flag === "reject" ? flag : "none";
}

function captureTimestampMs(photo: Photo): number | null {
  return parseTime(photo.exif.date_taken);
}

function sortTimestampMs(photo: Photo): number | null {
  return parseTime(photo.exif.date_taken) ?? parseTime(photo.modified_at);
}

function parseTime(value?: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function filenameSequence(fileName: string): SequenceInfo | null {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const match = stem.match(/^(.*?)(\d{3,})(?:[_-].*)?$/);
  if (!match) return null;
  return {
    prefix: match[1].toLowerCase(),
    number: Number(match[2]),
  };
}

function shutterSeconds(value?: string): number | null {
  if (!value) return null;
  const fraction = value.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator > 0 ? numerator / denominator : null;
  }
  const numeric = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function histogramIndex(channel: number, value: number): number {
  const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(clamp(value, 0, 0.999999) * HISTOGRAM_BINS));
  return channel * HISTOGRAM_BINS + bin;
}

function lumaArray(image: ImageData): number[] {
  const result: number[] = [];
  for (let index = 0; index < image.data.length; index += 4) {
    result.push(
      (0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2]) / 255,
    );
  }
  return result;
}

function lumaAt(luma: number[], width: number, x: number, y: number): number {
  return luma[(y * width) + x] ?? 0;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let product = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    product += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm <= Number.EPSILON || rightNorm <= Number.EPSILON) return 0;
  return clamp(product / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)), -1, 1);
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (norm <= Number.EPSILON) return vector;
  return vector.map((value) => value / norm);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -40, 40)));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function idleTick(): Promise<void> {
  return new Promise((resolve) => {
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleWindow.requestIdleCallback(() => resolve(), { timeout: 250 });
    } else {
      globalThis.setTimeout(resolve, 16);
    }
  });
}
