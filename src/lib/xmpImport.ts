import { writable } from "svelte/store";
import {
  loadActivePreferenceProfileId,
  loadPairwisePreferences,
  loadPreferenceProfiles,
  loadPreferenceRefinements,
  savePreferenceFeedback,
  type AutoCullPreferenceRefinement,
} from "./autocull.ts";
import { removeAutomaticDecisions } from "./autocullPlan.ts";
import { parseResolutions } from "./autocullReview.ts";
import type { Photo, PhotoMetadata } from "./types.ts";

const ACKNOWLEDGED_IMPORTS_KEY = "hologram.xmp.imports.v1";

export const xmpImportState = writable<{ revision: number; error: string | null; syncing: boolean; failedPhotoIds: string[] }>({
  revision: 0, error: null, syncing: false, failedPhotoIds: [],
});

export function beginXmpImport(): void {
  xmpImportState.update((state) => ({ ...state, revision: state.revision + 1, syncing: true }));
}

export function finishXmpImport(): void {
  xmpImportState.update((state) => ({ ...state, syncing: false }));
}

class XmpImportSyncError extends Error {}

export function xmpImportFailure(error: unknown, photoIds: string[]): Error {
  if (error instanceof XmpImportSyncError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const message = `The imported metadata is saved, but AutoCull could not synchronize. Retry XMP import after resolving the storage error. ${detail}`;
  xmpImportState.update((state) => ({
    revision: state.revision + 1, error: message, syncing: false,
    failedPhotoIds: [...new Set([...state.failedPhotoIds, ...photoIds])],
  }));
  return new XmpImportSyncError(message);
}

export function resolveXmpImportFailure(photoIds: string[]): void {
  const refreshed = new Set(photoIds);
  xmpImportState.update((state) => {
    const failedPhotoIds = state.failedPhotoIds.filter((id) => !refreshed.has(id));
    if (failedPhotoIds.length === state.failedPhotoIds.length) return state;
    return { ...state, revision: state.revision + 1, failedPhotoIds, error: failedPhotoIds.length ? state.error : null };
  });
}

function acknowledgedImports(storage: Storage): Map<string, string> {
  const value: unknown = JSON.parse(storage.getItem(ACKNOWLEDGED_IMPORTS_KEY) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved XMP import receipts.");
  const entries: [string, string][] = [];
  for (const [id, revision] of Object.entries(value)) {
    if (typeof revision !== "string") throw new Error("Invalid saved XMP import receipt.");
    entries.push([id, revision]);
  }
  return new Map(entries);
}

function changedResolutions(storage: Storage, ids: ReadonlySet<string>): { stacks: Set<string>[]; writes: [string, string][] } {
  const stacks: Set<string>[] = [];
  const writes: [string, string][] = [];
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key) continue;
    if (key.startsWith("hologram.autocull.review.v1.")) {
      const resolutions = parseResolutions(storage.getItem(key));
      let changed = false;
      for (const stackKey of Object.keys(resolutions)) {
        const members = new Set(stackKey.split("|"));
        if (![...members].some((id) => ids.has(id))) continue;
        stacks.push(members);
        delete resolutions[stackKey];
        changed = true;
      }
      if (changed) writes.push([key, JSON.stringify(resolutions)]);
    } else if (key.startsWith("hologram.autocull.confirmed:")) {
      const raw: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      if (!Array.isArray(raw)) continue;
      const remaining = raw.filter((stackKey: unknown) => {
        if (typeof stackKey !== "string") return false;
        const members = new Set(stackKey.split("|"));
        if (![...members].some((id) => ids.has(id))) return true;
        stacks.push(members);
        return false;
      });
      if (remaining.length !== raw.length) writes.push([key, JSON.stringify(remaining)]);
    }
  }
  return { stacks, writes };
}

export function reconcileXmpImports(metadata: Record<string, PhotoMetadata>, photos: Photo[]): boolean {
  const imported = Object.entries(metadata).filter(([, item]) => Boolean(item.xmp_cull_revision));
  if (imported.length === 0) {
    resolveXmpImportFailure(Object.keys(metadata));
    return false;
  }
  try {
    if (typeof localStorage === "undefined") throw new Error("Device storage is unavailable.");
    const acknowledged = acknowledgedImports(localStorage);
    const pending = imported.filter(([id, item]) => acknowledged.get(id) !== item.xmp_cull_revision);
    if (pending.length === 0) {
      resolveXmpImportFailure(Object.keys(metadata));
      return false;
    }
    xmpImportState.update((state) => ({ ...state, revision: state.revision + 1 }));
    const ids = new Set(pending.map(([id]) => id));
    const stackIds = new Set(ids);
    for (const photo of photos) {
      if (ids.has(photo.id) && photo.paired_with) stackIds.add(photo.paired_with);
      if (photo.paired_with && ids.has(photo.paired_with)) stackIds.add(photo.id);
    }
    const profiles = loadPreferenceProfiles();
    const activeProfileId = loadActivePreferenceProfileId();
    const now = new Date().toISOString();
    const reviews: AutoCullPreferenceRefinement[] = pending.map(([id, item]) => ({
      photo_id: id, flag: item.flag, rating: item.rating,
      confidence: item.flag === "none" ? 0.62 : 1,
      source: "manual_decision", updated_at: now,
    }));
    const resolutions = changedResolutions(localStorage, stackIds);
    const stacksByPhoto = new Map<string, Set<string>[]>();
    for (const members of resolutions.stacks) {
      for (const id of members) stacksByPhoto.set(id, [...(stacksByPhoto.get(id) ?? []), members]);
    }
    for (const profile of profiles) {
      const refinements = loadPreferenceRefinements(profile.id).filter((row) => !ids.has(row.photo_id));
      const pairs = loadPairwisePreferences(profile.id).filter((pair) =>
        !ids.has(pair.winner_photo_id) && !ids.has(pair.loser_photo_id)
        && !(stacksByPhoto.get(pair.winner_photo_id) ?? []).some((members) => members.has(pair.loser_photo_id)),
      );
      savePreferenceFeedback(profile.id, profile.id === activeProfileId ? [...refinements, ...reviews] : refinements, pairs);
    }
    for (const [key, value] of resolutions.writes) localStorage.setItem(key, value);
    removeAutomaticDecisions(localStorage, ids);
    for (const [id, item] of pending) {
      if (item.xmp_cull_revision) acknowledged.set(id, item.xmp_cull_revision);
    }
    localStorage.setItem(ACKNOWLEDGED_IMPORTS_KEY, JSON.stringify(Object.fromEntries(acknowledged)));
    resolveXmpImportFailure(Object.keys(metadata));
    return true;
  } catch (error) {
    throw xmpImportFailure(error, Object.keys(metadata));
  }
}
