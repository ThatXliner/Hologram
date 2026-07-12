import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo, VisualIndexEntry, VisualIndexLabel, VisualIndexProgress } from "./types.ts";

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

function metadataLabels(photo: Photo): VisualIndexLabel[] {
  const text = photoText(photo);
  const labels = new Map<string, VisualIndexLabel>();
  for (const seed of metadataSeeds) {
    if (seed.tokens.some((token) => text.includes(token))) {
      addLabel(labels, {
        label: seed.label,
        kind: seed.kind,
        confidence: 0.72,
        source: "metadata",
      });
    }
  }
  if ((photo.exif.focal_length ?? 0) >= 85) {
    addLabel(labels, { label: "Telephoto", kind: "visual", confidence: 0.64, source: "metadata" });
  }
  if ((photo.exif.aperture ?? 99) <= 2.8) {
    addLabel(labels, { label: "Shallow Depth", kind: "visual", confidence: 0.62, source: "metadata" });
  }
  if ((photo.exif.iso ?? 0) >= 3200) {
    addLabel(labels, { label: "Low Light", kind: "scene", confidence: 0.6, source: "metadata" });
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
  const addImageLabel = (label: string, kind: VisualIndexLabel["kind"], confidence: number) => {
    addLabel(labels, { label, kind, confidence: Math.max(0.5, Math.min(0.95, confidence)), source: "image" });
  };

  if (blueTop / total > 0.16) addImageLabel("Sky", "scene", 0.64 + blueTop / total);
  if (green / total > 0.22) addImageLabel("Foliage", "scene", 0.58 + green / total);
  if (blueLower / total > 0.18) addImageLabel("Water", "scene", 0.55 + blueLower / total);
  if (warm / total > 0.24) addImageLabel("Warm Light", "scene", 0.58 + warm / total);
  if (dark / total > 0.5 || avgLuma < 72) addImageLabel("Low Light", "scene", 0.68);
  if (bright / total > 0.58 && avgSat < 0.22) addImageLabel("Snow or Fog", "scene", 0.62);
  if (lowSat / total > 0.78 && avgSat < 0.13) addImageLabel("Black and White", "visual", 0.76);
  if ((photo.exif.width ?? 0) > 0 && (photo.exif.height ?? 0) > 0 && (photo.exif.height ?? 0) > (photo.exif.width ?? 0)) {
    addImageLabel("Portrait Orientation", "visual", 0.82);
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
): Promise<Record<string, VisualIndexEntry>> {
  const next: Record<string, VisualIndexEntry> = { ...existing };
  const total = photos.length;
  let completed = 0;
  let nextIndex = 0;
  const concurrency = Math.max(
    1,
    Math.min(4, typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2),
  );

  const worker = async () => {
    while (nextIndex < photos.length) {
      const photo = photos[nextIndex++];
      await idleTick();

      if (!next[photo.id]) {
        const labels = new Map<string, VisualIndexLabel>();
        for (const label of metadataLabels(photo)) addLabel(labels, label);
        try {
          for (const label of await imageLabels(photo)) addLabel(labels, label);
        } catch {
          // Unsupported formats or partially generated thumbnails can be retried in a later indexing pass.
        }

        next[photo.id] = {
          photo_id: photo.id,
          labels: Array.from(labels.values()).sort((a, b) => b.confidence - a.confidence),
          indexed_at: new Date().toISOString(),
        };
      }

      completed++;
      onProgress({ current: completed, total, current_file: photo.file_name });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, photos.length) }, () => worker()),
  );

  onProgress({ current: total, total });
  return next;
}
