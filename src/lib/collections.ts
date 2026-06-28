import type { Photo, SmartCollection } from "./types.ts";

const EVENT_GAP_MS = 6 * 60 * 60 * 1000;
const LOCATION_GAP_KM = 50;

function photoTime(photo: Photo): number {
  const value = photo.exif.date_taken ?? photo.modified_at ?? photo.created_at;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function weekStart(timestamp: number): Date {
  const date = new Date(timestamp);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function distanceKm(a: Photo, b: Photo): number | null {
  const lat1 = a.exif.latitude;
  const lon1 = a.exif.longitude;
  const lat2 = b.exif.latitude;
  const lon2 = b.exif.longitude;
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;

  const toRad = (value: number) => value * Math.PI / 180;
  const earthKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
}

function pushCollection(
  collections: SmartCollection[],
  id: string,
  name: string,
  kind: SmartCollection["kind"],
  detail: string,
  photos: Photo[],
) {
  if (photos.length === 0) return;
  collections.push({
    id,
    name,
    kind,
    detail,
    photo_ids: photos.map((photo) => photo.id),
  });
}

export function buildSmartCollections(photos: Photo[]): SmartCollection[] {
  const sorted = [...photos].sort((a, b) => photoTime(a) - photoTime(b));
  const collections: SmartCollection[] = [];

  const byDay = new Map<string, Photo[]>();
  const byWeek = new Map<string, Photo[]>();
  const byCamera = new Map<string, Photo[]>();

  for (const photo of sorted) {
    const timestamp = photoTime(photo);
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    const week = weekStart(timestamp);
    const weekKey = week.toISOString().slice(0, 10);
    const camera = photo.exif.camera_model ?? photo.exif.camera_make ?? "Unknown Camera";

    byDay.set(dayKey, [...(byDay.get(dayKey) ?? []), photo]);
    byWeek.set(weekKey, [...(byWeek.get(weekKey) ?? []), photo]);
    byCamera.set(camera, [...(byCamera.get(camera) ?? []), photo]);
  }

  const eventGroups: Photo[][] = [];
  let current: Photo[] = [];
  for (const photo of sorted) {
    const previous = current[current.length - 1];
    if (!previous) {
      current = [photo];
      continue;
    }

    const gapMs = photoTime(photo) - photoTime(previous);
    const locationGap = distanceKm(previous, photo);
    if (gapMs > EVENT_GAP_MS || (locationGap != null && locationGap > LOCATION_GAP_KM)) {
      eventGroups.push(current);
      current = [photo];
    } else {
      current = [...current, photo];
    }
  }
  if (current.length > 0) eventGroups.push(current);

  eventGroups
    .filter((group) => group.length >= 3)
    .slice(0, 18)
    .forEach((group, index) => {
      const start = photoTime(group[0]);
      const end = photoTime(group[group.length - 1]);
      pushCollection(
        collections,
        `event-${index}-${group[0].id}`,
        `Event ${index + 1}`,
        "event",
        `${dateLabel(start)} / ${group.length} photos / ${Math.max(1, Math.round((end - start) / 60000))} min`,
        group,
      );
    });

  Array.from(byDay.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 30)
    .forEach(([day, group]) => {
      pushCollection(collections, `day-${day}`, dateLabel(photoTime(group[0])), "day", `${group.length} photos`, group);
    });

  Array.from(byWeek.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)
    .forEach(([week, group]) => {
      pushCollection(collections, `week-${week}`, `Week of ${dateLabel(photoTime(group[0]))}`, "week", `${group.length} photos`, group);
    });

  Array.from(byCamera.entries())
    .filter(([, group]) => group.length >= 2)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 10)
    .forEach(([camera, group]) => {
      pushCollection(collections, `camera-${camera}`, camera, "camera", `${group.length} photos`, group);
    });

  return collections;
}
