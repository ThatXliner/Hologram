import { convertFileSrc } from "@tauri-apps/api/core";
import type { ObjectDetectionBox, Photo, VisualIndexEntry, VisualIndexLabel, VisualIndexProgress } from "./types.ts";

type VisualIndexOptions = {
  detectorReady?: boolean;
  detectorModelId?: string;
  detectObjects?: (photo: Photo) => Promise<ObjectDetectionBox[]>;
};

type LabelSeed = {
  label: string;
  kind: VisualIndexLabel["kind"];
  tokens: string[];
};

const metadataSeeds: LabelSeed[] = [
  { label: "People", kind: "object", tokens: ["person", "people", "portrait", "selfie", "family", "wedding", "couple", "child", "kid"] },
  { label: "Animals", kind: "object", tokens: ["animal", "dog", "cat", "bird", "horse", "wildlife", "deer", "bear", "pet"] },
  { label: "Vehicles", kind: "object", tokens: ["car", "truck", "motorcycle", "bike", "bicycle", "vehicle", "plane", "train", "boat"] },
  { label: "Flowers", kind: "object", tokens: ["flower", "flowers", "rose", "tulip", "bloom", "macro"] },
  { label: "Food", kind: "object", tokens: ["food", "meal", "dinner", "lunch", "coffee", "drink", "dessert"] },
  { label: "Mountains", kind: "scene", tokens: ["mountain", "mountains", "alpine", "summit", "trail", "hike"] },
  { label: "Beach", kind: "scene", tokens: ["beach", "ocean", "sea", "coast", "shore", "surf"] },
  { label: "City", kind: "scene", tokens: ["city", "street", "urban", "downtown", "skyline", "architecture"] },
  { label: "Night", kind: "scene", tokens: ["night", "astro", "stars", "moon", "milky"] },
  { label: "Sunset", kind: "scene", tokens: ["sunset", "sunrise", "golden", "dusk", "dawn"] },
];

const browserPreviewTypes = new Set(["JPEG", "JPG", "PNG", "WEBP", "GIF"]);

function photoText(photo: Photo): string {
  return [
    photo.file_name,
    ...(photo.tags ?? []),
    photo.notes,
  ].filter(Boolean).join(" ").toLowerCase();
}

function addLabel(labels: Map<string, VisualIndexLabel>, label: VisualIndexLabel) {
  const current = labels.get(label.label);
  if (!current || label.confidence > current.confidence) {
    labels.set(label.label, label);
  }
}

function addDetectionLabels(labels: Map<string, VisualIndexLabel>, detections: ObjectDetectionBox[]) {
  const grouped = new Map<string, ObjectDetectionBox[]>();
  for (const detection of detections) {
    grouped.set(detection.label, [...(grouped.get(detection.label) ?? []), detection]);
  }

  for (const [label, boxes] of grouped) {
    const best = boxes.reduce((max, box) => Math.max(max, box.confidence), 0);
    addLabel(labels, {
      label,
      kind: "object",
      confidence: best,
      source: "model",
      reason: `The local object detector found ${boxes.length} ${label.toLowerCase()} ${boxes.length === 1 ? "box" : "boxes"} in the frame.`,
      evidence: boxes.map((box) => `${Math.round(box.confidence * 100)}% ${box.label}`).slice(0, 4),
      boxes,
    });
  }
}

function metadataLabels(photo: Photo): VisualIndexLabel[] {
  const text = photoText(photo);
  const labels = new Map<string, VisualIndexLabel>();
  for (const seed of metadataSeeds) {
    const matches = seed.tokens.filter((token) => text.includes(token));
    if (matches.length > 0) {
      addLabel(labels, {
        label: seed.label,
        kind: seed.kind,
        confidence: 0.72,
        source: "metadata",
        reason: "Matched filename, tags, or notes that describe the subject.",
        evidence: matches.slice(0, 3),
      });
    }
  }
  if ((photo.exif.focal_length ?? 0) >= 85) {
    addLabel(labels, {
      label: "Telephoto",
      kind: "visual",
      confidence: 0.64,
      source: "metadata",
      reason: "The EXIF focal length is in a telephoto range.",
      evidence: [`${Math.round(photo.exif.focal_length ?? 0)}mm`],
    });
  }
  if ((photo.exif.aperture ?? 99) <= 2.8) {
    addLabel(labels, {
      label: "Shallow Depth",
      kind: "visual",
      confidence: 0.62,
      source: "metadata",
      reason: "The EXIF aperture suggests a shallow depth of field.",
      evidence: [`f/${(photo.exif.aperture ?? 0).toFixed(1)}`],
    });
  }
  if ((photo.exif.iso ?? 0) >= 3200) {
    addLabel(labels, {
      label: "Low Light",
      kind: "scene",
      confidence: 0.6,
      source: "metadata",
      reason: "The EXIF ISO is high enough to suggest a dim scene.",
      evidence: [`ISO ${photo.exif.iso}`],
    });
  }
  return Array.from(labels.values());
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

async function imageLabels(photo: Photo): Promise<VisualIndexLabel[]> {
  const src = dataUrlForPhoto(photo);
  if (!src || typeof document === "undefined") return [];

  const image = await loadImage(src);
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(image, 0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size).data;

  let bright = 0;
  let dark = 0;
  let lowSat = 0;
  let blueTop = 0;
  let blueLower = 0;
  let green = 0;
  let warm = 0;
  let totalLuma = 0;
  let totalSat = 0;
  const total = size * size;

  for (let i = 0; i < pixels.length; i += 4) {
    const pixel = i / 4;
    const y = Math.floor(pixel / size);
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const hsl = rgbToHsl(r, g, b);
    totalLuma += luma;
    totalSat += hsl.s;
    if (luma > 190) bright++;
    if (luma < 65) dark++;
    if (hsl.s < 0.12) lowSat++;
    if (hsl.h >= 185 && hsl.h <= 240 && hsl.s > 0.2 && y < size / 2) blueTop++;
    if (hsl.h >= 175 && hsl.h <= 235 && hsl.s > 0.18 && y >= size / 3) blueLower++;
    if (hsl.h >= 75 && hsl.h <= 165 && hsl.s > 0.2) green++;
    if ((hsl.h <= 45 || hsl.h >= 330) && hsl.s > 0.22 && luma > 80) warm++;
  }

  const labels = new Map<string, VisualIndexLabel>();
  const avgLuma = totalLuma / total;
  const avgSat = totalSat / total;
  const addImageLabel = (
    label: string,
    kind: VisualIndexLabel["kind"],
    confidence: number,
    reason: string,
    evidence: string[],
  ) => {
    addLabel(labels, {
      label,
      kind,
      confidence: Math.max(0.5, Math.min(0.95, confidence)),
      source: "image",
      reason,
      evidence,
    });
  };

  if (blueTop / total > 0.16) {
    addImageLabel("Sky", "scene", 0.64 + blueTop / total, "The upper preview contains a strong blue region.", [`${Math.round((blueTop / total) * 100)}% upper-blue pixels`]);
  }
  if (green / total > 0.22) {
    addImageLabel("Foliage", "scene", 0.58 + green / total, "The preview has a large green color cluster.", [`${Math.round((green / total) * 100)}% green pixels`]);
  }
  if (blueLower / total > 0.18) {
    addImageLabel("Water", "scene", 0.55 + blueLower / total, "The lower preview contains a saturated blue region.", [`${Math.round((blueLower / total) * 100)}% lower-blue pixels`]);
  }
  if (warm / total > 0.24) {
    addImageLabel("Warm Light", "scene", 0.58 + warm / total, "The preview contains a warm orange or red color cast.", [`${Math.round((warm / total) * 100)}% warm pixels`]);
  }
  if (dark / total > 0.5 || avgLuma < 72) {
    addImageLabel("Low Light", "scene", 0.68, "The preview is predominantly dark.", [`average luma ${Math.round(avgLuma)}`]);
  }
  if (bright / total > 0.58 && avgSat < 0.22) {
    addImageLabel("Snow or Fog", "scene", 0.62, "The preview is bright with low saturation.", [`${Math.round((bright / total) * 100)}% bright pixels`, `saturation ${avgSat.toFixed(2)}`]);
  }
  if (lowSat / total > 0.78 && avgSat < 0.13) {
    addImageLabel("Black and White", "visual", 0.76, "The preview is almost entirely low saturation.", [`${Math.round((lowSat / total) * 100)}% low-saturation pixels`]);
  }
  if ((photo.exif.width ?? 0) > 0 && (photo.exif.height ?? 0) > 0 && (photo.exif.height ?? 0) > (photo.exif.width ?? 0)) {
    addImageLabel("Portrait Orientation", "visual", 0.82, "The EXIF dimensions are taller than wide.", [`${photo.exif.width} x ${photo.exif.height}`]);
  }

  return Array.from(labels.values());
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

export async function indexPhotoVisuals(
  photos: Photo[],
  onProgress: (progress: VisualIndexProgress) => void,
  existing: Record<string, VisualIndexEntry> = {},
  options: VisualIndexOptions = {},
): Promise<Record<string, VisualIndexEntry>> {
  const next: Record<string, VisualIndexEntry> = { ...existing };
  const total = photos.length;

  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    onProgress({ current: index, total, current_file: photo.file_name });
    await idleTick();

    const existingEntry = next[photo.id];
    if (
      existingEntry &&
      (!options.detectorReady || existingEntry.detector_model_id === options.detectorModelId)
    ) {
      continue;
    }

    const labels = new Map<string, VisualIndexLabel>();
    let detections: ObjectDetectionBox[] = [];
    for (const label of metadataLabels(photo)) addLabel(labels, label);
    try {
      for (const label of await imageLabels(photo)) addLabel(labels, label);
    } catch {
      // Unsupported formats or partially generated thumbnails can be retried in a later indexing pass.
    }
    if (options.detectorReady && options.detectObjects) {
      try {
        detections = await options.detectObjects(photo);
        addDetectionLabels(labels, detections);
      } catch {
        detections = [];
      }
    }

    next[photo.id] = {
      photo_id: photo.id,
      labels: Array.from(labels.values()).sort((a, b) => b.confidence - a.confidence),
      detections,
      indexed_at: new Date().toISOString(),
      detector_model_id: options.detectorReady ? options.detectorModelId : undefined,
    };
  }

  onProgress({ current: total, total });
  return next;
}
