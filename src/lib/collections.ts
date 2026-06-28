import type { Photo, SmartCollection, VisualIndexEntry, VisualIndexLabel } from "./types.ts";

const minConfidence = 0.58;

function titleCaseLabel(label: string): string {
  return label.replace(/\b\w/g, (match) => match.toUpperCase());
}

function pushCollection(
  collections: SmartCollection[],
  label: string,
  kind: VisualIndexLabel["kind"],
  photos: Photo[],
  averageConfidence: number,
) {
  if (photos.length < 2) return;
  collections.push({
    id: `visual-${kind}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: titleCaseLabel(label),
    kind,
    detail: `${photos.length} photos / ${Math.round(averageConfidence * 100)}% average signal`,
    photo_ids: photos.map((photo) => photo.id),
  });
}

export function buildSmartCollections(
  photos: Photo[],
  visualIndex: Record<string, VisualIndexEntry>,
): SmartCollection[] {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const buckets = new Map<string, { kind: VisualIndexLabel["kind"]; photos: Photo[]; confidence: number }>();

  for (const [photoId, entry] of Object.entries(visualIndex)) {
    const photo = photosById.get(photoId);
    if (!photo) continue;
    for (const label of entry.labels) {
      if (label.confidence < minConfidence) continue;
      const key = `${label.kind}:${label.label}`;
      const bucket = buckets.get(key) ?? { kind: label.kind, photos: [], confidence: 0 };
      bucket.photos.push(photo);
      bucket.confidence += label.confidence;
      buckets.set(key, bucket);
    }
  }

  const collections: SmartCollection[] = [];
  for (const [key, bucket] of buckets) {
    const label = key.split(":").slice(1).join(":");
    pushCollection(collections, label, bucket.kind, bucket.photos, bucket.confidence / bucket.photos.length);
  }

  const kindRank: Record<VisualIndexLabel["kind"], number> = {
    object: 0,
    scene: 1,
    visual: 2,
  };

  return collections.sort((a, b) => {
    const kindDelta = kindRank[a.kind] - kindRank[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const countDelta = b.photo_ids.length - a.photo_ids.length;
    if (countDelta !== 0) return countDelta;
    return a.name.localeCompare(b.name);
  });
}
