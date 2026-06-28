import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  ObjectDetectionBox,
  ObjectDetectionModelManifest,
  ObjectDetectionModelProgress,
  ObjectDetectionModelState,
  Photo,
} from "./types.ts";

const MODEL_STATE_KEY = "hologram.objectDetectionModel.state";
const MODEL_CACHE_KEY = "hologram-object-detection-models";

export const objectDetectionModelManifest: ObjectDetectionModelManifest = {
  id: "xenova-yolos-tiny-q8",
  name: "YOLOS Tiny",
  repository: "Xenova/yolos-tiny",
  version: "main/q8",
  source_name: "Hugging Face / Xenova YOLOS Tiny",
  source_url: "https://huggingface.co/Xenova/yolos-tiny",
  download_url: "https://huggingface.co/Xenova/yolos-tiny/resolve/main/onnx/model_quantized.onnx",
  approximate_size_bytes: 9_700_000,
  license: "Apache-2.0 upstream model license",
  dtype: "q8",
  storage_label: "Transformers.js browser model cache / hologram-object-detection-models",
};

type Detector = (image: string, options: { threshold: number; percentage: true }) => Promise<RawDetection[]>;

type RawDetection = {
  label: string;
  score: number;
  box: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
};

type TransformersProgress = {
  status: "initiate" | "download" | "progress" | "done" | "ready" | "progress_total";
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
};

const browserPreviewTypes = new Set(["JPEG", "JPG", "PNG", "WEBP", "GIF"]);
let detectorPromise: Promise<Detector> | null = null;

const defaultState: ObjectDetectionModelState = {
  status: "not_downloaded",
  manifest_id: objectDetectionModelManifest.id,
  version: objectDetectionModelManifest.version,
};

function canUseBrowserStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function persistObjectDetectionModelState(state: ObjectDetectionModelState) {
  if (!canUseBrowserStorage()) return;
  localStorage.setItem(MODEL_STATE_KEY, JSON.stringify(state));
}

function progress(
  phase: ObjectDetectionModelProgress["phase"],
  receivedBytes: number,
  totalBytes = objectDetectionModelManifest.approximate_size_bytes,
): ObjectDetectionModelProgress {
  const safeTotal = totalBytes > 0 ? totalBytes : objectDetectionModelManifest.approximate_size_bytes;
  return {
    phase,
    received_bytes: receivedBytes,
    total_bytes: safeTotal,
    percent: Math.max(0, Math.min(100, Math.round((receivedBytes / safeTotal) * 100))),
  };
}

function dataUrlForPhoto(photo: Photo): string {
  if (photo.thumbnail) {
    const mime = photo.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${photo.thumbnail}`;
  }
  if (browserPreviewTypes.has(photo.file_type.toUpperCase())) {
    try {
      return convertFileSrc(photo.file_path);
    } catch {
      return "";
    }
  }
  return "";
}

async function cachedModelPresent(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(MODEL_CACHE_KEY);
    const keys = await cache.keys();
    return keys.some((request) => (
      request.url.includes(objectDetectionModelManifest.repository) ||
      request.url.includes("model_quantized.onnx") ||
      request.url.includes("preprocessor_config.json")
    ));
  } catch {
    return false;
  }
}

function toPercent(value: number): number {
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

function normalizeBox(detection: RawDetection, index: number): ObjectDetectionBox {
  const x0 = toPercent(detection.box.xmin);
  const y0 = toPercent(detection.box.ymin);
  const x1 = toPercent(detection.box.xmax);
  const y1 = toPercent(detection.box.ymax);
  return {
    id: `${objectDetectionModelManifest.id}-${detection.label}-${index}`,
    label: titleCaseLabel(detection.label),
    confidence: detection.score,
    source: "model",
    model_id: objectDetectionModelManifest.id,
    box: {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.max(1, Math.abs(x1 - x0)),
      height: Math.max(1, Math.abs(y1 - y0)),
    },
  };
}

function titleCaseLabel(label: string): string {
  return label.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function toModelProgress(info: TransformersProgress): ObjectDetectionModelProgress | null {
  if (info.status === "ready") {
    return progress("ready", objectDetectionModelManifest.approximate_size_bytes);
  }
  if (info.status === "progress_total" || info.status === "progress") {
    return progress(
      "downloading",
      info.loaded ?? 0,
      info.total ?? objectDetectionModelManifest.approximate_size_bytes,
    );
  }
  if (info.status === "download") return progress("downloading", 0);
  if (info.status === "done") return progress("storing", objectDetectionModelManifest.approximate_size_bytes);
  if (info.status === "initiate") return progress("requesting", 0);
  return null;
}

async function loadDetector(
  onProgress?: (next: ObjectDetectionModelProgress) => void,
  allowDownload = false,
): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = allowDownload;
      env.useBrowserCache = true;
      env.useCustomCache = false;
      env.cacheKey = MODEL_CACHE_KEY;

      return await pipeline("object-detection", objectDetectionModelManifest.repository, {
        dtype: objectDetectionModelManifest.dtype as "q8",
        local_files_only: !allowDownload,
        progress_callback: (info: TransformersProgress) => {
          const next = toModelProgress(info);
          if (next) onProgress?.(next);
        },
      }) as Detector;
    })();
  }
  return detectorPromise;
}

export function formatModelBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

export function loadObjectDetectionModelState(): ObjectDetectionModelState {
  if (!canUseBrowserStorage()) return defaultState;
  try {
    const raw = localStorage.getItem(MODEL_STATE_KEY);
    if (!raw) return defaultState;
    const state = JSON.parse(raw) as ObjectDetectionModelState;
    if (
      state.manifest_id !== objectDetectionModelManifest.id ||
      state.version !== objectDetectionModelManifest.version
    ) {
      return defaultState;
    }
    return state;
  } catch {
    return defaultState;
  }
}

export async function validateObjectDetectionModelState(): Promise<ObjectDetectionModelState> {
  const state = loadObjectDetectionModelState();
  if (state.status !== "ready") return state;
  if (await cachedModelPresent()) return state;

  const missingModel: ObjectDetectionModelState = {
    ...defaultState,
    last_error: "The local object detection model cache is missing.",
  };
  persistObjectDetectionModelState(missingModel);
  return missingModel;
}

export async function downloadObjectDetectionModel(
  onProgress: (next: ObjectDetectionModelProgress) => void,
): Promise<ObjectDetectionModelState> {
  const downloading: ObjectDetectionModelState = {
    ...defaultState,
    status: "downloading",
  };
  persistObjectDetectionModelState(downloading);
  onProgress(progress("requesting", 0));

  try {
    await loadDetector(onProgress, true);
    const ready: ObjectDetectionModelState = {
      status: "ready",
      manifest_id: objectDetectionModelManifest.id,
      version: objectDetectionModelManifest.version,
      downloaded_at: new Date().toISOString(),
      bytes: objectDetectionModelManifest.approximate_size_bytes,
      cache_key: objectDetectionModelManifest.repository,
    };
    persistObjectDetectionModelState(ready);
    onProgress(progress("ready", ready.bytes ?? objectDetectionModelManifest.approximate_size_bytes));
    return ready;
  } catch (error) {
    detectorPromise = null;
    const failed: ObjectDetectionModelState = {
      ...defaultState,
      status: "error",
      last_error: error instanceof Error ? error.message : String(error),
    };
    persistObjectDetectionModelState(failed);
    onProgress({ ...progress("error", 0), percent: 0 });
    throw error;
  }
}

export async function detectObjectsInPhoto(photo: Photo): Promise<ObjectDetectionBox[]> {
  const src = dataUrlForPhoto(photo);
  if (!src) return [];
  const detector = await loadDetector(undefined, false);
  const output = await detector(src, { threshold: 0.5, percentage: true });
  return output
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((detection, index) => normalizeBox(detection, index));
}

export async function deleteObjectDetectionModel(): Promise<ObjectDetectionModelState> {
  detectorPromise = null;
  if (typeof caches !== "undefined") {
    await caches.delete(MODEL_CACHE_KEY);
  }
  if (canUseBrowserStorage()) {
    localStorage.removeItem(MODEL_STATE_KEY);
  }
  return defaultState;
}
