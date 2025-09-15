import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Photo, PhotoFilter, PhotoStats } from "./types.ts";

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
}
