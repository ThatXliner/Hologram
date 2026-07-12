import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CullFlag,
  ExportOptions,
  ExportResult,
  Photo,
  PhotoFilter,
  PhotoMetadata,
  PhotoStats,
  RawRenderReady,
  ScanResult,
  ThumbnailReady,
  XmpSidecarResult,
} from "./types.ts";

export class HologramAPI {
  private static activeFolderPath: string | null = null;

  static getActiveFolderPath(): string | null {
    return HologramAPI.activeFolderPath;
  }

  static setActiveFolderPath(folderPath: string | null): void {
    HologramAPI.activeFolderPath = folderPath;
  }

  static async selectFolder(): Promise<string | null> {
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: "Select Photo Folder",
      });
      return result;
    } catch (error) {
      console.error("Error selecting folder:", error);
      return null;
    }
  }

  static async selectExportFolder(): Promise<string | null> {
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: "Select Export Destination",
      });
      return result;
    } catch (error) {
      console.error("Error selecting export folder:", error);
      return null;
    }
  }

  /**
   * Two-phase scan:
   * 1. scan_folder_fast — returns metadata + EXIF instantly (no image decoding)
   * 2. generate_thumbnails — generates thumbnails in background, streaming
   *    each one to onThumbnail as it completes
   */
  static async scanFolder(
    folderPath: string,
    onThumbnail?: (data: ThumbnailReady) => void,
  ): Promise<ScanResult> {
    let unlistenThumbnail: (() => void) | null = null;
    HologramAPI.setActiveFolderPath(folderPath);

    try {
      // Set up thumbnail listener before starting generation
      if (onThumbnail) {
        unlistenThumbnail = await listen<ThumbnailReady>("thumbnail-ready", (event) => {
          onThumbnail(event.payload);
        });
      }

      // Phase 1: Fast metadata scan (no image decoding)
      const result = await invoke<ScanResult>("scan_folder_fast", {
        folderPath,
      });

      // Phase 2: Kick off thumbnail generation in background (fire-and-forget)
      invoke("generate_thumbnails", { photos: result.photos, folderPath }).catch((err) => {
        console.error("Thumbnail generation error:", err);
      });

      // Phase 3: progressively fill the full-resolution RAW render cache.
      invoke("prerender_raws", { photos: result.photos }).catch((err) => {
        console.error("RAW pre-rendering error:", err);
      });

      return result;
    } catch (error) {
      console.error("Error scanning folder:", error);
      throw new Error(`Failed to scan folder: ${error}`);
    }
  }

  static async onRawRenderReady(
    callback: (data: RawRenderReady) => void,
  ): Promise<() => void> {
    return await listen<RawRenderReady>("raw-render-ready", (event) => {
      callback(event.payload);
    });
  }

  static prioritizeRawRenders(photos: Photo[]): void {
    if (photos.length === 0) return;
    invoke("prioritize_raw_renders", { photos }).catch((err) => {
      console.error("Failed to prioritize visible RAW previews:", err);
    });
  }

  static stopThumbnailListener: (() => void) | null = null;

  static async filterPhotos(
    photos: Photo[],
    filter: PhotoFilter,
  ): Promise<Photo[]> {
    try {
      const filteredPhotos = await invoke<Photo[]>("filter_photos", {
        photos,
        filter,
      });
      return filteredPhotos;
    } catch (error) {
      console.error("Error filtering photos:", error);
      throw new Error(`Failed to filter photos: ${error}`);
    }
  }

  static async getPhotoStats(photos: Photo[]): Promise<PhotoStats> {
    try {
      const stats = await invoke<PhotoStats>("get_photo_stats", {
        photos,
      });
      return stats;
    } catch (error) {
      console.error("Error getting photo stats:", error);
      throw new Error(`Failed to get photo stats: ${error}`);
    }
  }

  static async applyEditsAndSave(
    filePath: string,
    adjustments: {
      exposure: number;
      contrast: number;
      saturation: number;
      temperature: number;
      highlights: number;
      shadows: number;
      sharpen: number;
      curve_points: [number, number][];
    },
  ): Promise<string> {
    const savedPath = await invoke<string>("apply_edits_and_save", {
      filePath,
      adjustments,
    });
    return savedPath;
  }

  static async denoiseImage(
    imageBytes: Uint8Array,
    width: number,
    height: number,
    strength: number,
  ): Promise<Uint8Array> {
    const result = await invoke<number[]>("denoise_image", {
      imageBytes: Array.from(imageBytes),
      width,
      height,
      strength,
    });
    return new Uint8Array(result);
  }

  static async openInEditor(filePath: string): Promise<void> {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  }

  static async setPhotoMetadata(
    photoId: string,
    tags: string[],
    notes: string,
    rating = 0,
    flag: CullFlag = "none",
  ): Promise<void> {
    await invoke("set_photo_metadata", {
      photoId,
      folderPath: HologramAPI.activeFolderPath,
      tags,
      notes,
      rating,
      flag,
    });
  }

  static async getPhotoMetadata(photoIds: string[]): Promise<Record<string, PhotoMetadata>> {
    return await invoke("get_photo_metadata", {
      photoIds,
      folderPath: HologramAPI.activeFolderPath,
    });
  }

  static async loadFullResolutionImage(filePath: string): Promise<ArrayBuffer> {
    const imageData = await invoke<ArrayBuffer | string>(
      "load_full_resolution_image_command",
      {
        filePath,
      },
    );
    if (typeof imageData === "string") {
      throw new Error(`Failed to load full resolution image: ${imageData}`);
    }
    return imageData;
  }

  static async exportPhotos(
    photos: Photo[],
    allPhotos: Photo[],
    options: ExportOptions,
  ): Promise<ExportResult> {
    return await invoke<ExportResult>("export_photos", {
      photos,
      allPhotos,
      options,
    });
  }

  static async exportXmpSidecars(photos: Photo[]): Promise<XmpSidecarResult> {
    return await invoke<XmpSidecarResult>("export_xmp_sidecars", {
      photos,
    });
  }

  static async importXmpSidecars(photos: Photo[]): Promise<XmpSidecarResult> {
    return await invoke<XmpSidecarResult>("import_xmp_sidecars", {
      photos,
      folderPath: HologramAPI.activeFolderPath,
    });
  }
}
