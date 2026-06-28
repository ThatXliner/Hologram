import type { ImageAdjustmentSettings, RawProcessingPreset } from "./types.ts";

export const neutralAdjustments: ImageAdjustmentSettings = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  highlights: 0,
  shadows: 0,
  sharpen: 0,
  curve_points: [
    [0, 0],
    [255, 255],
  ],
};

export const builtInRawPresets: RawProcessingPreset[] = [
  {
    id: "builtin-neutral",
    name: "Neutral RAW",
    source: "built-in",
    adjustments: neutralAdjustments,
    notes: "A clean baseline for comparing RAW render against the camera JPEG.",
  },
  {
    id: "builtin-filmic-soft",
    name: "Filmic Soft",
    source: "built-in",
    adjustments: {
      ...neutralAdjustments,
      exposure: 6,
      contrast: -8,
      highlights: -28,
      shadows: 18,
      saturation: 8,
      curve_points: [
        [0, 0],
        [48, 58],
        [128, 132],
        [220, 210],
        [255, 245],
      ],
    },
  },
  {
    id: "builtin-punchy-jpeg",
    name: "Punchy JPEG Match",
    source: "built-in",
    adjustments: {
      ...neutralAdjustments,
      contrast: 18,
      saturation: 14,
      sharpen: 18,
      curve_points: [
        [0, 0],
        [54, 44],
        [128, 130],
        [205, 218],
        [255, 255],
      ],
    },
  },
  {
    id: "builtin-shadow-recovery",
    name: "Shadow Recovery",
    source: "built-in",
    adjustments: {
      ...neutralAdjustments,
      exposure: 8,
      contrast: -6,
      highlights: -36,
      shadows: 42,
      saturation: 4,
    },
  },
];

function clampAdjustment(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

function clampPositiveAdjustment(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function xmpAttr(text: string, name: string): string | undefined {
  const attr = new RegExp(`${name}="([^"]*)"`, "i").exec(text);
  if (attr?.[1] != null) return attr[1];
  const element = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(text);
  return element?.[1];
}

function numberAttr(text: string, name: string): number | undefined {
  const value = xmpAttr(text, name);
  if (value == null) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLightroomToneCurve(text: string): [number, number][] | undefined {
  const raw = xmpAttr(text, "crs:ToneCurvePV2012") ?? xmpAttr(text, "crs:ToneCurvePV2012Red");
  if (!raw) return undefined;
  const numbers = raw
    .split(/[,\s]+/)
    .map((value) => Number.parseFloat(value))
    .filter(Number.isFinite);
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push([
      Math.max(0, Math.min(255, Math.round(numbers[i]))),
      Math.max(0, Math.min(255, Math.round(numbers[i + 1]))),
    ]);
  }
  return points.length >= 2 ? points : undefined;
}

function parseLightroomXmp(name: string, text: string): RawProcessingPreset {
  const adjustments: ImageAdjustmentSettings = { ...neutralAdjustments };
  adjustments.exposure = clampAdjustment((numberAttr(text, "crs:Exposure2012") ?? 0) * 35);
  adjustments.contrast = clampAdjustment(numberAttr(text, "crs:Contrast2012") ?? 0);
  adjustments.highlights = clampAdjustment(numberAttr(text, "crs:Highlights2012") ?? 0);
  adjustments.shadows = clampAdjustment(numberAttr(text, "crs:Shadows2012") ?? 0);
  adjustments.saturation = clampAdjustment(
    (numberAttr(text, "crs:Saturation") ?? 0) + (numberAttr(text, "crs:Vibrance") ?? 0) * 0.45,
  );
  adjustments.sharpen = clampPositiveAdjustment(numberAttr(text, "crs:Sharpness") ?? 0);

  const temperature = numberAttr(text, "crs:Temperature");
  if (temperature != null) {
    adjustments.temperature = clampAdjustment((temperature - 5500) / 35);
  }

  const curve = parseLightroomToneCurve(text);
  if (curve) adjustments.curve_points = curve;

  return {
    id: `xmp-${Date.now()}`,
    name,
    source: "lightroom-xmp",
    adjustments,
    notes: "Imported from Adobe/Lightroom XMP develop settings.",
    created_at: new Date().toISOString(),
  };
}

function parseDarktableXmp(name: string, text: string): RawProcessingPreset {
  const lower = text.toLowerCase();
  const adjustments: ImageAdjustmentSettings = { ...neutralAdjustments };

  if (lower.includes("operation=\"exposure\"") || lower.includes("module=\"exposure\"")) {
    adjustments.exposure = 10;
  }
  if (lower.includes("filmic") || lower.includes("sigmoid")) {
    adjustments.highlights = -24;
    adjustments.shadows = 14;
    adjustments.contrast = -6;
  }
  if (lower.includes("colorbalancergb") || lower.includes("color balance")) {
    adjustments.saturation = 8;
  }
  if (lower.includes("localcontrast") || lower.includes("toneequal")) {
    adjustments.contrast = Math.max(adjustments.contrast, 10);
  }
  if (lower.includes("sharpen")) {
    adjustments.sharpen = 20;
  }
  if (lower.includes("temperature") || lower.includes("whitebalance")) {
    adjustments.temperature = 6;
  }

  return {
    id: `darktable-${Date.now()}`,
    name,
    source: "darktable-xmp",
    adjustments,
    notes: "Imported from a Darktable XMP sidecar. Hologram maps recognizable modules to preview adjustments.",
    created_at: new Date().toISOString(),
  };
}

function parseCubePreset(name: string, text: string): RawProcessingPreset {
  const lower = text.toLowerCase();
  const adjustments: ImageAdjustmentSettings = { ...neutralAdjustments };
  if (lower.includes("film") || lower.includes("kodak") || lower.includes("fuji")) {
    adjustments.contrast = 10;
    adjustments.saturation = 8;
    adjustments.highlights = -10;
  }
  return {
    id: `cube-${Date.now()}`,
    name,
    source: "cube",
    adjustments,
    notes: "Imported from a .cube LUT. Hologram stores it as a named look and applies a conservative preview approximation.",
    created_at: new Date().toISOString(),
  };
}

export function parseRawPresetFile(fileName: string, text: string): RawProcessingPreset {
  const name = fileName.replace(/\.[^.]+$/, "") || "Imported Preset";
  const lower = text.toLowerCase();
  if (fileName.toLowerCase().endsWith(".cube")) {
    return parseCubePreset(name, text);
  }
  if (lower.includes("darktable:") || lower.includes("darktable:history")) {
    return parseDarktableXmp(name, text);
  }
  if (lower.includes("crs:") || lower.includes("camera raw settings")) {
    return parseLightroomXmp(name, text);
  }
  return {
    id: `xmp-${Date.now()}`,
    name,
    source: "xmp",
    adjustments: neutralAdjustments,
    notes: "Imported XMP preset with no recognized adjustment fields.",
    created_at: new Date().toISOString(),
  };
}

export function presetSummary(preset: RawProcessingPreset): string {
  const active = Object.entries(preset.adjustments)
    .filter(([key, value]) => key !== "curve_points" && typeof value === "number" && value !== 0)
    .map(([key]) => key.replace("_", " "));
  if (preset.adjustments.curve_points.some(([x, y]) => x !== y)) active.push("curve");
  return active.length ? active.join(", ") : "neutral";
}
