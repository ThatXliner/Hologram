import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Photo, PhotoFilter, PhotoStats, ScanProgress } from "./types.ts";

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

  static async scanFolder(folderPath: string): Promise<Photo[]> {
    try {
      const photos = await invoke<Photo[]>("scan_folder", {
        folderPath,
      });
      return photos;
    } catch (error) {
      console.error("Error scanning folder:", error);
      throw new Error(`Failed to scan folder: ${error}`);
    }
  }

  static async scanFolderWithProgress(
    folderPath: string,
    onProgress?: (progress: ScanProgress) => void,
    onComplete?: () => void,
  ): Promise<Photo[]> {
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;

    try {
      // Set up progress listeners
      if (onProgress) {
        unlistenProgress = await listen<ScanProgress>("scan-progress", (event) => {
          onProgress(event.payload);
        });
      }

      if (onComplete) {
        unlistenComplete = await listen("scan-complete", () => {
          onComplete();
        });
      }

      const photos = await invoke<Photo[]>("scan_folder_with_progress", {
        folderPath,
      });

      return photos;
    } catch (error) {
      console.error("Error scanning folder with progress:", error);
      throw new Error(`Failed to scan folder: ${error}`);
    } finally {
      // Clean up listeners
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
    }
  }

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
    return imageData; // base64 encoded full resolution image
  }
}
