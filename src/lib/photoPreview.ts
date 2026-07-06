import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "./types.ts";

const browserPreviewTypes = new Set(["JPEG", "JPG", "PNG", "WEBP", "GIF"]);

export function canUseOriginalAsPreview(photo: Photo): boolean {
  return browserPreviewTypes.has(photo.file_type.toUpperCase());
}

export function photoPreviewSrc(photo: Photo): string {
  if (photo.thumbnail) {
    const mime = photo.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${photo.thumbnail}`;
  }
  if (!canUseOriginalAsPreview(photo)) return "";
  try {
    return convertFileSrc(photo.file_path);
  } catch {
    return "";
  }
}
