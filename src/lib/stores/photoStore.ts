import { writable, derived } from "svelte/store";
import type { CullFlag, Photo, PhotoFilter, PhotoStats, AppState, ScanProgress } from "../types.ts";
import { HologramAPI } from "../api.ts";

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

  // Index for O(1) thumbnail patching
  let photoIndex = new Map<string, number>();
  let filteredIndex = new Map<string, number>();

  function rebuildIndex(state: AppState) {
    photoIndex = new Map(state.photos.map((p, i) => [p.id, i]));
    filteredIndex = new Map(state.filteredPhotos.map((p, i) => [p.id, i]));
  }

  // Batch thumbnail updates: accumulate then flush in one store update
  let pendingThumbnails = new Map<string, string>();
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
      for (const [id, thumbnail] of batch) {
        const pi = photoIndex.get(id);
        if (pi !== undefined) {
          state.photos[pi] = { ...state.photos[pi], thumbnail };
        }
        const fi = filteredIndex.get(id);
        if (fi !== undefined) {
          state.filteredPhotos[fi] = { ...state.filteredPhotos[fi], thumbnail };
        }
      }
      return {
        ...state,
        photos: [...state.photos],
        filteredPhotos: [...state.filteredPhotos],
      };
    });
  }

  function patchPhotoMetadata(
    photoId: string,
    patch: Partial<Pick<Photo, "tags" | "notes" | "rating" | "flag">>,
  ) {
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
      HologramAPI.setPhotoMetadata(photoId, tags, notes, rating, flag).catch((e) =>
        console.error("setPhotoMetadata failed:", e),
      );
    }
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
    setPhotos: (photos: Photo[]) =>
      update((state) => {
        const newState = { ...state, photos, filteredPhotos: photos };
        rebuildIndex(newState);
        return newState;
      }),
    setThumbnail: (id: string, thumbnail: string) => {
      pendingThumbnails.set(id, thumbnail);
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
    loadMetadata: async (photoIds: string[]) => {
      if (photoIds.length === 0) return;
      try {
        const metadataMap = await HologramAPI.getPhotoMetadata(photoIds);
        update((state) => {
          const photos = [...state.photos];
          const filteredPhotos = [...state.filteredPhotos];
          for (const [id, meta] of Object.entries(metadataMap)) {
            const pi = photoIndex.get(id);
            const patch = {
              tags: meta.tags ?? [],
              notes: meta.notes ?? "",
              rating: normalizeRating(meta.rating),
              flag: normalizeFlag(meta.flag),
            };
            if (pi !== undefined) photos[pi] = { ...photos[pi], ...patch };
            const fi = filteredIndex.get(id);
            if (fi !== undefined) filteredPhotos[fi] = { ...filteredPhotos[fi], ...patch };
          }
          return { ...state, photos, filteredPhotos };
        });
      } catch (e) {
        console.error("loadMetadata failed:", e);
      }
    },
    reset: () => set(initialState),
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
