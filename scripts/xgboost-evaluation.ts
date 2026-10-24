import { trainRankingModel, PREFERENCE_FEATURE_VERSION } from '../src/lib/autocull.ts';

export const FEATURE_VERSION = PREFERENCE_FEATURE_VERSION;
export const BACKENDS = ['perceptual-dct-focus-v4', 'dinov2-small-transformersjs+perceptual-dct-focus-v4'];
export const DIMENSIONS = 267;
export const SCORE_TIE_TOLERANCE = 1e-6;
type Provenance = 'manual' | 'automatic';
export interface EvaluationDataset {
  schema_version: 1;
  kind: 'human' | 'synthetic';
  feature_version: string;
  backend: string;
  profile_id: string;
  shoots: string[];
  photos: { id: string; shootId: string; features: number[] }[];
  pointwise: { photoId: string; signal: number; confidence: number; provenance: Provenance }[];
  pairs: { winnerId: string; loserId: string; confidence: number; provenance: Provenance }[];
}
export interface NativeInput {
  schema_version: 1;
  dimensions: number;
  pointwise: { features: number[]; target: number; weight: number }[];
  pairs: { winner: number[]; loser: number[]; weight: number }[];
  predict: number[][];
}
export interface ModelResult { scores: (number | null)[]; train_ms: number; predict_ms: number; xgboost_version?: string }
export interface EvaluationFold {
  shootId: string;
  trainPhotoIds: string[];
  testPhotoIds: string[];
  input: NativeInput;
  pointwise: { index: number; target: number }[];
  pairs: { winner: number; loser: number }[];
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty string');
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite number');
  return value;
}
function bounded(value: unknown, min: number, max: number): number {
  const number = finite(value);
  if (number < min || number > max) throw new Error(`Expected number in [${min}, ${max}]`);
  return number;
}
function provenance(value: unknown): Provenance {
  if (value !== 'manual' && value !== 'automatic') throw new Error('Invalid provenance');
  return value;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some(key => !expected.includes(key))) throw new Error('Unexpected field; each dataset must contain one profile, backend, and feature version');
}
export function parseDataset(value: unknown): EvaluationDataset {
  const data = object(value);
  keys(data, ['schema_version', 'kind', 'feature_version', 'backend', 'profile_id', 'shoots', 'photos', 'pointwise', 'pairs']);
  if (data.schema_version !== 1 || data.feature_version !== FEATURE_VERSION) throw new Error('Unsupported schema or feature version');
  if (data.kind !== 'human' && data.kind !== 'synthetic') throw new Error('Declare dataset kind human or synthetic');
  const backend = text(data.backend);
  if (!BACKENDS.includes(backend)) throw new Error('Unsupported feature backend');
  const shoots = array(data.shoots).map(text);
  if (shoots.length < 2 || new Set(shoots).size !== shoots.length) throw new Error('Need at least two unique shoots');
  const photos = array(data.photos).map(value => {
    const photo = object(value);
    keys(photo, ['id', 'shootId', 'features']);
    const features = array(photo.features).map(value => bounded(value, -3.4028234663852886e38, 3.4028234663852886e38));
    if (features.length !== DIMENSIONS) throw new Error(`Expected ${DIMENSIONS} features`);
    const shootId = text(photo.shootId);
    if (!shoots.includes(shootId)) throw new Error('Photo references unknown shoot');
    return { id: text(photo.id), shootId, features };
  });
  const byId = new Map(photos.map(photo => [photo.id, photo]));
  if (byId.size !== photos.length) throw new Error('Duplicate photo identity');
  if (shoots.some(id => !photos.some(photo => photo.shootId === id))) throw new Error('Every shoot needs photos');
  const pointwise = array(data.pointwise).map(value => {
    const row = object(value);
    keys(row, ['photoId', 'signal', 'confidence', 'provenance']);
    const photoId = text(row.photoId);
    if (!byId.has(photoId)) throw new Error('Pointwise references unknown photo');
    return { photoId, signal: bounded(row.signal, 0, 1), confidence: bounded(row.confidence, 0.05, 2), provenance: provenance(row.provenance) };
  });
  if (new Set(pointwise.map(row => row.photoId)).size !== pointwise.length) throw new Error('Duplicate pointwise identity');
  const pairs = array(data.pairs).map(value => {
    const row = object(value);
    keys(row, ['winnerId', 'loserId', 'confidence', 'provenance']);
    const winnerId = text(row.winnerId), loserId = text(row.loserId);
    if (!byId.has(winnerId) || !byId.has(loserId) || winnerId === loserId) throw new Error('Invalid pair references');
    return { winnerId, loserId, confidence: bounded(row.confidence, 0.1, 1.25), provenance: provenance(row.provenance) };
  });
  if (new Set(pairs.map(row => JSON.stringify([row.winnerId, row.loserId].sort()))).size !== pairs.length) throw new Error('Duplicate pair identity');
  const dataset: EvaluationDataset = { schema_version: 1, kind: data.kind, feature_version: FEATURE_VERSION, backend, profile_id: text(data.profile_id), shoots, photos, pointwise, pairs };
  if (!buildFolds(dataset).some(fold => fold.pointwise.length || fold.pairs.length)) throw new Error('Dataset needs held-out manual choices');
  return dataset;
}
export function buildFolds(data: EvaluationDataset): EvaluationFold[] {
  const byId = new Map(data.photos.map(photo => [photo.id, photo]));
  const photo = (id: string) => {
    const result = byId.get(id);
    if (!result) throw new Error('Unknown photo');
    return result;
  };
  return data.shoots.map(shootId => {
    const train = data.photos.filter(photo => photo.shootId !== shootId);
    const test = data.photos.filter(photo => photo.shootId === shootId);
    const index = new Map(test.map((photo, index) => [photo.id, index]));
    const testIndex = (id: string) => {
      const result = index.get(id);
      if (result === undefined) throw new Error('Test photo missing');
      return result;
    };
    const manualPoints = data.pointwise.filter(row => row.provenance === 'manual');
    const manualPairs = data.pairs.filter(row => row.provenance === 'manual');
    return {
      shootId, trainPhotoIds: train.map(photo => photo.id), testPhotoIds: test.map(photo => photo.id),
      input: {
        schema_version: 1, dimensions: DIMENSIONS,
        pointwise: manualPoints.filter(row => photo(row.photoId).shootId !== shootId).map(row => ({ features: photo(row.photoId).features, target: row.signal, weight: row.confidence })),
        pairs: manualPairs.filter(row => photo(row.winnerId).shootId !== shootId && photo(row.loserId).shootId !== shootId).map(row => ({ winner: photo(row.winnerId).features, loser: photo(row.loserId).features, weight: row.confidence })),
        predict: test.map(photo => photo.features),
      },
      pointwise: manualPoints.filter(row => index.has(row.photoId) && row.signal !== 0.5).map(row => ({ index: testIndex(row.photoId), target: row.signal })),
      pairs: manualPairs.filter(row => index.has(row.winnerId) && index.has(row.loserId)).map(row => ({ winner: testIndex(row.winnerId), loser: testIndex(row.loserId) })),
    };
  });
}
export function prepareNativeInput(input: NativeInput): NativeInput {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return { ...input,
    pointwise: input.pointwise.map(row => ({ ...row, target: clamp(row.target, 0.03, 0.97), weight: clamp(row.weight, 0.05, 2) })),
    pairs: input.pairs.map(row => ({ ...row, weight: clamp(row.weight * 0.9, 0.05, 1.4) })),
  };
}
export function runProduction(input: NativeInput): ModelResult {
  const start = performance.now();
  const model = trainRankingModel(input.pointwise.map(row => ({ vector: [], features: row.features, signal: row.target, confidence: row.weight })), input.pairs.map(row => ({ winnerFeatures: row.winner, loserFeatures: row.loser, confidence: row.weight })));
  const trained = performance.now();
  const scores = input.predict.map(features => model.score(features));
  return { scores, train_ms: trained - start, predict_ms: performance.now() - trained };
}
export function parseModelResult(value: unknown, count: number): ModelResult {
  const result = object(value);
  if (result.schema_version !== 1 || result.xgboost_version !== "3.1.1") throw new Error("Unsupported native schema or XGBoost version");
  const scores = array(result.scores).map(value => value === null ? null : bounded(value, 0, 1));
  if (scores.length !== count) throw new Error('Native prediction count mismatch');
  return { scores, xgboost_version: text(result.xgboost_version), train_ms: bounded(result.train_ms, 0, Number.MAX_VALUE), predict_ms: bounded(result.predict_ms, 0, Number.MAX_VALUE) };
}
export function agreement(fold: EvaluationFold, result: ModelResult) {
  let pointwiseCredit = 0, pointwiseCount = 0, pairCredit = 0, pairCount = 0;
  for (const row of fold.pointwise) {
    const score = result.scores[row.index];
    if (score === null || score === undefined) continue;
    pointwiseCount++;
    pointwiseCredit += Math.abs(score - 0.5) <= SCORE_TIE_TOLERANCE ? 0.5 : Number((score > 0.5) === (row.target > 0.5));
  }
  for (const row of fold.pairs) {
    const winner = result.scores[row.winner], loser = result.scores[row.loser];
    if (winner === null || winner === undefined || loser === null || loser === undefined) continue;
    pairCount++;
    pairCredit += Math.abs(winner - loser) <= SCORE_TIE_TOLERANCE ? 0.5 : Number(winner > loser);
  }
  return { pointwiseCredit, pointwiseCount, pairCredit, pairCount, pointwiseTotal: fold.pointwise.length, pairTotal: fold.pairs.length };
}
export function syntheticDataset(): EvaluationDataset {
  const shoots = ['shoot-a', 'shoot-b', 'shoot-c', 'shoot-d'];
  const photos = shoots.flatMap((shootId, shoot) => Array.from({ length: 8 }, (_, index) => ({ id: `${shootId}-${index}`, shootId, features: Array.from({ length: DIMENSIONS }, (_, dimension) => dimension === 0 ? index / 7 : dimension === 1 ? shoot / 3 : 0) })));
  return parseDataset({ schema_version: 1, kind: 'synthetic', feature_version: FEATURE_VERSION, backend: BACKENDS[0], profile_id: 'synthetic-default', shoots, photos,
    pointwise: photos.map((photo, index) => ({ photoId: photo.id, signal: index % 8 >= 4 ? 0.95 : 0.05, confidence: 1, provenance: 'manual' })),
    pairs: shoots.map(shoot => ({ winnerId: `${shoot}-7`, loserId: `${shoot}-0`, confidence: 1, provenance: 'manual' })),
  });
}
