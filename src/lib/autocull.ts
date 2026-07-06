import { convertFileSrc } from "@tauri-apps/api/core";
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

const EMBEDDING_BACKEND = "visual-hybrid32-v2";
const RANKER_VERSION = "behavior-linear-ranker-v2";
const SPATIAL_GRID = 32;
const HISTOGRAM_BINS = 16;
const SAMPLE_SIZE = 160;
const BURST_WINDOW_MS = 3_500;
const SIMILARITY_THRESHOLD = 0.94;
const TRAINING_EPOCHS = 80;
const LEARNING_RATE = 0.04;
const L2_REGULARIZATION = 0.0004;

const browserPreviewTypes = new Set(["JPEG", "JPG", "PNG", "WEBP", "GIF"]);

type PixelFeatures = {
  embedding: number[];
  technicalScore: number;
};

type RankedExample = {
  vector: number[];
  signal: number;
  confidence: number;
};

type PairwiseExample = {
  winner: number[];
  loser: number[];
  confidence: number;
};

type ScoredPhoto = AutoCullPhoto & {
  source: Photo;
  timestampMs: number | null;
};

type RankingModel = {
  score: (embedding: number[] | undefined) => number | null;
  examples: RankedExample[];
};

export function photoPreviewSrc(photo: Photo): string {
  if (photo.thumbnail) {
    const mime = photo.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${photo.thumbnail}`;
  }
  if (!browserPreviewTypes.has(photo.file_type.toUpperCase())) return "";
  try {
    return convertFileSrc(photo.file_path);
  } catch {
    return "";
  }
}

export function pairwisePreferenceKey(folderPath: string | null): string {
  return `hologram.autocull.pairwise.${folderPath?.trim() || "global"}`;
}

export function loadPairwisePreferences(folderPath: string | null): AutoCullPairwisePreference[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(pairwisePreferenceKey(folderPath));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPairwisePreference) : [];
  } catch {
    return [];
  }
}

export function savePairwisePreferences(
  folderPath: string | null,
  preferences: AutoCullPairwisePreference[],
) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(pairwisePreferenceKey(folderPath), JSON.stringify(dedupePairwise(preferences)));
}

export function addPairwisePreferences(
  folderPath: string | null,
  preferences: AutoCullPairwisePreference[],
) {
  savePairwisePreferences(folderPath, [
    ...loadPairwisePreferences(folderPath),
    ...preferences,
  ]);
}

export async function buildAutoCullSession(
  photos: Photo[],
  preferences: AutoCullPairwisePreference[] = [],
  onProgress: (progress: VisualIndexProgress) => void = () => {},
): Promise<AutoCullSession> {
  const featuresById = new Map<string, PixelFeatures | null>();
  const total = photos.length;

  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    onProgress({ current: index, total, current_file: photo.file_name });
    await idleTick();
    featuresById.set(photo.id, await extractPixelFeatures(photo));
  }

  const examples = buildRankedExamples(photos, featuresById);
  const pairwiseExamples = buildPairwiseExamples(preferences, featuresById);
  const model = trainRankingModel(examples, pairwiseExamples);

  let scored = photos.map((photo) => {
    const pixelFeatures = featuresById.get(photo.id);
    const technicalScore = pixelFeatures?.technicalScore ?? fallbackTechnicalScore(photo);
    const embedding = pixelFeatures?.embedding;
    const behaviorSignalValue = behaviorSignal(photo);
    const neutral = neutralPersonalScore(technicalScore);
    const linearDelta = model.score(embedding);
    const learnedDelta = nearestNeighborDelta(embedding, model.examples);
    const personalScore = clamp01(
      neutral
        + (linearDelta == null ? 0 : (linearDelta - 0.5) * 0.72)
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
      embedding_backend: embedding ? EMBEDDING_BACKEND : undefined,
      timestampMs: timestampMs(photo),
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

  const outputPhotos: AutoCullPhoto[] = scored.map(({ source: _source, timestampMs: _timestampMs, ...photo }) => photo);
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

async function extractPixelFeatures(photo: Photo): Promise<PixelFeatures | null> {
  const src = photoPreviewSrc(photo);
  if (!src || typeof document === "undefined") return null;

  try {
    const image = await loadImage(src);
    const grid = drawImageData(image, SPATIAL_GRID, SPATIAL_GRID);
    const sample = drawImageData(image, SAMPLE_SIZE, SAMPLE_SIZE);
    return {
      embedding: imageEmbedding(grid, sample, image.naturalWidth || image.width, image.naturalHeight || image.height),
      technicalScore: estimateTechnicalScore(sample),
    };
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Preview could not be decoded"));
    image.src = src;
  });
}

function drawImageData(image: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function imageEmbedding(grid: ImageData, sample: ImageData, sourceWidth: number, sourceHeight: number): number[] {
  const vector: number[] = [];
  appendRgbGrid(vector, grid);
  appendEdgeGrid(vector, grid);
  appendHistograms(vector, sample);
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

function buildRankedExamples(photos: Photo[], featuresById: Map<string, PixelFeatures | null>): RankedExample[] {
  const examples: RankedExample[] = [];
  for (const photo of photos) {
    const vector = featuresById.get(photo.id)?.embedding;
    if (!vector) continue;
    const rating = photo.rating ?? 0;
    const flag = normalizeFlag(photo.flag);
    if (flag === "none" && rating <= 0) continue;
    examples.push({
      vector,
      signal: pointwiseSignal(flag, rating),
      confidence: flag === "none" ? 0.62 : 1,
    });
  }
  return examples;
}

function buildPairwiseExamples(
  preferences: AutoCullPairwisePreference[],
  featuresById: Map<string, PixelFeatures | null>,
): PairwiseExample[] {
  const examples: PairwiseExample[] = [];
  for (const preference of preferences) {
    const winner = featuresById.get(preference.winner_photo_id)?.embedding;
    const loser = featuresById.get(preference.loser_photo_id)?.embedding;
    if (!winner || !loser || winner.length !== loser.length) continue;
    examples.push({
      winner,
      loser,
      confidence: clamp(preference.confidence, 0.1, 1.25),
    });
  }
  return examples;
}

function trainRankingModel(examples: RankedExample[], pairwiseExamples: PairwiseExample[]): RankingModel {
  const dimensions = examples[0]?.vector.length ?? pairwiseExamples[0]?.winner.length ?? 0;
  const usableExamples = examples.filter((example) => example.vector.length === dimensions);
  const usablePairwiseExamples = pairwiseExamples.filter(
    (example) => example.winner.length === dimensions && example.loser.length === dimensions,
  );
  if (!dimensions || (usableExamples.length === 0 && usablePairwiseExamples.length === 0)) {
    return { examples: usableExamples, score: () => null };
  }

  const weights = Array.from({ length: dimensions }, () => 0);
  let bias = 0;

  for (let epoch = 0; epoch < TRAINING_EPOCHS; epoch++) {
    for (const example of usableExamples) {
      const prediction = sigmoid(bias + dot(weights, example.vector));
      const error = (prediction - clamp01(example.signal)) * example.confidence;
      for (let index = 0; index < weights.length; index++) {
        weights[index] -= LEARNING_RATE * (error * example.vector[index] + L2_REGULARIZATION * weights[index]);
      }
      bias -= LEARNING_RATE * error;
    }

    for (const example of usablePairwiseExamples) {
      let score = 0;
      for (let index = 0; index < weights.length; index++) {
        score += weights[index] * (example.winner[index] - example.loser[index]);
      }
      const error = (sigmoid(score) - 1) * example.confidence;
      for (let index = 0; index < weights.length; index++) {
        const diff = example.winner[index] - example.loser[index];
        weights[index] -= LEARNING_RATE * (error * diff + L2_REGULARIZATION * weights[index]);
      }
    }
  }

  const trained = Math.abs(bias) > Number.EPSILON || weights.some((weight) => Math.abs(weight) > Number.EPSILON);
  return {
    examples: usableExamples,
    score: (embedding) => {
      if (!trained || !embedding || embedding.length !== weights.length) return null;
      return sigmoid(bias + dot(weights, embedding));
    },
  };
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
    const timeDelta = (a.timestampMs ?? Number.MAX_SAFE_INTEGER) - (b.timestampMs ?? Number.MAX_SAFE_INTEGER);
    if (timeDelta !== 0) return timeDelta;
    return a.source.file_name.localeCompare(b.source.file_name);
  });
  const clusters: ScoredPhoto[][] = [];

  for (const photo of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push([photo]);
      continue;
    }
    const previous = current[current.length - 1];
    const timeGap = photo.timestampMs != null && previous.timestampMs != null
      ? Math.abs(photo.timestampMs - previous.timestampMs)
      : Number.POSITIVE_INFINITY;
    const visualMatch = photo.embedding && current[0]?.embedding
      ? cosineSimilarity(photo.embedding, current[0].embedding) >= SIMILARITY_THRESHOLD
      : false;
    const sameCamera = !photo.source.exif.camera_model
      || !previous.source.exif.camera_model
      || photo.source.exif.camera_model === previous.source.exif.camera_model;

    if ((timeGap <= BURST_WINDOW_MS && sameCamera) || visualMatch) {
      current.push(photo);
    } else {
      clusters.push([photo]);
    }
  }

  return clusters.map((items, index) => {
    const sortedByScore = [...items].sort((a, b) => b.final_score - a.final_score);
    const startTime = minTimestamp(items);
    const endTime = maxTimestamp(items);
    const timeSpan = startTime != null && endTime != null ? endTime - startTime : null;
    const similarities = items
      .slice(1)
      .map((item) => item.embedding && items[0].embedding ? cosineSimilarity(item.embedding, items[0].embedding) : 0)
      .filter((value) => value > 0);
    const averageSimilarity = similarities.length
      ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
      : 1;
    const kind: AutoCullCluster["kind"] = items.length <= 1
      ? "single"
      : timeSpan != null && timeSpan <= 10_000
        ? "burst"
        : "similar";
    return {
      id: `${kind}-${index + 1}`,
      kind,
      confidence: items.length <= 1 ? 0.5 : clamp(averageSimilarity, 0.5, 0.99),
      photo_ids: items.map((item) => item.photo_id),
      top_pick_id: sortedByScore[0].photo_id,
      start_time: startTime == null ? undefined : new Date(startTime).toISOString(),
      end_time: endTime == null ? undefined : new Date(endTime).toISOString(),
    };
  });
}

function minTimestamp(items: ScoredPhoto[]): number | null {
  const values = items.map((item) => item.timestampMs).filter((value): value is number => value != null);
  return values.length ? Math.min(...values) : null;
}

function maxTimestamp(items: ScoredPhoto[]): number | null {
  const values = items.map((item) => item.timestampMs).filter((value): value is number => value != null);
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

function timestampMs(photo: Photo): number | null {
  const value = photo.exif.date_taken || photo.created_at || photo.modified_at;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
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

function dot(left: number[], right: number[]): number {
  let result = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    result += left[index] * right[index];
  }
  return result;
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
