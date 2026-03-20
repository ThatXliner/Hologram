import { writable, derived } from "svelte/store";
import type { Photo, PhotoFilter, PhotoStats, AppState, ScanProgress } from "../types.ts";
import { HologramAPI } from "../api.ts";

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
    setPhotoTags: (photoId: string, tags: string[]) => {
      let currentNotes = "";
      update((state) => {
        const pi = photoIndex.get(photoId);
        const fi = filteredIndex.get(photoId);
        const photos = [...state.photos];
        const filteredPhotos = [...state.filteredPhotos];
        if (pi !== undefined) {
          currentNotes = photos[pi].notes ?? "";
          photos[pi] = { ...photos[pi], tags };
        }
        if (fi !== undefined) filteredPhotos[fi] = { ...filteredPhotos[fi], tags };
        return { ...state, photos, filteredPhotos };
      });
      HologramAPI.setPhotoMetadata(photoId, tags, currentNotes).catch((e) =>
        console.error("setPhotoMetadata failed:", e),
      );
    },
    setPhotoNotes: (photoId: string, notes: string) => {
      let currentTags: string[] = [];
      update((state) => {
        const pi = photoIndex.get(photoId);
        const fi = filteredIndex.get(photoId);
        const photos = [...state.photos];
        const filteredPhotos = [...state.filteredPhotos];
        if (pi !== undefined) {
          currentTags = photos[pi].tags ?? [];
          photos[pi] = { ...photos[pi], notes };
        }
        if (fi !== undefined) filteredPhotos[fi] = { ...filteredPhotos[fi], notes };
        return { ...state, photos, filteredPhotos };
      });
      HologramAPI.setPhotoMetadata(photoId, currentTags, notes).catch((e) =>
        console.error("setPhotoMetadata failed:", e),
      );
    },
    loadMetadata: async (photoIds: string[]) => {
      if (photoIds.length === 0) return;
      try {
        const metadataMap = await HologramAPI.getPhotoMetadata(photoIds);
        update((state) => {
          const photos = [...state.photos];
          const filteredPhotos = [...state.filteredPhotos];
          for (const [id, meta] of Object.entries(metadataMap)) {
            const pi = photoIndex.get(id);
            if (pi !== undefined) photos[pi] = { ...photos[pi], tags: meta.tags, notes: meta.notes };
            const fi = filteredIndex.get(id);
            if (fi !== undefined) filteredPhotos[fi] = { ...filteredPhotos[fi], tags: meta.tags, notes: meta.notes };
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
      const isRaw = ["CR2", "CR3", "ARW", "NEF", "DNG"].includes(photo.file_type);
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
