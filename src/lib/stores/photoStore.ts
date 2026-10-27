import { writable, derived } from "svelte/store";
import type {
  CullFlag,
  EmbeddedJpegPreview,
  Photo,
  PhotoMetadata,
  PhotoFilter,
  PhotoStats,
  AppState,
  ScanProgress,
} from "../types.ts";
import { HologramAPI } from "../api.ts";
import { beginXmpImport, finishXmpImport, reconcileXmpImports, resolveXmpImportFailure, xmpImportFailure } from "../xmpImport.ts";

const RAW_FILE_TYPES = new Set([
  "3FR", "ARI", "ARW", "BAY", "CAP", "CRW", "CR2", "CR3", "DATA", "DCS", "DCR",
  "DNG", "DRF", "ERF", "FFF", "GPR", "IIQ", "K25", "KDC", "MDC", "MEF", "MOS",
  "MRW", "NEF", "NRW", "OBM", "ORF", "PEF", "PTX", "PXN", "RAF", "RAW", "RW2",
  "RWL", "RWZ", "SR2", "SRF", "SRW", "X3F",
]);

function createPhotoStore() {
  const initialState: AppState = {
    photos: [],
    filteredPhotos: [],
    currentFilter: {},
    isLoading: false,
    scanProgress: undefined,
    stats: undefined,
    viewMode: "grid",
    selectedIndex: 0,
  };

  const { subscribe, set, update } = writable<AppState>(initialState);
  let libraryGeneration = 0;
  let metadataGeneration = 0;
  const metadataWrites = new Set<Promise<void>>();
  let metadataWriteError: unknown;

  // Index for O(1) thumbnail patching
  let photoIndex = new Map<string, number>();
  let filteredIndex = new Map<string, number>();

  function rebuildIndex(state: AppState) {
    photoIndex = new Map(state.photos.map((p, i) => [p.id, i]));
    filteredIndex = new Map(state.filteredPhotos.map((p, i) => [p.id, i]));
  }

  // Batch thumbnail updates: accumulate then flush in one store update
  type PendingThumbnail = {
    thumbnail: string;
    embeddedJpegPreview?: EmbeddedJpegPreview | null;
  };

  let pendingThumbnails = new Map<string, PendingThumbnail>();
  let flushScheduled = false;

  function normalizeRating(rating: number | undefined): number {
    return Math.max(0, Math.min(5, Math.round(rating ?? 0)));
  }

  function normalizeFlag(flag: CullFlag | undefined): CullFlag {
    return flag === "pick" || flag === "reject" ? flag : "none";
  }

  function flushThumbnails() {
    flushScheduled = false;
    if (pendingThumbnails.size === 0) return;

    const batch = pendingThumbnails;
    pendingThumbnails = new Map();

    update((state) => {
      const photos = [...state.photos];
      const filteredPhotos = [...state.filteredPhotos];

      for (const [id, patch] of batch) {
        const pi = photoIndex.get(id);
        const fi = filteredIndex.get(id);
        const source = pi !== undefined ? photos[pi] : fi !== undefined ? filteredPhotos[fi] : null;
        const pairedId = source?.paired_with;

        if (pi !== undefined) {
          photos[pi] = {
            ...photos[pi],
            thumbnail: patch.thumbnail,
            ...(patch.embeddedJpegPreview !== undefined
              ? { embedded_jpeg_preview: patch.embeddedJpegPreview }
              : {}),
          };
        }
        if (fi !== undefined) {
          filteredPhotos[fi] = {
            ...filteredPhotos[fi],
            thumbnail: patch.thumbnail,
            ...(patch.embeddedJpegPreview !== undefined
              ? { embedded_jpeg_preview: patch.embeddedJpegPreview }
              : {}),
          };
        }

        if (patch.embeddedJpegPreview !== undefined && pairedId) {
          const pairedPi = photoIndex.get(pairedId);
          if (pairedPi !== undefined) {
            photos[pairedPi] = {
              ...photos[pairedPi],
              paired_raw_embedded_jpeg_preview: patch.embeddedJpegPreview,
            };
          }
          const pairedFi = filteredIndex.get(pairedId);
          if (pairedFi !== undefined) {
            filteredPhotos[pairedFi] = {
              ...filteredPhotos[pairedFi],
              paired_raw_embedded_jpeg_preview: patch.embeddedJpegPreview,
            };
          }
        }
      }
      return {
        ...state,
        photos,
        filteredPhotos,
      };
    });
  }

  function patchPhotoMetadata(
    photoId: string,
    patch: Partial<Pick<Photo, "tags" | "notes" | "rating" | "flag">>,
  ) {
    const folderPath = HologramAPI.getActiveFolderPath();
    let tags: string[] = [];
    let notes = "";
    let rating = 0;
    let flag: CullFlag = "none";
    let found = false;

    update((state) => {
      const pi = photoIndex.get(photoId);
      const fi = filteredIndex.get(photoId);
      const photos = [...state.photos];
      const filteredPhotos = [...state.filteredPhotos];
      const source = pi !== undefined ? photos[pi] : fi !== undefined ? filteredPhotos[fi] : null;

      if (!source) {
        return state;
      }

      const nextPhoto = {
        ...source,
        ...patch,
        rating: normalizeRating(patch.rating ?? source.rating),
        flag: normalizeFlag(patch.flag ?? source.flag),
      };
      tags = nextPhoto.tags ?? [];
      notes = nextPhoto.notes ?? "";
      rating = nextPhoto.rating ?? 0;
      flag = nextPhoto.flag ?? "none";
      found = true;

      if (pi !== undefined) photos[pi] = nextPhoto;
      if (fi !== undefined) filteredPhotos[fi] = nextPhoto;
      return { ...state, photos, filteredPhotos };
    });

    if (found) {
      metadataGeneration++;
      const write = HologramAPI.setPhotoMetadata(photoId, tags, notes, rating, flag, folderPath);
      metadataWrites.add(write);
      void write.catch((error: unknown) => {
        metadataWriteError = error;
        console.error("setPhotoMetadata failed:", error);
      }).finally(() => metadataWrites.delete(write));
    }
  }

  function applyMetadata(metadataMap: Record<string, PhotoMetadata>, sourcePhotos: Photo[], applyToCurrentLibrary = true) {
    metadataGeneration++;
    reconcileXmpImports(metadataMap, sourcePhotos);
    if (!applyToCurrentLibrary) return;
    update((state) => {
      const photos = [...state.photos];
      const filteredPhotos = [...state.filteredPhotos];
      for (const [id, meta] of Object.entries(metadataMap)) {
        const pi = photoIndex.get(id);
        const patch = {
          tags: meta.tags ?? [], notes: meta.notes ?? "",
          rating: normalizeRating(meta.rating), flag: normalizeFlag(meta.flag),
        };
        if (pi !== undefined) photos[pi] = { ...photos[pi], ...patch };
        const fi = filteredIndex.get(id);
        if (fi !== undefined) filteredPhotos[fi] = { ...filteredPhotos[fi], ...patch };
      }
      return { ...state, photos, filteredPhotos };
    });
  }

  function currentPhotos(): Photo[] {
    let photos: Photo[] = [];
    const unsubscribe = subscribe((state) => { photos = state.photos; });
    unsubscribe();
    return photos;
  }

  async function waitForMetadataWrites() {
    while (metadataWrites.size) await Promise.allSettled([...metadataWrites]);
  }

  async function flushMetadataWrites() {
    await waitForMetadataWrites();
    if (metadataWriteError !== undefined) {
      const error = metadataWriteError;
      metadataWriteError = undefined;
      throw error;
    }
  }

  function applyImportedMetadata(metadataMap: Record<string, PhotoMetadata>, folderPath: string | null, sourcePhotos = currentPhotos()) {
    applyMetadata(metadataMap, sourcePhotos, folderPath === HologramAPI.getActiveFolderPath());
  }

  return {
    subscribe,
    get photos() {
      let currentState: AppState;
      const unsubscribe = subscribe((state) => {
        currentState = state;
      });
      unsubscribe();
      return currentState!.photos;
    },
    setPhotos: (photos: Photo[]) => {
      libraryGeneration++;
      update((state) => {
        const newState = { ...state, photos, filteredPhotos: photos };
        rebuildIndex(newState);
        return newState;
      });
    },
    removePhotos: (photoIds: string[]) =>
      update((state) => {
        if (photoIds.length === 0) return state;
        const removed = new Set(photoIds);
        const photos = state.photos.filter((photo) => !removed.has(photo.id));
        const filteredPhotos = state.filteredPhotos.filter((photo) => !removed.has(photo.id));
        const newState = {
          ...state,
          photos,
          filteredPhotos,
          selectedIndex: Math.min(state.selectedIndex, Math.max(0, filteredPhotos.length - 1)),
        };
        rebuildIndex(newState);
        return newState;
      }),
    setThumbnail: (
      id: string,
      thumbnail: string,
      embeddedJpegPreview?: EmbeddedJpegPreview | null,
    ) => {
      pendingThumbnails.set(id, { thumbnail, embeddedJpegPreview });
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(flushThumbnails);
      }
    },
    setFilteredPhotos: (filteredPhotos: Photo[]) =>
      update((state) => {
        const newState = { ...state, filteredPhotos };
        filteredIndex = new Map(filteredPhotos.map((p, i) => [p.id, i]));
        return newState;
      }),
    setFilter: (filter: PhotoFilter) =>
      update((state) => ({ ...state, currentFilter: filter })),
    setLoading: (isLoading: boolean) =>
      update((state) => ({ ...state, isLoading })),
    setScanProgress: (scanProgress: ScanProgress | undefined) =>
      update((state) => ({ ...state, scanProgress })),
    setStats: (stats: PhotoStats) => update((state) => ({ ...state, stats })),
    setViewMode: (viewMode: "grid" | "list" | "viewer") =>
      update((state) => ({ ...state, viewMode })),
    setSelectedIndex: (selectedIndex: number) =>
      update((state) => ({ ...state, selectedIndex })),
    setPhotoTags: (photoId: string, tags: string[]) => patchPhotoMetadata(photoId, { tags }),
    setPhotoNotes: (photoId: string, notes: string) => patchPhotoMetadata(photoId, { notes }),
    setPhotoRating: (photoId: string, rating: number) =>
      patchPhotoMetadata(photoId, { rating: normalizeRating(rating) }),
    setPhotoFlag: (photoId: string, flag: CullFlag) =>
      patchPhotoMetadata(photoId, { flag: normalizeFlag(flag) }),
    clearPhotoCull: (photoId: string) => patchPhotoMetadata(photoId, { rating: 0, flag: "none" }),
    flushMetadataWrites,
    applyImportedMetadata,
    refreshImportedMetadata: async (photoIds: string[], folderPath: string | null, sourcePhotos: Photo[]) => {
      if (photoIds.length === 0) return;
      beginXmpImport();
      try {
        while (true) {
          await flushMetadataWrites();
          const readGeneration = metadataGeneration;
          const generation = libraryGeneration;
          const metadataMap = await HologramAPI.getPhotoMetadata(photoIds, folderPath);
          if (readGeneration !== metadataGeneration) continue;
          applyMetadata(metadataMap, sourcePhotos, generation === libraryGeneration && folderPath === HologramAPI.getActiveFolderPath());
          resolveXmpImportFailure(photoIds);
          return;
        }
      } catch (error) {
        throw xmpImportFailure(error, photoIds);
      } finally {
        finishXmpImport();
      }
    },
    loadMetadata: async (photoIds: string[]) => {
      if (photoIds.length === 0) return;
      const folderPath = HologramAPI.getActiveFolderPath();
      const generation = libraryGeneration;
      const sourcePhotos = currentPhotos();
      const isCurrent = () => generation === libraryGeneration && folderPath === HologramAPI.getActiveFolderPath();
      try {
        while (isCurrent()) {
          await waitForMetadataWrites();
          if (!isCurrent()) return;
          const readGeneration = metadataGeneration;
          const metadataMap = await HologramAPI.getPhotoMetadata(photoIds, folderPath);
          if (!isCurrent()) return;
          if (readGeneration !== metadataGeneration) continue;
          applyMetadata(metadataMap, sourcePhotos);
          resolveXmpImportFailure(photoIds);
          return;
        }
      } catch (e) {
        console.error("loadMetadata failed:", e);
      }
    },
    reset: () => {
      libraryGeneration++;
      set(initialState);
    },
  };
}

export const photoStore = createPhotoStore();

// Derived stores for easy access
export const photos = derived(photoStore, ($store) => $store.photos);
export const filteredPhotos = derived(
  photoStore,
  ($store) => $store.filteredPhotos,
);

// Display photos: collapse paired RAW+JPEG into single entries (prefer JPEG for display)
export const displayPhotos = derived(filteredPhotos, ($photos) => {
  const seen = new Set<string>();
  const result: Photo[] = [];
  for (const photo of $photos) {
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    if (photo.paired_with) {
      seen.add(photo.paired_with);
      // For the grid, show the JPEG version (has better thumbnail)
      const isRaw = RAW_FILE_TYPES.has(photo.file_type);
      if (isRaw) {
        // Find the JPEG pair and show that instead, but keep the RAW reference
        const jpegPair = $photos.find((p) => p.id === photo.paired_with);
        if (jpegPair) {
          result.push(jpegPair);
          continue;
        }
      }
    }
    result.push(photo);
  }
  return result;
});

export const currentFilter = derived(
  photoStore,
  ($store) => $store.currentFilter,
);
export const isLoading = derived(photoStore, ($store) => $store.isLoading);
export const scanProgress = derived(photoStore, ($store) => $store.scanProgress);
export const stats = derived(photoStore, ($store) => $store.stats);
export const viewMode = derived(photoStore, ($store) => $store.viewMode);
export const selectedIndex = derived(photoStore, ($store) => $store.selectedIndex);
