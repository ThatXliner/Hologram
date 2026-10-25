import { invoke } from "@tauri-apps/api/core";
import type { AutoCullLearner } from "./types.ts";
import type { PairwiseExample, RankedExample } from "./autocull.ts";

export const NATIVE_RANKER_VERSION = "xgboost-personal-ranker-v1";
const LEARNER_KEY = "hologram.autocull.learner.v1";
const MAX_NATIVE_FEATURE_CELLS = 4_000_000;

function validateNativeSize(pointwiseRows: number, pairCount: number, predictionRows: number, dimensions: number): void {
  if ((pointwiseRows + pairCount * 2 + predictionRows) * dimensions > MAX_NATIVE_FEATURE_CELLS) {
    throw new Error("Native analysis is too large. Use the built-in learner or analyze a smaller folder.");
  }
}

export interface NativeRankerRequest {
  schema_version: 1;
  dimensions: number;
  pointwise: { features: number[]; target: number; weight: number }[];
  pairs: { winner: number[]; loser: number[]; weight: number }[];
  predict: number[][];
}

export interface NativeRankerResponse {
  schema_version: 1;
  xgboost_version: "3.1.1";
  ranker_version: typeof NATIVE_RANKER_VERSION;
  scores: (number | null)[];
  base_margin: number;
  training_rows: number;
  train_ms: number;
  predict_ms: number;
}

export function loadAutoCullLearner(): AutoCullLearner {
  try {
    return localStorage.getItem(LEARNER_KEY) === "xgboost-native" ? "xgboost-native" : "builtin";
  } catch { return "builtin"; }
}

export function saveAutoCullLearner(learner: AutoCullLearner): void {
  localStorage.setItem(LEARNER_KEY, learner);
}

export function nativeLearnerAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function nativeRankerRequest(examples: RankedExample[], pairs: PairwiseExample[], predict: number[][]): NativeRankerRequest {
  validateNativeSize(examples.length, pairs.length, predict.length, 267);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return {
    schema_version: 1,
    dimensions: 267,
    pointwise: examples.map((example) => ({ features: example.features, target: clamp(example.signal, 0.03, 0.97), weight: clamp(example.confidence, 0.05, 2) })),
    pairs: pairs.map((pair) => ({ winner: pair.winnerFeatures, loser: pair.loserFeatures, weight: clamp(pair.confidence * 0.9, 0.05, 1.4) })),
    predict,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid native learner response");
  return Object.fromEntries(Object.entries(value));
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Native learner returned a non-finite number");
  return value;
}

export function parseNativeRankerResponse(value: unknown, request: NativeRankerRequest): NativeRankerResponse {
  const response = record(value);
  if (response.schema_version !== 1 || response.xgboost_version !== "3.1.1" || response.ranker_version !== NATIVE_RANKER_VERSION) {
    throw new Error("Native learner version does not match this build");
  }
  const trainingRows = request.pointwise.length + request.pairs.length * 2;
  if (response.training_rows !== trainingRows || !Array.isArray(response.scores) || response.scores.length !== request.predict.length) {
    throw new Error("Native learner returned an unexpected prediction shape");
  }
  const scores = response.scores.map((value: unknown) => {
    if (value === null && trainingRows === 0) return null;
    const score = finite(value);
    if (score < 0 || score > 1) throw new Error("Native learner returned an invalid score");
    return score;
  });
  const train_ms = finite(response.train_ms), predict_ms = finite(response.predict_ms);
  if (train_ms < 0 || predict_ms < 0) throw new Error("Native learner returned invalid timing");
  return { schema_version: 1, xgboost_version: "3.1.1", ranker_version: NATIVE_RANKER_VERSION, training_rows: trainingRows,
    scores, base_margin: finite(response.base_margin), train_ms, predict_ms };
}

export async function scoreNativeRanker(request: NativeRankerRequest): Promise<NativeRankerResponse> {
  validateNativeSize(request.pointwise.length, request.pairs.length, request.predict.length, request.dimensions);
  const response: unknown = await invoke("score_autocull_native", { request });
  return parseNativeRankerResponse(response, request);
}
