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
      // Mutate in place for performance (these arrays are owned by the store)
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
      // Return new refs so Svelte detects the change
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
export const currentFilter = derived(
  photoStore,
  ($store) => $store.currentFilter,
);
export const isLoading = derived(photoStore, ($store) => $store.isLoading);
export const scanProgress = derived(photoStore, ($store) => $store.scanProgress);
export const stats = derived(photoStore, ($store) => $store.stats);
export const viewMode = derived(photoStore, ($store) => $store.viewMode);
