import { writable, derived } from "svelte/store";
import type { Photo, PhotoFilter, PhotoStats, AppState, ScanProgress } from "../types.ts";

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
