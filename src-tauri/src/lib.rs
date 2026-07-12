use anyhow::Result;
use chrono::{DateTime, Utc};
use exif as kamadak_exif;
use image::ImageFormat;
use kamadak_exif::{In, Reader};
use ndarray::Array4;
use ort::session::Session;
use rayon::prelude::*;
use rusqlite;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

mod raw_preview;
use raw_preview::{
    convert_raw_display_preview_to_jpeg, generate_embedded_thumbnail, generate_thumbnail_with_info,
    is_raw_file, is_supported_file, orient_image_to_jpeg_if_needed, read_cached_raw_render,
    render_raw_to_jpeg, EmbeddedJpegPreview,
};
const THUMBNAIL_CACHE_VERSION: &str = "thumbnail-v1-400px-jpeg90";
// Higher than current still-camera dimensions, so cached RAW renders retain
// their decoded resolution while still using the shared bounded API.
const RAW_FULL_RENDER_MAX_DIMENSION: u32 = 32_768;
static RAW_RENDER_PRIORITY_QUEUE: OnceLock<Mutex<VecDeque<Photo>>> = OnceLock::new();

fn raw_render_priority_queue() -> &'static Mutex<VecDeque<Photo>> {
    RAW_RENDER_PRIORITY_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}
#[cfg(not(target_env = "msvc"))]
use rsraw::RawImage;

/// Managed state holding the DnCNN ONNX session for AI denoising.
pub struct DenoiseModel(Arc<Mutex<Option<Session>>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub thumbnail: Option<String>, // base64 encoded thumbnail
    pub exif: ExifData,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub paired_with: Option<String>, // ID of paired RAW/JPEG
    pub embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
    pub paired_raw_embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    pub rating: Option<u8>,
    pub flag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExifData {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub focal_length: Option<f64>,
    pub aperture: Option<f64>,
    pub shutter_speed: Option<String>,
    pub iso: Option<u32>,
    pub exposure_mode: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub date_taken: Option<DateTime<Utc>>,
    pub exposure_bias: Option<f64>,
    pub ev100: Option<f64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub orientation: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoFilter {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub focal_length_range: Option<(f64, f64)>,
    pub aperture_range: Option<(f64, f64)>,
    pub iso_range: Option<(u32, u32)>,
    pub date_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub file_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub percentage: f64,
    pub current_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailReady {
    pub id: String,
    pub thumbnail: String,
    pub embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RawRenderReady {
    pub id: String,
}

#[derive(Debug, Clone)]
struct ThumbnailCacheEntry {
    id: String,
    file_path: String,
    file_size: u64,
    modified_at: String,
    thumbnail: String,
    embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub photos: Vec<Photo>,
    pub stats: PhotoStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoStats {
    pub total_photos: usize,
    pub raw_count: usize,
    pub jpeg_count: usize,
    pub paired_count: usize,
    pub raw_embedded_jpeg_preview_count: usize,
    pub raw_jpeg_redundancy_count: usize,
    pub cameras: HashMap<String, usize>,
    pub lenses: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub destination_path: String,
    pub mode: String,
    pub pair_mode: String,
    pub organize_by: String,
    pub rename_pattern: Option<String>,
    pub include_metadata: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub exported_count: usize,
    pub skipped_count: usize,
    pub output_path: String,
    pub metadata_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XmpSidecarResult {
    pub processed_count: usize,
    pub skipped_count: usize,
}

fn first_exif_u32(value: &kamadak_exif::Value) -> Option<u32> {
    match value {
        kamadak_exif::Value::Byte(values) => values.first().map(|value| u32::from(*value)),
        kamadak_exif::Value::Short(values) => values.first().map(|value| u32::from(*value)),
        kamadak_exif::Value::Long(values) => values.first().copied(),
        _ => None,
    }
}

fn first_exif_f64(value: &kamadak_exif::Value) -> Option<f64> {
    match value {
        kamadak_exif::Value::Short(values) => values.first().map(|value| f64::from(*value)),
        kamadak_exif::Value::Long(values) => values.first().map(|value| f64::from(*value)),
        kamadak_exif::Value::Rational(values) => values
            .first()
            .filter(|value| value.denom != 0)
            .map(|value| value.to_f64()),
        kamadak_exif::Value::SRational(values) => values
            .first()
            .filter(|value| value.denom != 0)
            .map(|value| value.to_f64()),
        _ => None,
    }
}

fn first_exif_ascii(value: &kamadak_exif::Value) -> Option<String> {
    match value {
        kamadak_exif::Value::Ascii(values) => values.first().and_then(|bytes| {
            String::from_utf8(bytes.clone())
                .ok()
                .map(|value| value.trim_matches(char::from(0)).trim().to_string())
                .filter(|value| !value.is_empty())
        }),
        _ => None,
    }
}

fn clean_metadata_string(value: impl AsRef<str>) -> Option<String> {
    let value = value
        .as_ref()
        .trim_matches(char::from(0))
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn fill_missing<T>(target: &mut Option<T>, value: Option<T>) {
    if target.is_none() {
        *target = value;
    }
}

fn format_shutter_speed(seconds: f32) -> Option<String> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }

    if seconds < 1.0 {
        let denominator = (1.0 / seconds).round();
        if denominator >= 1.0 {
            return Some(format!("1/{denominator:.0} s"));
        }
    }

    if (seconds.fract()).abs() < f32::EPSILON {
        Some(format!("{seconds:.0} s"))
    } else {
        Some(format!("{seconds:.2} s"))
    }
}

fn gps_parts_to_decimal(parts: [f32; 3]) -> Option<f64> {
    if parts == [0.0, 0.0, 0.0] || parts.iter().any(|part| !part.is_finite()) {
        return None;
    }

    let sign = if parts.iter().any(|part| *part < 0.0) {
        -1.0
    } else {
        1.0
    };
    let degrees = f64::from(parts[0].abs());
    let minutes = f64::from(parts[1].abs());
    let seconds = f64::from(parts[2].abs());
    Some(sign * (degrees + minutes / 60.0 + seconds / 3600.0))
}

#[cfg(not(target_env = "msvc"))]
fn extract_raw_metadata(file_path: &Path) -> Result<ExifData> {
    let raw_bytes = fs::read(file_path)?;
    let raw_image = RawImage::open(&raw_bytes)?;
    let info = raw_image.full_info();
    let mut exif_data = ExifData::default();

    exif_data.camera_make =
        clean_metadata_string(&info.normalized_make).or_else(|| clean_metadata_string(&info.make));
    exif_data.camera_model = clean_metadata_string(&info.normalized_model)
        .or_else(|| clean_metadata_string(&info.model));
    exif_data.lens_model = clean_metadata_string(&info.lens_info.lens_name);
    exif_data.focal_length =
        (info.focal_len.is_finite() && info.focal_len > 0.0).then_some(f64::from(info.focal_len));
    exif_data.aperture =
        (info.aperture.is_finite() && info.aperture > 0.0).then_some(f64::from(info.aperture));
    exif_data.shutter_speed = format_shutter_speed(info.shutter);
    exif_data.iso = (info.iso_speed > 0).then_some(info.iso_speed);
    exif_data.date_taken = info.datetime.map(|datetime| datetime.with_timezone(&Utc));
    exif_data.width = (info.width > 0).then_some(info.width);
    exif_data.height = (info.height > 0).then_some(info.height);
    exif_data.latitude = gps_parts_to_decimal(info.gps.latitude);
    exif_data.longitude = gps_parts_to_decimal(info.gps.longitude);
    if exif_data.latitude.is_some() && exif_data.longitude.is_some() {
        exif_data.altitude = info
            .gps
            .altitude
            .is_finite()
            .then_some(f64::from(info.gps.altitude));
    }

    let exposure_seconds =
        (info.shutter.is_finite() && info.shutter > 0.0).then_some(f64::from(info.shutter));
    exif_data.ev100 = exposure_ev100(exif_data.aperture, exposure_seconds, exif_data.iso);

    Ok(exif_data)
}

#[cfg(target_env = "msvc")]
fn extract_raw_metadata(_file_path: &Path) -> Result<ExifData> {
    Ok(ExifData::default())
}

fn merge_exif_data(target: &mut ExifData, fallback: ExifData) {
    fill_missing(&mut target.camera_make, fallback.camera_make);
    fill_missing(&mut target.camera_model, fallback.camera_model);
    fill_missing(&mut target.lens_model, fallback.lens_model);
    fill_missing(&mut target.focal_length, fallback.focal_length);
    fill_missing(&mut target.aperture, fallback.aperture);
    fill_missing(&mut target.shutter_speed, fallback.shutter_speed);
    fill_missing(&mut target.iso, fallback.iso);
    fill_missing(&mut target.exposure_mode, fallback.exposure_mode);
    fill_missing(&mut target.flash, fallback.flash);
    fill_missing(&mut target.white_balance, fallback.white_balance);
    fill_missing(&mut target.date_taken, fallback.date_taken);
    fill_missing(&mut target.exposure_bias, fallback.exposure_bias);
    fill_missing(&mut target.ev100, fallback.ev100);
    fill_missing(&mut target.latitude, fallback.latitude);
    fill_missing(&mut target.longitude, fallback.longitude);
    fill_missing(&mut target.altitude, fallback.altitude);
    fill_missing(&mut target.width, fallback.width);
    fill_missing(&mut target.height, fallback.height);
    fill_missing(&mut target.orientation, fallback.orientation);
}

fn gps_coordinate(
    value: &kamadak_exif::Value,
    ref_value: Option<&kamadak_exif::Value>,
) -> Option<f64> {
    let parts = match value {
        kamadak_exif::Value::Rational(values) if values.len() >= 3 => values,
        _ => return None,
    };
    if parts.iter().take(3).any(|part| part.denom == 0) {
        return None;
    }

    let mut coordinate = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    if let Some(reference) = ref_value.and_then(first_exif_ascii) {
        if matches!(reference.as_str(), "S" | "W") {
            coordinate = -coordinate;
        }
    }
    Some(coordinate)
}

fn exposure_ev100(
    aperture: Option<f64>,
    exposure_seconds: Option<f64>,
    iso: Option<u32>,
) -> Option<f64> {
    let aperture = aperture.filter(|value| *value > 0.0)?;
    let exposure_seconds = exposure_seconds.filter(|value| *value > 0.0)?;
    let iso = f64::from(iso.filter(|value| *value > 0)?);
    Some((aperture * aperture / exposure_seconds).log2() - (iso / 100.0).log2())
}

fn extract_exif_data(file_path: &Path) -> Result<ExifData> {
    let file = fs::File::open(file_path)?;
    let mut bufreader = std::io::BufReader::new(&file);
    let exifreader = Reader::new();

    let mut exif_data = ExifData::default();

    if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
        if let Some(field) = exif.get_field(kamadak_exif::Tag::Make, In::PRIMARY) {
            exif_data.camera_make = Some(field.display_value().to_string());
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::Model, In::PRIMARY) {
            exif_data.camera_model = Some(field.display_value().to_string());
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::LensModel, In::PRIMARY) {
            exif_data.lens_model = Some(field.display_value().to_string());
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::FocalLength, In::PRIMARY) {
            if let kamadak_exif::Value::Rational(ref vec) = field.value {
                if let Some(rational) = vec.first() {
                    exif_data.focal_length = Some(rational.to_f64());
                }
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::FNumber, In::PRIMARY) {
            if let kamadak_exif::Value::Rational(ref vec) = field.value {
                if let Some(rational) = vec.first() {
                    exif_data.aperture = Some(rational.to_f64());
                }
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::PhotographicSensitivity, In::PRIMARY)
        {
            exif_data.iso = first_exif_u32(&field.value);
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ExposureTime, In::PRIMARY) {
            exif_data.shutter_speed = Some(field.display_value().to_string());
        }
        let exposure_seconds = exif
            .get_field(kamadak_exif::Tag::ExposureTime, In::PRIMARY)
            .and_then(|field| first_exif_f64(&field.value));
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ExposureBiasValue, In::PRIMARY) {
            exif_data.exposure_bias = first_exif_f64(&field.value);
        }
        exif_data.ev100 = exposure_ev100(exif_data.aperture, exposure_seconds, exif_data.iso);
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ImageWidth, In::PRIMARY) {
            exif_data.width = first_exif_u32(&field.value);
        }
        if exif_data.width.is_none() {
            if let Some(field) = exif.get_field(kamadak_exif::Tag::PixelXDimension, In::PRIMARY) {
                exif_data.width = first_exif_u32(&field.value);
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ImageLength, In::PRIMARY) {
            exif_data.height = first_exif_u32(&field.value);
        }
        if exif_data.height.is_none() {
            if let Some(field) = exif.get_field(kamadak_exif::Tag::PixelYDimension, In::PRIMARY) {
                exif_data.height = first_exif_u32(&field.value);
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::Orientation, In::PRIMARY) {
            exif_data.orientation =
                first_exif_u32(&field.value).and_then(|value| u16::try_from(value).ok());
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::GPSLatitude, In::PRIMARY) {
            let ref_value = exif
                .get_field(kamadak_exif::Tag::GPSLatitudeRef, In::PRIMARY)
                .map(|field| &field.value);
            exif_data.latitude = gps_coordinate(&field.value, ref_value);
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::GPSLongitude, In::PRIMARY) {
            let ref_value = exif
                .get_field(kamadak_exif::Tag::GPSLongitudeRef, In::PRIMARY)
                .map(|field| &field.value);
            exif_data.longitude = gps_coordinate(&field.value, ref_value);
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::GPSAltitude, In::PRIMARY) {
            exif_data.altitude = first_exif_f64(&field.value);
            if let Some(altitude_ref) = exif
                .get_field(kamadak_exif::Tag::GPSAltitudeRef, In::PRIMARY)
                .and_then(|field| first_exif_u32(&field.value))
            {
                if altitude_ref == 1 {
                    exif_data.altitude = exif_data.altitude.map(|value| -value);
                }
            }
        }
    }

    if is_raw_file(file_path) {
        if let Ok(raw_exif_data) = extract_raw_metadata(file_path) {
            merge_exif_data(&mut exif_data, raw_exif_data);
        }
    }

    Ok(exif_data)
}

/// Phase 1: Collect metadata + EXIF only (no image decoding). This is fast
/// because it only reads file headers, not pixel data.
fn collect_photo_metadata(path: &Path) -> Option<Photo> {
    if !is_supported_file(path) {
        return None;
    }

    let metadata = fs::metadata(path).ok()?;
    let file_size = metadata.len();
    let modified_at = metadata
        .modified()
        .map(|time| DateTime::<Utc>::from(time))
        .unwrap_or_else(|_| Utc::now());

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_type = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("unknown")
        .to_uppercase();

    let exif_data = extract_exif_data(path).unwrap_or_default();
    let thumbnail = if is_browser_preview_file(path) {
        generate_embedded_thumbnail(path)
    } else {
        None
    };

    Some(Photo {
        id: stable_photo_id(path),
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_size,
        file_type,
        thumbnail,
        exif: exif_data,
        created_at: Utc::now(),
        modified_at,
        paired_with: None,
        embedded_jpeg_preview: None,
        paired_raw_embedded_jpeg_preview: None,
        tags: None,
        notes: None,
        rating: None,
        flag: None,
    })
}

fn stable_photo_id(path: &Path) -> String {
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    Uuid::new_v5(&Uuid::NAMESPACE_URL, canonical.as_bytes()).to_string()
}

fn compute_stats(photos: &[Photo]) -> PhotoStats {
    let mut raw_count = 0;
    let mut paired_count = 0;
    let mut raw_embedded_jpeg_preview_count = 0;
    let mut raw_jpeg_redundancy_count = 0;
    let mut cameras: HashMap<String, usize> = HashMap::new();
    let mut lenses: HashMap<String, usize> = HashMap::new();

    for photo in photos {
        let is_raw = is_raw_file(Path::new(&photo.file_path));
        if is_raw {
            raw_count += 1;
            if photo.embedded_jpeg_preview.is_some() {
                raw_embedded_jpeg_preview_count += 1;
                if photo.paired_with.is_some() {
                    raw_jpeg_redundancy_count += 1;
                }
            }
        }
        if photo.paired_with.is_some() {
            paired_count += 1;
        }
        if let Some(ref camera) = photo.exif.camera_model {
            *cameras.entry(camera.clone()).or_insert(0) += 1;
        }
        if let Some(ref lens) = photo.exif.lens_model {
            *lenses.entry(lens.clone()).or_insert(0) += 1;
        }
    }

    let total_photos = photos.len();
    PhotoStats {
        total_photos,
        raw_count,
        jpeg_count: total_photos - raw_count,
        paired_count,
        raw_embedded_jpeg_preview_count,
        raw_jpeg_redundancy_count,
        cameras,
        lenses,
    }
}

fn pair_raw_jpeg(photos: &mut Vec<Photo>) {
    let mut base_names: HashMap<String, Vec<usize>> = HashMap::new();

    for (i, photo) in photos.iter().enumerate() {
        let path = Path::new(&photo.file_path);
        if let Some(stem) = path.file_stem() {
            if let Some(stem_str) = stem.to_str() {
                let parent = path
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_default();
                base_names
                    .entry(format!("{parent}\0{stem_str}"))
                    .or_insert_with(Vec::new)
                    .push(i);
            }
        }
    }

    for indices in base_names.values() {
        if indices.len() > 1 {
            let mut raw_idx = None;
            let mut jpeg_idx = None;

            for &i in indices {
                let path = Path::new(&photos[i].file_path);
                if is_raw_file(path) {
                    raw_idx = Some(i);
                } else {
                    jpeg_idx = Some(i);
                }
            }

            if let (Some(raw), Some(jpeg)) = (raw_idx, jpeg_idx) {
                let raw_id = photos[raw].id.clone();
                let jpeg_id = photos[jpeg].id.clone();
                let raw_embedded_jpeg_preview = photos[raw].embedded_jpeg_preview.clone();

                photos[raw].paired_with = Some(jpeg_id);
                photos[jpeg].paired_with = Some(raw_id);
                photos[jpeg].paired_raw_embedded_jpeg_preview = raw_embedded_jpeg_preview;
            }
        }
    }
}

fn is_browser_preview_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif"
            )
        })
}

fn is_jpeg_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg"))
}

fn load_full_resolution_image(file_path: &Path) -> Response {
    const RAW_VIEWER_PREVIEW_MAX_DIMENSION: u32 = 8192;

    // Use a background-generated full render when it is ready. Until then,
    // return the embedded preview immediately so viewer navigation never waits
    // for LibRaw processing.
    if is_raw_file(file_path) {
        let data = read_cached_raw_render(file_path, RAW_FULL_RENDER_MAX_DIMENSION)
            .or_else(|| {
                convert_raw_display_preview_to_jpeg(file_path, RAW_VIEWER_PREVIEW_MAX_DIMENSION)
                    .ok()
            })
            .unwrap_or_default();
        return tauri::ipc::Response::new(data);
    }

    if is_jpeg_file(file_path) {
        if let Ok(Some(data)) = orient_image_to_jpeg_if_needed(file_path) {
            return tauri::ipc::Response::new(data);
        }
    }

    // For images without a required orientation transform, send the original
    // file bytes directly.
    let data = fs::read(file_path).unwrap_or_default();
    tauri::ipc::Response::new(data)
}

/// Phase 1: Fast scan — metadata + EXIF only, no image decoding.
/// Returns photos (with thumbnail: None) and computed stats.
#[tauri::command]
async fn scan_folder_fast(folder_path: String, app: AppHandle) -> Result<ScanResult, String> {
    let paths: Vec<std::path::PathBuf> = WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| is_supported_file(path))
        .collect();

    let total_files = paths.len();

    // Use rayon for parallel EXIF extraction (CPU-bound, no image decoding)
    let mut photos: Vec<Photo> = tokio::task::spawn_blocking(move || {
        paths
            .par_iter()
            .filter_map(|path| collect_photo_metadata(path))
            .collect()
    })
    .await
    .map_err(|e| format!("Scan failed: {}", e))?;

    pair_raw_jpeg(&mut photos);
    let stats = compute_stats(&photos);

    let _ = app.emit(
        "scan-complete",
        &ScanProgress {
            current: total_files,
            total: total_files,
            percentage: 100.0,
            current_file: None,
        },
    );

    Ok(ScanResult { photos, stats })
}

/// Phase 2: Generate thumbnails in background, streaming each one to the
/// frontend as it completes via "thumbnail-ready" events.
#[tauri::command]
async fn generate_thumbnails(
    photos: Vec<Photo>,
    folder_path: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let items: Vec<Photo> = photos
        .into_iter()
        .filter(|p| p.thumbnail.is_none() || is_browser_preview_file(Path::new(&p.file_path)))
        .collect();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_cache_db(&app, folder_path.as_deref())?;
        let mut cached = HashMap::new();
        {
            let mut statement = conn
                .prepare(
                    "SELECT file_path, file_size, modified_at, thumbnail, embedded_preview_json
                     FROM thumbnail_cache WHERE photo_id = ?1 AND version = ?2",
                )
                .map_err(|e| e.to_string())?;
            for photo in &items {
                if let Ok(entry) = statement.query_row(
                    rusqlite::params![photo.id, THUMBNAIL_CACHE_VERSION],
                    |row| {
                        let preview_json: Option<String> = row.get(4)?;
                        Ok(ThumbnailCacheEntry {
                            id: photo.id.clone(),
                            file_path: row.get(0)?,
                            file_size: row.get(1)?,
                            modified_at: row.get(2)?,
                            thumbnail: row.get(3)?,
                            embedded_jpeg_preview: preview_json
                                .and_then(|json| serde_json::from_str(&json).ok()),
                        })
                    },
                ) {
                    if entry.file_path == photo.file_path
                        && entry.file_size == photo.file_size
                        && entry.modified_at == photo.modified_at.to_rfc3339()
                    {
                        cached.insert(photo.id.clone(), entry);
                    }
                }
            }
        }

        for entry in cached.values() {
            let _ = app.emit(
                "thumbnail-ready",
                &ThumbnailReady {
                    id: entry.id.clone(),
                    thumbnail: entry.thumbnail.clone(),
                    embedded_jpeg_preview: entry.embedded_jpeg_preview.clone(),
                },
            );
        }

        let generated: Vec<ThumbnailCacheEntry> = items
            .par_iter()
            .filter(|photo| !cached.contains_key(&photo.id))
            .filter_map(|photo| {
                generate_thumbnail_with_info(Path::new(&photo.file_path))
                    .ok()
                    .map(|generated| ThumbnailCacheEntry {
                        id: photo.id.clone(),
                        file_path: photo.file_path.clone(),
                        file_size: photo.file_size,
                        modified_at: photo.modified_at.to_rfc3339(),
                        thumbnail: generated.thumbnail,
                        embedded_jpeg_preview: generated.embedded_jpeg_preview,
                    })
            })
            .collect();

        for entry in &generated {
                let event = ThumbnailReady {
                id: entry.id.clone(),
                thumbnail: entry.thumbnail.clone(),
                embedded_jpeg_preview: entry.embedded_jpeg_preview.clone(),
                };
                let _ = app.emit("thumbnail-ready", &event);
        }

        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO thumbnail_cache
                     (photo_id, version, cached_at, file_path, file_size, modified_at, thumbnail, embedded_preview_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(photo_id) DO UPDATE SET version=excluded.version,
                       cached_at=excluded.cached_at, file_path=excluded.file_path,
                       file_size=excluded.file_size, modified_at=excluded.modified_at,
                       thumbnail=excluded.thumbnail, embedded_preview_json=excluded.embedded_preview_json",
                )
                .map_err(|e| e.to_string())?;
            let cached_at = Utc::now().to_rfc3339();
            for entry in generated {
                let preview_json = entry
                    .embedded_jpeg_preview
                    .map(|preview| serde_json::to_string(&preview))
                    .transpose()
                    .map_err(|e| e.to_string())?;
                statement
                    .execute(rusqlite::params![
                        entry.id,
                        THUMBNAIL_CACHE_VERSION,
                        cached_at,
                        entry.file_path,
                        entry.file_size,
                        entry.modified_at,
                        entry.thumbnail,
                        preview_json,
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Thumbnail generation failed: {}", e))??;

    Ok(())
}

/// Phase 3: progressively render every RAW at viewer resolution. This is
/// intentionally sequential: it fills the disk cache in the background
/// without letting a large import monopolize all CPU cores and memory.
#[tauri::command]
async fn prerender_raws(photos: Vec<Photo>, app: AppHandle) -> Result<(), String> {
    let raws: VecDeque<Photo> = photos
        .into_iter()
        .filter(|photo| is_raw_file(Path::new(&photo.file_path)))
        .collect();

    if let Ok(mut priority) = raw_render_priority_queue().lock() {
        priority.clear();
    }

    tokio::task::spawn_blocking(move || {
        let mut remaining = raws;
        let mut processed = HashSet::new();
        loop {
            let prioritized = raw_render_priority_queue()
                .lock()
                .ok()
                .and_then(|mut queue| queue.pop_front());
            let Some(photo) = prioritized.or_else(|| remaining.pop_front()) else {
                break;
            };
            if !processed.insert(photo.id.clone()) {
                continue;
            }
            if render_raw_to_jpeg(Path::new(&photo.file_path), RAW_FULL_RENDER_MAX_DIMENSION)
                .is_ok()
            {
                let _ = app.emit("raw-render-ready", RawRenderReady { id: photo.id });
            }
        }
    })
    .await
    .map_err(|e| format!("RAW pre-rendering failed: {e}"))?;

    Ok(())
}

/// Move RAWs represented by currently visible UI previews to the front of the
/// sequential background render queue.
#[tauri::command]
fn prioritize_raw_renders(photos: Vec<Photo>) {
    let Ok(mut queue) = raw_render_priority_queue().lock() else {
        return;
    };
    for photo in photos.into_iter().rev() {
        if !is_raw_file(Path::new(&photo.file_path)) {
            continue;
        }
        if let Some(index) = queue.iter().position(|queued| queued.id == photo.id) {
            queue.remove(index);
        }
        queue.push_front(photo);
    }
}

#[tauri::command]
async fn filter_photos(photos: Vec<Photo>, filter: PhotoFilter) -> Result<Vec<Photo>, String> {
    let filter = Arc::new(filter);

    let filtered: Vec<Photo> = photos
        .into_par_iter()
        .filter(|photo| {
            let filter = Arc::clone(&filter);

            if let Some(ref make) = filter.camera_make {
                if photo
                    .exif
                    .camera_make
                    .as_ref()
                    .map_or(true, |m| !m.contains(make))
                {
                    return false;
                }
            }
            if let Some(ref model) = filter.camera_model {
                if photo
                    .exif
                    .camera_model
                    .as_ref()
                    .map_or(true, |m| !m.contains(model))
                {
                    return false;
                }
            }
            if let Some(ref lens) = filter.lens_model {
                if photo
                    .exif
                    .lens_model
                    .as_ref()
                    .map_or(true, |l| !l.contains(lens))
                {
                    return false;
                }
            }
            if let Some((min_fl, max_fl)) = filter.focal_length_range {
                if let Some(fl) = photo.exif.focal_length {
                    if fl < min_fl || fl > max_fl {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            if let Some((min_ap, max_ap)) = filter.aperture_range {
                if let Some(ap) = photo.exif.aperture {
                    if ap < min_ap || ap > max_ap {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            if let Some((min_iso, max_iso)) = filter.iso_range {
                if let Some(iso) = photo.exif.iso {
                    if iso < min_iso || iso > max_iso {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            if let Some(ref file_type) = filter.file_type {
                if photo.file_type != *file_type {
                    return false;
                }
            }

            true
        })
        .collect();

    Ok(filtered)
}

#[tauri::command]
async fn get_photo_stats(photos: Vec<Photo>) -> Result<PhotoStats, String> {
    Ok(compute_stats(&photos))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAdjustments {
    pub exposure: f64,                 // -100 to 100
    pub contrast: f64,                 // -100 to 100
    pub saturation: f64,               // -100 to 100
    pub temperature: f64,              // -100 to 100
    pub highlights: f64,               // -100 to 100
    pub shadows: f64,                  // -100 to 100
    pub sharpen: f64,                  // 0 to 100
    pub curve_points: Vec<(f64, f64)>, // (x, y) in 0-255 space
}

fn build_curve_lut(points: &[(f64, f64)]) -> [u8; 256] {
    let mut lut = [0u8; 256];
    let mut pts: Vec<(f64, f64)> = points.to_vec();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    if pts.len() < 2 {
        for i in 0..256 {
            lut[i] = i as u8;
        }
        return lut;
    }

    let n = pts.len();
    let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = pts.iter().map(|p| p.1).collect();

    // Compute finite differences
    let mut deltas: Vec<f64> = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let dx = xs[i + 1] - xs[i];
        deltas.push(if dx.abs() < 1e-6 {
            0.0
        } else {
            (ys[i + 1] - ys[i]) / dx
        });
    }

    // Initial tangents
    let mut m = vec![0.0f64; n];
    m[0] = deltas[0];
    m[n - 1] = deltas[n - 2];
    for i in 1..n - 1 {
        if deltas[i - 1] * deltas[i] <= 0.0 {
            m[i] = 0.0;
        } else {
            m[i] = (deltas[i - 1] + deltas[i]) / 2.0;
        }
    }

    // Fritsch-Carlson monotonicity
    for i in 0..n - 1 {
        if deltas[i].abs() < 1e-6 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let alpha = m[i] / deltas[i];
            let beta = m[i + 1] / deltas[i];
            let tau = alpha * alpha + beta * beta;
            if tau > 9.0 {
                let t = 3.0 / tau.sqrt();
                m[i] = t * alpha * deltas[i];
                m[i + 1] = t * beta * deltas[i];
            }
        }
    }

    for x in 0..256 {
        let xf = x as f64;
        if xf <= xs[0] {
            lut[x] = ys[0].round().clamp(0.0, 255.0) as u8;
            continue;
        }
        if xf >= xs[n - 1] {
            lut[x] = ys[n - 1].round().clamp(0.0, 255.0) as u8;
            continue;
        }

        let mut seg = 0;
        for i in 0..n - 1 {
            if xf >= xs[i] && xf < xs[i + 1] {
                seg = i;
                break;
            }
        }

        let h = (xs[seg + 1] - xs[seg]).max(1.0);
        let t = (xf - xs[seg]) / h;
        let t2 = t * t;
        let t3 = t2 * t;

        let val = (2.0 * t3 - 3.0 * t2 + 1.0) * ys[seg]
            + (t3 - 2.0 * t2 + t) * h * m[seg]
            + (-2.0 * t3 + 3.0 * t2) * ys[seg + 1]
            + (t3 - t2) * h * m[seg + 1];

        lut[x] = val.round().clamp(0.0, 255.0) as u8;
    }

    lut
}

/// Apply temperature, highlights/shadows, and tone curve to raw RGBA pixels.
/// These are the custom operations that photon-rs doesn't cover.
fn apply_custom_adjustments(pixels: &mut [u8], adj: &ImageAdjustments) {
    let curve_lut = build_curve_lut(&adj.curve_points);
    let temp_r = 1.0 + adj.temperature / 200.0;
    let temp_b = 1.0 - adj.temperature / 200.0;
    let high_mul = 1.0 + adj.highlights / 200.0;
    let shad_mul = 1.0 + adj.shadows / 200.0;

    let has_temp = adj.temperature.abs() > 0.01;
    let has_high = adj.highlights.abs() > 0.01;
    let has_shad = adj.shadows.abs() > 0.01;
    let has_curve =
        adj.curve_points.len() >= 2 && adj.curve_points.iter().any(|(x, y)| (x - y).abs() > 0.01);

    // Skip entirely if nothing custom to do
    if !has_temp && !has_high && !has_shad && !has_curve {
        return;
    }

    for chunk in pixels.chunks_exact_mut(4) {
        let mut r = chunk[0] as f64;
        let mut g = chunk[1] as f64;
        let mut b = chunk[2] as f64;

        // Temperature (channel gain)
        if has_temp {
            r *= temp_r;
            b *= temp_b;
        }

        // Highlights / shadows (luminance-weighted)
        if has_high || has_shad {
            let lum = 0.299 * r + 0.587 * g + 0.114 * b;
            let lum_norm = (lum / 255.0).min(1.0);
            if has_high {
                let w = lum_norm * lum_norm;
                let a = 1.0 + (high_mul - 1.0) * w;
                r *= a;
                g *= a;
                b *= a;
            }
            if has_shad {
                let w = (1.0 - lum_norm) * (1.0 - lum_norm);
                let a = 1.0 + (shad_mul - 1.0) * w;
                r *= a;
                g *= a;
                b *= a;
            }
        }

        // Tone curve LUT
        if has_curve {
            chunk[0] = curve_lut[r.round().clamp(0.0, 255.0) as usize];
            chunk[1] = curve_lut[g.round().clamp(0.0, 255.0) as usize];
            chunk[2] = curve_lut[b.round().clamp(0.0, 255.0) as usize];
        } else {
            chunk[0] = r.round().clamp(0.0, 255.0) as u8;
            chunk[1] = g.round().clamp(0.0, 255.0) as u8;
            chunk[2] = b.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Unsharp mask sharpening: blur with 3x3 Gaussian, then blend
/// output = original + strength * (original - blurred)
fn apply_unsharp_mask(pixels: &mut [u8], width: u32, height: u32, amount: f64) {
    if amount <= 0.01 {
        return;
    }
    let strength = amount / 100.0;
    let w = width as usize;
    let h = height as usize;

    // Compute blurred copy (3x3 Gaussian: [1 2 1; 2 4 2; 1 2 1] / 16)
    let mut blurred = vec![0.0f32; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let mut sum = 0.0f32;
                let mut wt = 0.0f32;
                for dy in -1i32..=1 {
                    let ny = y as i32 + dy;
                    if ny < 0 || ny >= h as i32 {
                        continue;
                    }
                    for dx in -1i32..=1 {
                        let nx = x as i32 + dx;
                        if nx < 0 || nx >= w as i32 {
                            continue;
                        }
                        let kernel_w =
                            (if dx == 0 { 2.0 } else { 1.0 }) * (if dy == 0 { 2.0 } else { 1.0 });
                        sum += pixels[(ny as usize * w + nx as usize) * 4 + c] as f32 * kernel_w;
                        wt += kernel_w;
                    }
                }
                blurred[(y * w + x) * 3 + c] = sum / wt;
            }
        }
    }

    // Blend
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) * 4;
            let bidx = (y * w + x) * 3;
            for c in 0..3 {
                let orig = pixels[idx + c] as f32;
                let diff = orig - blurred[bidx + c];
                pixels[idx + c] = (orig + strength as f32 * diff).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Run DnCNN AI denoising on an image.
/// Receives RGBA pixels, converts to YCbCr, denoises Y channel, converts back.
/// `strength` (0-100) controls blend between original and denoised.
#[tauri::command]
async fn denoise_image(
    app: AppHandle,
    image_bytes: Vec<u8>,
    width: u32,
    height: u32,
    strength: f64,
) -> Result<Vec<u8>, String> {
    let model = app.state::<DenoiseModel>().0.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let w = width as usize;
        let h = height as usize;
        let blend = (strength / 100.0).clamp(0.0, 1.0) as f32;

        // Ensure we have RGBA data
        if image_bytes.len() != w * h * 4 {
            return Err(format!(
                "Expected {} bytes ({}x{}x4), got {}",
                w * h * 4,
                w,
                h,
                image_bytes.len()
            ));
        }

        // Extract Y (luminance) channel, normalized to 0..1
        let mut y_channel = vec![0.0f32; w * h];
        for i in 0..w * h {
            let r = image_bytes[i * 4] as f32 / 255.0;
            let g = image_bytes[i * 4 + 1] as f32 / 255.0;
            let b = image_bytes[i * 4 + 2] as f32 / 255.0;
            y_channel[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        }

        // Build input tensor [1, 1, H, W]
        let input = Array4::from_shape_vec((1, 1, h, w), y_channel.clone())
            .map_err(|e| format!("Shape error: {}", e))?;

        // Run inference
        let mut guard = model.lock().map_err(|e| format!("Lock error: {}", e))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Denoise model not loaded".to_string())?;

        let input_value =
            ort::value::Tensor::from_array(input).map_err(|e| format!("Input error: {}", e))?;
        let outputs = session
            .run(ort::inputs!["input" => input_value])
            .map_err(|e| format!("Inference error: {}", e))?;

        let output_tensor = outputs["output"]
            .downcast_ref::<ort::value::TensorValueType<f32>>()
            .map_err(|e| format!("Downcast error: {}", e))?;
        let (_shape, raw_data) = output_tensor
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Output error: {}", e))?;
        let denoised_y: Vec<f32> = raw_data.to_vec();

        // Blend denoised Y back into RGB pixels
        let mut result = image_bytes.clone();
        for i in 0..w * h {
            let r = image_bytes[i * 4] as f32 / 255.0;
            let g = image_bytes[i * 4 + 1] as f32 / 255.0;
            let b = image_bytes[i * 4 + 2] as f32 / 255.0;

            let orig_y = y_channel[i];
            let new_y = denoised_y[i].clamp(0.0, 1.0);
            // Blend between original and denoised luminance
            let blended_y = orig_y + blend * (new_y - orig_y);

            // Scale RGB proportionally to match new luminance
            if orig_y > 1e-6 {
                let scale = blended_y / orig_y;
                result[i * 4] = (r * scale * 255.0).round().clamp(0.0, 255.0) as u8;
                result[i * 4 + 1] = (g * scale * 255.0).round().clamp(0.0, 255.0) as u8;
                result[i * 4 + 2] = (b * scale * 255.0).round().clamp(0.0, 255.0) as u8;
            } else {
                let val = (blended_y * 255.0).round().clamp(0.0, 255.0) as u8;
                result[i * 4] = val;
                result[i * 4 + 1] = val;
                result[i * 4 + 2] = val;
            }
            // Alpha unchanged
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?;

    result
}

#[tauri::command]
async fn apply_edits_and_save(
    file_path: String,
    adjustments: ImageAdjustments,
) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    // Load the full-res image (handle RAW via LibRaw conversion)
    let image_bytes = if is_raw_file(path) {
        render_raw_to_jpeg(path, 8192).map_err(|e| format!("RAW conversion failed: {}", e))?
    } else {
        fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?
    };

    let adj = adjustments;

    let output_bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let img = image::load_from_memory(&image_bytes)
            .map_err(|e| format!("Failed to decode image: {}", e))?
            .to_rgba8();

        let (w, h) = img.dimensions();
        let raw_pixels = img.into_raw();

        // Use photon-rs for exposure, contrast, saturation
        let mut photon_img = photon_rs::PhotonImage::new(raw_pixels, w, h);

        if adj.exposure.abs() > 0.01 {
            // Map -100..100 to brightness offset; ±100 → approx ±1 stop
            // photon-rs brightness is an i16 additive offset per channel
            let brightness = (adj.exposure * 1.28) as i16; // ±128 range
            photon_rs::effects::adjust_brightness(&mut photon_img, brightness);
        }

        if adj.contrast.abs() > 0.01 {
            // Map -100..100 to photon-rs contrast factor
            let contrast = (adj.contrast * 1.28) as f32;
            photon_rs::effects::adjust_contrast(&mut photon_img, contrast);
        }

        if adj.saturation.abs() > 0.01 {
            // photon-rs uses separate saturate/desaturate with positive level
            let level = (adj.saturation.abs() / 100.0 * 0.5) as f32;
            if adj.saturation > 0.0 {
                photon_rs::colour_spaces::saturate_hsl(&mut photon_img, level);
            } else {
                photon_rs::colour_spaces::desaturate_hsl(&mut photon_img, level);
            }
        }

        // Apply custom adjustments (temperature, highlights/shadows, tone curve)
        let mut pixels = photon_img.get_raw_pixels();
        apply_custom_adjustments(&mut pixels, &adj);

        // Apply sharpening (spatial filter, after per-pixel ops)
        apply_unsharp_mask(&mut pixels, w, h, adj.sharpen);

        // Convert RGBA back to RGB and encode as JPEG
        let rgba_img = image::RgbaImage::from_raw(w, h, pixels)
            .ok_or_else(|| "Failed to reconstruct image".to_string())?;
        let rgb_img = image::DynamicImage::ImageRgba8(rgba_img).to_rgb8();
        let mut output = Vec::with_capacity(image_bytes.len());
        let mut cursor = std::io::Cursor::new(&mut output);
        rgb_img
            .write_to(&mut cursor, ImageFormat::Jpeg)
            .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
        Ok(output)
    })
    .await
    .map_err(|e| format!("Processing failed: {}", e))?
    .map_err(|e| e)?;

    // Write output file
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let parent = path.parent().unwrap_or(Path::new("."));
    let output_path = parent.join(format!("{}_edited.jpg", stem));

    fs::write(&output_path, &output_bytes).map_err(|e| format!("Failed to save: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn load_full_resolution_image_command(file_path: String) -> Response {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Response::new("File does not exist".to_string());
    }

    if !is_supported_file(path) {
        return Response::new("Unsupported file format".to_string());
    }

    load_full_resolution_image(path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoMetadata {
    pub tags: Vec<String>,
    pub notes: String,
    pub rating: u8,
    pub flag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCullFeatureValues {
    pub embedding: Vec<f64>,
    pub technical_score: f64,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoCullFeatureCacheEntry {
    pub key: String,
    pub version: String,
    pub file_path: String,
    pub file_size: u64,
    pub modified_at: String,
    pub features: Option<AutoCullFeatureValues>,
}

#[derive(Debug, Clone, Default)]
struct XmpMetadataPatch {
    tags: Option<Vec<String>>,
    notes: Option<String>,
    rating: Option<u8>,
    flag: Option<String>,
}

fn open_db(app: &AppHandle, folder_path: Option<&str>) -> Result<rusqlite::Connection, String> {
    let db_path = if let Some(folder_path) = folder_path.filter(|path| !path.trim().is_empty()) {
        let folder = Path::new(folder_path);
        if !folder.is_dir() {
            return Err(format!("Catalog folder does not exist: {folder_path}"));
        }
        folder.join("hologram.sql")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("hologram.db")
    };
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_metadata (
            photo_id TEXT PRIMARY KEY,
            tags TEXT NOT NULL DEFAULT '[]',
            notes TEXT NOT NULL DEFAULT '',
            rating INTEGER NOT NULL DEFAULT 0,
            flag TEXT NOT NULL DEFAULT 'none'
        )",
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE photo_metadata ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE photo_metadata ADD COLUMN flag TEXT NOT NULL DEFAULT 'none'",
        [],
    );
    Ok(conn)
}

fn open_cache_db(
    app: &AppHandle,
    folder_path: Option<&str>,
) -> Result<rusqlite::Connection, String> {
    let db_path = if let Some(folder_path) = folder_path.filter(|path| !path.trim().is_empty()) {
        let folder = Path::new(folder_path);
        if !folder.is_dir() {
            return Err(format!("Catalog folder does not exist: {folder_path}"));
        }
        folder.join("hologram-cache.sql")
    } else {
        app.path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("hologram-cache.sql")
    };
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS autocull_feature_cache (
            cache_key TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            cached_at TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            features_json TEXT
        );
        CREATE INDEX IF NOT EXISTS autocull_feature_cache_cached_at
            ON autocull_feature_cache(cached_at);
        CREATE TABLE IF NOT EXISTS thumbnail_cache (
            photo_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            cached_at TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            thumbnail TEXT NOT NULL,
            embedded_preview_json TEXT
        );
        CREATE INDEX IF NOT EXISTS thumbnail_cache_cached_at
            ON thumbnail_cache(cached_at);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn read_autocull_feature_cache(
    app: AppHandle,
    folder_path: Option<String>,
    cache_keys: Vec<String>,
) -> Result<Vec<AutoCullFeatureCacheEntry>, String> {
    let conn = open_cache_db(&app, folder_path.as_deref())?;
    let mut statement = conn
        .prepare(
            "SELECT version, file_path, file_size, modified_at, features_json
             FROM autocull_feature_cache WHERE cache_key = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for key in cache_keys {
        let entry = statement.query_row([&key], |row| {
            let features_json: Option<String> = row.get(4)?;
            Ok(AutoCullFeatureCacheEntry {
                key: key.clone(),
                version: row.get(0)?,
                file_path: row.get(1)?,
                file_size: row.get(2)?,
                modified_at: row.get(3)?,
                features: features_json.and_then(|json| serde_json::from_str(&json).ok()),
            })
        });
        if let Ok(entry) = entry {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[tauri::command]
fn write_autocull_feature_cache(
    app: AppHandle,
    folder_path: Option<String>,
    entries: Vec<AutoCullFeatureCacheEntry>,
) -> Result<(), String> {
    let mut conn = open_cache_db(&app, folder_path.as_deref())?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO autocull_feature_cache
                 (cache_key, version, cached_at, file_path, file_size, modified_at, features_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(cache_key) DO UPDATE SET
                   version=excluded.version, cached_at=excluded.cached_at,
                   file_path=excluded.file_path, file_size=excluded.file_size,
                   modified_at=excluded.modified_at, features_json=excluded.features_json",
            )
            .map_err(|e| e.to_string())?;
        let cached_at = Utc::now().to_rfc3339();
        for entry in entries {
            let features_json = entry
                .features
                .map(|features| serde_json::to_string(&features))
                .transpose()
                .map_err(|e| e.to_string())?;
            statement
                .execute(rusqlite::params![
                    entry.key,
                    entry.version,
                    cached_at,
                    entry.file_path,
                    entry.file_size,
                    entry.modified_at,
                    features_json,
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM autocull_feature_cache WHERE cache_key IN (
            SELECT cache_key FROM autocull_feature_cache
            ORDER BY cached_at DESC LIMIT -1 OFFSET 4000
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_photo_metadata(
    app: AppHandle,
    photo_id: String,
    folder_path: Option<String>,
    tags: Vec<String>,
    notes: String,
    rating: u8,
    flag: String,
) -> Result<(), String> {
    let conn = open_db(&app, folder_path.as_deref())?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let rating = rating.min(5);
    let flag = match flag.as_str() {
        "pick" | "reject" => flag,
        _ => "none".to_string(),
    };
    conn.execute(
        "INSERT INTO photo_metadata (photo_id, tags, notes, rating, flag) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(photo_id) DO UPDATE SET tags=excluded.tags, notes=excluded.notes, rating=excluded.rating, flag=excluded.flag",
        rusqlite::params![photo_id, tags_json, notes, rating, flag],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_photo_metadata(
    conn: &rusqlite::Connection,
    photo_ids: &[String],
) -> HashMap<String, PhotoMetadata> {
    let mut result = HashMap::new();
    for photo_id in photo_ids {
        if let Ok((tags_json, notes, rating, flag)) = conn.query_row(
            "SELECT tags, notes, rating, flag FROM photo_metadata WHERE photo_id = ?1",
            rusqlite::params![photo_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u8>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        ) {
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let flag = match flag.as_str() {
                "pick" | "reject" => flag,
                _ => "none".to_string(),
            };
            result.insert(
                photo_id.clone(),
                PhotoMetadata {
                    tags,
                    notes,
                    rating: rating.min(5),
                    flag,
                },
            );
        }
    }
    result
}

#[tauri::command]
fn get_photo_metadata(
    app: AppHandle,
    photo_ids: Vec<String>,
    folder_path: Option<String>,
) -> Result<HashMap<String, PhotoMetadata>, String> {
    let conn = open_db(&app, folder_path.as_deref())?;
    let mut result = read_photo_metadata(&conn, &photo_ids);

    if folder_path.is_some() && result.len() < photo_ids.len() {
        let missing_ids: Vec<String> = photo_ids
            .iter()
            .filter(|photo_id| !result.contains_key(*photo_id))
            .cloned()
            .collect();
        if !missing_ids.is_empty() {
            let fallback_conn = open_db(&app, None)?;
            let fallback_metadata = read_photo_metadata(&fallback_conn, &missing_ids);
            for (photo_id, metadata) in &fallback_metadata {
                let tags_json = serde_json::to_string(&metadata.tags).map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO photo_metadata (photo_id, tags, notes, rating, flag) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(photo_id) DO UPDATE SET tags=excluded.tags, notes=excluded.notes, rating=excluded.rating, flag=excluded.flag",
                    rusqlite::params![photo_id, tags_json, metadata.notes, metadata.rating.min(5), metadata.flag],
                )
                .map_err(|e| e.to_string())?;
            }
            result.extend(fallback_metadata);
        }
    }

    Ok(result)
}

#[tauri::command]
async fn export_xmp_sidecars(photos: Vec<Photo>) -> Result<XmpSidecarResult, String> {
    tokio::task::spawn_blocking(move || -> Result<XmpSidecarResult, String> {
        let results: Result<Vec<bool>, String> = photos
            .par_iter()
            .map(|photo| {
                let photo_path = Path::new(&photo.file_path);
                if !photo_path.is_file() {
                    return Ok(false);
                }
                let sidecar_path = xmp_sidecar_path(photo_path);
                fs::write(&sidecar_path, lightroom_xmp(&photo)).map_err(|e| e.to_string())?;
                Ok(true)
            })
            .collect();
        let results = results?;
        let processed_count = results.iter().filter(|processed| **processed).count();
        let skipped_count = results.len() - processed_count;

        Ok(XmpSidecarResult {
            processed_count,
            skipped_count,
        })
    })
    .await
    .map_err(|e| format!("XMP export failed: {}", e))?
}

#[tauri::command]
async fn import_xmp_sidecars(
    app: AppHandle,
    photos: Vec<Photo>,
    folder_path: Option<String>,
) -> Result<XmpSidecarResult, String> {
    tokio::task::spawn_blocking(move || -> Result<XmpSidecarResult, String> {
        let conn = open_db(&app, folder_path.as_deref())?;
        let mut processed_count = 0usize;
        let mut skipped_count = 0usize;

        for photo in photos {
            let sidecar_path = xmp_sidecar_path(Path::new(&photo.file_path));
            if !sidecar_path.is_file() {
                skipped_count += 1;
                continue;
            }
            let contents = fs::read_to_string(&sidecar_path).map_err(|e| e.to_string())?;
            let Some(patch) = parse_xmp_sidecar(&contents) else {
                skipped_count += 1;
                continue;
            };

            let existing = read_photo_metadata(&conn, &[photo.id.clone()])
                .remove(&photo.id)
                .unwrap_or(PhotoMetadata {
                    tags: photo.tags.clone().unwrap_or_default(),
                    notes: photo.notes.clone().unwrap_or_default(),
                    rating: photo.rating.unwrap_or(0).min(5),
                    flag: photo.flag.clone().unwrap_or_else(|| "none".to_string()),
                });
            let tags = patch.tags.unwrap_or(existing.tags);
            let notes = patch.notes.unwrap_or(existing.notes);
            let rating = patch.rating.unwrap_or(existing.rating).min(5);
            let flag = patch.flag.unwrap_or(existing.flag);
            let flag = match flag.as_str() {
                "pick" | "reject" => flag,
                _ => "none".to_string(),
            };
            let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO photo_metadata (photo_id, tags, notes, rating, flag) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(photo_id) DO UPDATE SET tags=excluded.tags, notes=excluded.notes, rating=excluded.rating, flag=excluded.flag",
                rusqlite::params![photo.id, tags_json, notes, rating, flag],
            )
            .map_err(|e| e.to_string())?;
            processed_count += 1;
        }

        Ok(XmpSidecarResult {
            processed_count,
            skipped_count,
        })
    })
    .await
    .map_err(|e| format!("XMP import failed: {}", e))?
}

fn sanitize_path_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|ch: char| ch == ' ' || ch == '.' || ch == '_');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn photo_date(photo: &Photo) -> &DateTime<Utc> {
    photo.exif.date_taken.as_ref().unwrap_or(&photo.modified_at)
}

fn export_relative_dir(photo: &Photo, organize_by: &str) -> PathBuf {
    match organize_by {
        "date" => {
            let date = photo_date(photo);
            PathBuf::from(date.format("%Y").to_string())
                .join(date.format("%m").to_string())
                .join(date.format("%d").to_string())
        }
        "camera" => {
            let camera = photo
                .exif
                .camera_model
                .as_deref()
                .or(photo.exif.camera_make.as_deref())
                .unwrap_or("Unknown Camera");
            PathBuf::from(sanitize_path_component(camera))
        }
        _ => PathBuf::new(),
    }
}

fn export_file_name(photo: &Photo, index: usize, pattern: Option<&str>) -> String {
    let original = Path::new(&photo.file_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("photo");
    let ext = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let date = photo_date(photo).format("%Y%m%d").to_string();
    let camera = photo
        .exif
        .camera_model
        .as_deref()
        .or(photo.exif.camera_make.as_deref())
        .unwrap_or("camera");

    let base = pattern
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .replace("{index}", &format!("{:04}", index + 1))
                .replace("{name}", stem)
                .replace("{date}", &date)
                .replace("{camera}", camera)
                .replace("{type}", &photo.file_type)
        })
        .unwrap_or_else(|| stem.to_string());

    let safe_base = sanitize_path_component(&base);
    if ext.is_empty() {
        safe_base
    } else {
        format!("{safe_base}.{}", sanitize_path_component(ext))
    }
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("photo")
        .to_string();
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());

    for idx in 2..10_000 {
        let candidate_name = if let Some(ext) = &ext {
            format!("{stem}-{idx}.{ext}")
        } else {
            format!("{stem}-{idx}")
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

fn resolve_export_items(photos: Vec<Photo>, all_photos: Vec<Photo>, pair_mode: &str) -> Vec<Photo> {
    let mut by_id: HashMap<String, Photo> = HashMap::new();
    for photo in all_photos.into_iter().chain(photos.clone()) {
        by_id.insert(photo.id.clone(), photo);
    }

    let mut selected = Vec::new();
    let mut seen_paths = HashSet::new();
    let add_photo = |photo: &Photo, selected: &mut Vec<Photo>, seen_paths: &mut HashSet<String>| {
        if seen_paths.insert(photo.file_path.clone()) {
            selected.push(photo.clone());
        }
    };

    for photo in &photos {
        let paired = photo.paired_with.as_ref().and_then(|id| by_id.get(id));
        match pair_mode {
            "both" => {
                add_photo(photo, &mut selected, &mut seen_paths);
                if let Some(pair) = paired {
                    add_photo(pair, &mut selected, &mut seen_paths);
                }
            }
            "raw" => {
                if is_raw_file(Path::new(&photo.file_path)) {
                    add_photo(photo, &mut selected, &mut seen_paths);
                } else if let Some(pair) =
                    paired.filter(|item| is_raw_file(Path::new(&item.file_path)))
                {
                    add_photo(pair, &mut selected, &mut seen_paths);
                }
            }
            "jpeg" => {
                if !is_raw_file(Path::new(&photo.file_path)) {
                    add_photo(photo, &mut selected, &mut seen_paths);
                } else if let Some(pair) =
                    paired.filter(|item| !is_raw_file(Path::new(&item.file_path)))
                {
                    add_photo(pair, &mut selected, &mut seen_paths);
                }
            }
            _ => add_photo(photo, &mut selected, &mut seen_paths),
        }
    }

    selected
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn xmp_sidecar_path(path: &Path) -> PathBuf {
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => path.with_extension(format!("{extension}.xmp")),
        _ => path.with_extension("xmp"),
    }
}

fn xmp_attribute(contents: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(start) = contents.find(&needle) {
            let value_start = start + needle.len();
            let value_end = contents[value_start..].find(quote)? + value_start;
            return Some(xml_unescape(&contents[value_start..value_end]));
        }
    }
    None
}

fn xmp_block<'a>(contents: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = contents.find(&open)?;
    let after_open = contents[start..].find('>')? + start + 1;
    let end = contents[after_open..].find(&close)? + after_open;
    Some(&contents[after_open..end])
}

fn rdf_li_values(block: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut rest = block;
    while let Some(start) = rest.find("<rdf:li") {
        let candidate = &rest[start..];
        let Some(open_end) = candidate.find('>') else {
            break;
        };
        let content_start = open_end + 1;
        let Some(close_start) = candidate[content_start..].find("</rdf:li>") else {
            break;
        };
        let value = xml_unescape(candidate[content_start..content_start + close_start].trim());
        if !value.is_empty() {
            values.push(value);
        }
        rest = &candidate[content_start + close_start + "</rdf:li>".len()..];
    }
    values
}

fn parse_xmp_sidecar(contents: &str) -> Option<XmpMetadataPatch> {
    let mut patch = XmpMetadataPatch::default();
    let mut touched = false;

    if let Some(rating) =
        xmp_attribute(contents, "xmp:Rating").and_then(|value| value.parse::<u8>().ok())
    {
        patch.rating = Some(rating.min(5));
        touched = true;
    }

    if let Some(label) = xmp_attribute(contents, "xmp:Label") {
        patch.flag = Some(match label.trim().to_ascii_lowercase().as_str() {
            "pick" | "select" | "selected" => "pick".to_string(),
            "reject" | "rejected" => "reject".to_string(),
            _ => "none".to_string(),
        });
        touched = true;
    }

    if let Some(subject) = xmp_block(contents, "dc:subject") {
        patch.tags = Some(rdf_li_values(subject));
        touched = true;
    }

    if let Some(description) = xmp_block(contents, "dc:description") {
        if let Some(notes) = rdf_li_values(description).first() {
            patch.notes = Some(notes.clone());
            touched = true;
        }
    }

    if touched {
        Some(patch)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rating_label_tags_and_notes_from_xmp() {
        let patch = parse_xmp_sidecar(
            r#"<?xpacket begin=""?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4" xmp:Label="Pick">
      <dc:subject xmlns:dc="http://purl.org/dc/elements/1.1/">
        <rdf:Bag><rdf:li>portfolio</rdf:li><rdf:li>client &amp; edit</rdf:li></rdf:Bag>
      </dc:subject>
      <dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">
        <rdf:Alt><rdf:li xml:lang="x-default">Hero frame</rdf:li></rdf:Alt>
      </dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#,
        )
        .expect("xmp patch");

        assert_eq!(patch.rating, Some(4));
        assert_eq!(patch.flag.as_deref(), Some("pick"));
        assert_eq!(
            patch.tags,
            Some(vec!["portfolio".to_string(), "client & edit".to_string()])
        );
        assert_eq!(patch.notes.as_deref(), Some("Hero frame"));
    }
}

fn metadata_csv(rows: &[(Photo, String)]) -> String {
    let mut csv = String::from("file_name,relative_path,original_path,rating,flag,tags,notes\n");
    for (photo, relative_path) in rows {
        let tags = photo.tags.clone().unwrap_or_default().join("|");
        let rating = photo.rating.unwrap_or(0).min(5).to_string();
        let flag = photo.flag.clone().unwrap_or_else(|| "none".to_string());
        let notes = photo.notes.clone().unwrap_or_default();
        let fields = [
            photo.file_name.as_str(),
            relative_path.as_str(),
            photo.file_path.as_str(),
            rating.as_str(),
            flag.as_str(),
            tags.as_str(),
            notes.as_str(),
        ];
        csv.push_str(
            &fields
                .iter()
                .map(|value| csv_escape(value))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push('\n');
    }
    csv
}

fn lightroom_xmp(photo: &Photo) -> String {
    let rating = photo.rating.unwrap_or(0).min(5);
    let flag = photo.flag.as_deref().unwrap_or("none");
    let label = match flag {
        "pick" => "Pick",
        "reject" => "Reject",
        _ => "",
    };
    let tags = photo.tags.clone().unwrap_or_default();
    let notes = photo.notes.clone().unwrap_or_default();
    let tag_items = tags
        .iter()
        .map(|tag| format!("<rdf:li>{}</rdf:li>", xml_escape(tag)))
        .collect::<String>();

    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmp:Rating="{rating}"
      xmp:Label="{label}">
      <dc:subject>
        <rdf:Bag>{tag_items}</rdf:Bag>
      </dc:subject>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">{notes}</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#,
        rating = rating,
        label = xml_escape(label),
        tag_items = tag_items,
        notes = xml_escape(&notes)
    )
}

fn relative_zip_name(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
async fn export_photos(
    photos: Vec<Photo>,
    all_photos: Vec<Photo>,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    tokio::task::spawn_blocking(move || -> Result<ExportResult, String> {
        let selected = resolve_export_items(photos, all_photos, &options.pair_mode);
        if selected.is_empty() {
            return Err("No photos selected for export".to_string());
        }

        let destination = PathBuf::from(&options.destination_path);
        let mode = options.mode.as_str();
        let output_path = match mode {
            "zip" => {
                if destination.extension().and_then(|value| value.to_str()) == Some("zip") {
                    destination
                } else {
                    destination.join("hologram-export.zip")
                }
            }
            "lightroom" => destination.join("hologram-lightroom-export"),
            _ => destination,
        };

        let mut rows: Vec<(Photo, String)> = Vec::new();
        let mut skipped_count = 0usize;

        if mode == "zip" {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
            let mut zip = ZipWriter::new(file);
            let file_options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644);

            for (idx, photo) in selected.iter().enumerate() {
                let src = Path::new(&photo.file_path);
                if !src.is_file() {
                    skipped_count += 1;
                    continue;
                }
                let relative = export_relative_dir(photo, &options.organize_by).join(
                    export_file_name(photo, idx, options.rename_pattern.as_deref()),
                );
                let relative_name = relative_zip_name(&relative);
                zip.start_file(&relative_name, file_options)
                    .map_err(|e| e.to_string())?;
                let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
                io::copy(&mut input, &mut zip).map_err(|e| e.to_string())?;
                rows.push((photo.clone(), relative_name));
            }

            if options.include_metadata {
                zip.start_file("hologram-metadata.csv", file_options)
                    .map_err(|e| e.to_string())?;
                zip.write_all(metadata_csv(&rows).as_bytes())
                    .map_err(|e| e.to_string())?;
            }

            zip.finish().map_err(|e| e.to_string())?;
            return Ok(ExportResult {
                exported_count: rows.len(),
                skipped_count,
                output_path: output_path.to_string_lossy().to_string(),
                metadata_path: if options.include_metadata {
                    Some("hologram-metadata.csv".to_string())
                } else {
                    None
                },
            });
        }

        fs::create_dir_all(&output_path).map_err(|e| e.to_string())?;

        for (idx, photo) in selected.iter().enumerate() {
            let src = Path::new(&photo.file_path);
            if !src.is_file() {
                skipped_count += 1;
                continue;
            }
            let relative = export_relative_dir(photo, &options.organize_by).join(export_file_name(
                photo,
                idx,
                options.rename_pattern.as_deref(),
            ));
            let dest = unique_path(output_path.join(&relative));
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(src, &dest).map_err(|e| e.to_string())?;
            let relative_to_output = dest
                .strip_prefix(&output_path)
                .unwrap_or(&dest)
                .to_string_lossy()
                .to_string();
            rows.push((photo.clone(), relative_to_output.clone()));

            if mode == "lightroom" {
                let xmp_path = dest.with_extension(format!(
                    "{}.xmp",
                    dest.extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or("photo")
                ));
                fs::write(xmp_path, lightroom_xmp(photo)).map_err(|e| e.to_string())?;
            }
        }

        let metadata_path = if options.include_metadata || mode == "lightroom" {
            let csv_path = output_path.join("hologram-metadata.csv");
            fs::write(&csv_path, metadata_csv(&rows)).map_err(|e| e.to_string())?;
            Some(csv_path.to_string_lossy().to_string())
        } else {
            None
        };

        Ok(ExportResult {
            exported_count: rows.len(),
            skipped_count,
            output_path: output_path.to_string_lossy().to_string(),
            metadata_path,
        })
    })
    .await
    .map_err(|e| format!("Export failed: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Load DnCNN ONNX model for AI denoising
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");
            let model_path = resource_dir.join("resources/dncnn_gray_blind.onnx");

            let session = if model_path.exists() {
                match Session::builder().and_then(|mut b| b.commit_from_file(&model_path)) {
                    Ok(s) => {
                        eprintln!("DnCNN model loaded from {:?}", model_path);
                        Some(s)
                    }
                    Err(e) => {
                        eprintln!("Failed to load DnCNN model: {}", e);
                        None
                    }
                }
            } else {
                eprintln!("DnCNN model not found at {:?}", model_path);
                None
            };

            app.manage(DenoiseModel(Arc::new(Mutex::new(session))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder_fast,
            generate_thumbnails,
            prerender_raws,
            prioritize_raw_renders,
            filter_photos,
            get_photo_stats,
            load_full_resolution_image_command,
            apply_edits_and_save,
            denoise_image,
            set_photo_metadata,
            get_photo_metadata,
            read_autocull_feature_cache,
            write_autocull_feature_cache,
            export_xmp_sidecars,
            import_xmp_sidecars,
            export_photos
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
