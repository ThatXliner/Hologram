import { writable, derived } from "svelte/store";
import type { Photo, PhotoFilter, PhotoStats, AppState } from "../types.ts";

function createPhotoStore() {
  const initialState: AppState = {
    photos: [],
    filteredPhotos: [],
    currentFilter: {},
    isLoading: false,
    stats: undefined,
    viewMode: "grid",
  };

  const { subscribe, set, update } = writable<AppState>(initialState);

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
      update((state) => ({
        ...state,
        photos,
        filteredPhotos: photos,
      })),
    setFilteredPhotos: (filteredPhotos: Photo[]) =>
      update((state) => ({ ...state, filteredPhotos })),
    setFilter: (filter: PhotoFilter) =>
      update((state) => ({ ...state, currentFilter: filter })),
    setLoading: (isLoading: boolean) =>
      update((state) => ({ ...state, isLoading })),
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
export const stats = derived(photoStore, ($store) => $store.stats);
export const viewMode = derived(photoStore, ($store) => $store.viewMode);
