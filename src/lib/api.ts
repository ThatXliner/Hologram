import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Photo, PhotoFilter, PhotoStats, ScanResult, ThumbnailReady } from "./types.ts";

export class HologramAPI {
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
      invoke("generate_thumbnails", { photos: result.photos }).catch((err) => {
        console.error("Thumbnail generation error:", err);
      });

      return result;
    } catch (error) {
      console.error("Error scanning folder:", error);
      throw new Error(`Failed to scan folder: ${error}`);
    }
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
    const { open } = await import("@tauri-apps/plugin-opener");
    await open(filePath);
  }

  static async setPhotoMetadata(photoId: string, tags: string[], notes: string): Promise<void> {
    await invoke("set_photo_metadata", { photoId, tags, notes });
  }

  static async getPhotoMetadata(photoIds: string[]): Promise<Record<string, { tags: string[]; notes: string }>> {
    return await invoke("get_photo_metadata", { photoIds });
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
}
