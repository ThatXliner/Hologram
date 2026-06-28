export type CullFlag = "none" | "pick" | "reject";

export interface EmbeddedJpegPreview {
  width: number;
  height: number;
  byte_size: number;
}

export interface Photo {
  id: string;
  file_path: string;
  file_name: string;
  file_size: number;
  file_type: string;
  thumbnail?: string; // base64 encoded thumbnail
  exif: ExifData;
  created_at: string;
  modified_at: string;
  paired_with?: string; // ID of paired RAW/JPEG
  embedded_jpeg_preview?: EmbeddedJpegPreview | null;
  paired_raw_embedded_jpeg_preview?: EmbeddedJpegPreview | null;
  tags?: string[];
  notes?: string;
  rating?: number; // 0-5 stars
  flag?: CullFlag;
}

export interface ExifData {
  camera_make?: string;
  camera_model?: string;
  lens_model?: string;
  focal_length?: number;
  aperture?: number;
  shutter_speed?: string;
  iso?: number;
  exposure_mode?: string;
  flash?: string;
  white_balance?: string;
  date_taken?: string;
  exposure_bias?: number;
  ev100?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  width?: number;
  height?: number;
  orientation?: number;
}

export interface PhotoFilter {
  search?: string; // text search across filename + all metadata
  camera_make?: string;
  camera_model?: string;
  lens_model?: string;
  focal_length_range?: [number, number];
  aperture_range?: [number, number];
  iso_range?: [number, number];
  date_range?: [string, string];
  file_type?: string;
  shutter_speed?: string;
  exposure_mode?: string;
  flash?: string;
  white_balance?: string;
  tags?: string[]; // filter photos that have ALL of these tags
  rating_gte?: number;
  flag?: CullFlag;
}

export interface ImageAdjustmentSettings {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  highlights: number;
  shadows: number;
  sharpen: number;
  curve_points: [number, number][];
}

export interface RawProcessingPreset {
  id: string;
  name: string;
  source: "built-in" | "manual" | "lightroom-xmp" | "darktable-xmp" | "cube" | "xmp";
  adjustments: ImageAdjustmentSettings;
  notes?: string;
  created_at?: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  filter: PhotoFilter;
  search: string;
  cull_filter: "all" | CullFlag;
  min_rating: number;
  hide_rejects: boolean;
  created_at: string;
  updated_at: string;
}

export interface SmartCollection {
  id: string;
  name: string;
  kind: "memory" | "object" | "scene" | "visual";
  detail: string;
  photo_ids: string[];
  cover_photo_ids?: string[];
  confidence?: number;
  label?: string;
  accent?: string;
}

export interface VisualIndexLabel {
  label: string;
  kind: "memory" | "object" | "scene" | "visual";
  confidence: number;
  source: "image" | "metadata" | "model";
  reason?: string;
  evidence?: string[];
  boxes?: ObjectDetectionBox[];
}

export interface ObjectDetectionBox {
  id: string;
  label: string;
  confidence: number;
  source: "model";
  model_id: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VisualIndexEntry {
  photo_id: string;
  labels: VisualIndexLabel[];
  detections?: ObjectDetectionBox[];
  indexed_at: string;
  detector_model_id?: string;
}

export interface VisualIndexProgress {
  current: number;
  total: number;
  current_file?: string;
}

export interface ObjectDetectionModelManifest {
  id: string;
  name: string;
  repository: string;
  version: string;
  source_name: string;
  source_url: string;
  download_url: string;
  approximate_size_bytes: number;
  license: string;
  dtype: string;
  storage_label: string;
}

export type ObjectDetectionModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface ObjectDetectionModelState {
  status: ObjectDetectionModelStatus;
  manifest_id: string;
  version: string;
  downloaded_at?: string;
  bytes?: number;
  cache_key?: string;
  last_error?: string;
}

export interface ObjectDetectionModelProgress {
  phase: "requesting" | "downloading" | "storing" | "ready" | "error";
  received_bytes: number;
  total_bytes: number;
  percent: number;
}

export interface ExportOptions {
  destination_path: string;
  mode: "folder" | "zip" | "lightroom";
  pair_mode: "visible" | "raw" | "jpeg" | "both";
  organize_by: "flat" | "date" | "camera";
  rename_pattern?: string;
  include_metadata: boolean;
}

export interface ExportResult {
  exported_count: number;
  skipped_count: number;
  output_path: string;
  metadata_path?: string;
}

export interface PhotoMetadata {
  tags: string[];
  notes: string;
  rating: number;
  flag: CullFlag;
}

export interface PhotoStats {
  total_photos: number;
  raw_count: number;
  jpeg_count: number;
  paired_count: number;
  raw_embedded_jpeg_preview_count?: number;
  raw_jpeg_redundancy_count?: number;
  cameras: Record<string, number>;
  lenses: Record<string, number>;
}

export interface ScanResult {
  photos: Photo[];
  stats: PhotoStats;
}

export interface ThumbnailReady {
  id: string;
  thumbnail: string;
}

export interface ScanProgress {
  current: number;
  total: number;
  percentage: number;
  current_file?: string;
}

export interface AppState {
  photos: Photo[];
  filteredPhotos: Photo[];
  currentFilter: PhotoFilter;
  isLoading: boolean;
  scanProgress?: ScanProgress;
  stats?: PhotoStats;
  viewMode: "grid" | "list" | "viewer";
  selectedIndex: number;
}
