import type { Photo, SmartCollection, VisualIndexEntry, VisualIndexLabel } from "./types.ts";

const minConfidence = 0.55;

const accentByKind: Record<SmartCollection["kind"], string> = {
  memory: "from-rose-500 to-amber-400",
  object: "from-sky-500 to-cyan-400",
  scene: "from-emerald-500 to-teal-400",
  visual: "from-violet-500 to-fuchsia-400",
};

function titleCaseLabel(label: string): string {
  return label.replace(/\b\w/g, (match) => match.toUpperCase());
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function photoDate(photo: Photo): Date {
  return new Date(photo.exif.date_taken ?? photo.modified_at ?? photo.created_at);
}

function monthKey(photo: Photo): string {
  const date = photoDate(photo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function formatCount(count: number): string {
  return `${count} ${count === 1 ? "photo" : "photos"}`;
}

function coverPhotoIds(photos: Photo[], entries: Record<string, VisualIndexEntry>): string[] {
  return [...photos]
    .sort((a, b) => {
      const aScore = entries[a.id]?.labels[0]?.confidence ?? 0;
      const bScore = entries[b.id]?.labels[0]?.confidence ?? 0;
      return bScore - aScore;
    })
    .slice(0, 4)
    .map((photo) => photo.id);
}

function pushCollection(
  collections: SmartCollection[],
  label: string,
  kind: Exclude<VisualIndexLabel["kind"], "memory">,
  photos: Photo[],
  averageConfidence: number,
  entries: Record<string, VisualIndexEntry>,
) {
  if (photos.length < 2) return;
  const collectionKind: SmartCollection["kind"] = kind;
  collections.push({
    id: `visual-${kind}-${slug(label)}`,
    name: titleCaseLabel(label),
    kind: collectionKind,
    label,
    detail: `${formatCount(photos.length)} / ${Math.round(averageConfidence * 100)}% signal`,
    photo_ids: photos.map((photo) => photo.id),
    cover_photo_ids: coverPhotoIds(photos, entries),
    confidence: averageConfidence,
    accent: accentByKind[collectionKind],
  });
}

function dominantLabel(
  photos: Photo[],
  entries: Record<string, VisualIndexEntry>,
): { label: string; confidence: number } | null {
  const labels = new Map<string, { total: number; count: number }>();
  for (const photo of photos) {
    const entry = entries[photo.id];
    if (!entry) continue;
    for (const label of entry.labels) {
      if (label.kind === "memory" || label.confidence < minConfidence) continue;
      const current = labels.get(label.label) ?? { total: 0, count: 0 };
      current.total += label.confidence;
      current.count += 1;
      labels.set(label.label, current);
    }
  }

  const ranked = Array.from(labels.entries())
    .map(([label, score]) => ({
      label,
      confidence: score.total / score.count,
      count: score.count,
    }))
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence);

  return ranked[0] ?? null;
}

function buildMemoryCollections(
  photos: Photo[],
  entries: Record<string, VisualIndexEntry>,
): SmartCollection[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    groups.set(monthKey(photo), [...(groups.get(monthKey(photo)) ?? []), photo]);
  }

  return Array.from(groups.entries()).flatMap(([key, items]) => {
    if (items.length < 4) return [];
    const dominant = dominantLabel(items, entries);
    const month = formatMonth(key);
    const name = dominant ? `${dominant.label} in ${month}` : month;
    return [{
      id: `memory-${slug(key)}-${slug(dominant?.label ?? "moments")}`,
      name,
      kind: "memory",
      label: dominant?.label,
      detail: dominant
        ? `${formatCount(items.length)} / ${Math.round(dominant.confidence * 100)}% theme`
        : formatCount(items.length),
      photo_ids: items.map((photo) => photo.id),
      cover_photo_ids: coverPhotoIds(items, entries),
      confidence: dominant?.confidence ?? 0.5,
      accent: accentByKind.memory,
    } satisfies SmartCollection];
  });
}

export function buildSmartCollections(
  photos: Photo[],
  visualIndex: Record<string, VisualIndexEntry>,
): SmartCollection[] {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const buckets = new Map<string, { kind: Exclude<VisualIndexLabel["kind"], "memory">; photos: Photo[]; confidence: number }>();

  for (const [photoId, entry] of Object.entries(visualIndex)) {
    const photo = photosById.get(photoId);
    if (!photo) continue;
    for (const label of entry.labels) {
      if (label.kind === "memory" || label.confidence < minConfidence) continue;
      const key = `${label.kind}:${label.label}`;
      const bucket = buckets.get(key) ?? { kind: label.kind, photos: [], confidence: 0 };
      bucket.photos.push(photo);
      bucket.confidence += label.confidence;
      buckets.set(key, bucket);
    }
  }

  const collections: SmartCollection[] = buildMemoryCollections(photos, visualIndex);
  for (const [key, bucket] of buckets) {
    const label = key.split(":").slice(1).join(":");
    pushCollection(collections, label, bucket.kind, bucket.photos, bucket.confidence / bucket.photos.length, visualIndex);
  }

  const kindRank: Record<SmartCollection["kind"], number> = {
    memory: 0,
    object: 1,
    scene: 2,
    visual: 3,
  };

  return collections.sort((a, b) => {
    const kindDelta = kindRank[a.kind] - kindRank[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (Math.abs(confidenceDelta) > 0.01) return confidenceDelta;
    const countDelta = b.photo_ids.length - a.photo_ids.length;
    if (countDelta !== 0) return countDelta;
    return a.name.localeCompare(b.name);
  });
}
