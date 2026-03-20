use anyhow::Result;
use base64::Engine;
use chrono::{DateTime, Utc};
use exif as kamadak_exif;
use image::ImageFormat;
use kamadak_exif::{In, Reader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;

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
    pub cameras: HashMap<String, usize>,
    pub lenses: HashMap<String, usize>,
}

static SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "cr2", "cr3", "arw", "nef", "dng", "tiff", "tif", "png",
];

static RAW_EXTENSIONS: &[&str] = &["cr2", "cr3", "arw", "nef", "dng"];

fn is_supported_file(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            return SUPPORTED_EXTENSIONS.contains(&ext_str.to_lowercase().as_str());
        }
    }
    false
}

fn is_raw_file(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            return RAW_EXTENSIONS.contains(&ext_str.to_lowercase().as_str());
        }
    }
    false
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
            if let kamadak_exif::Value::Short(ref vec) = field.value {
                if let Some(iso) = vec.first() {
                    exif_data.iso = Some(*iso as u32);
                }
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ExposureTime, In::PRIMARY) {
            exif_data.shutter_speed = Some(field.display_value().to_string());
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ImageWidth, In::PRIMARY) {
            if let kamadak_exif::Value::Long(ref vec) = field.value {
                if let Some(width) = vec.first() {
                    exif_data.width = Some(*width);
                }
            }
        }
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ImageLength, In::PRIMARY) {
            if let kamadak_exif::Value::Long(ref vec) = field.value {
                if let Some(height) = vec.first() {
                    exif_data.height = Some(*height);
                }
            }
        }
    }

    Ok(exif_data)
}

/// Get the cache directory for sips conversions
fn sips_cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("hologram_sips_cache");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Generate a cache key from file path + modification time + max dimension
fn sips_cache_key(file_path: &Path, max_dimension: u32) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    file_path.hash(&mut hasher);
    if let Ok(meta) = fs::metadata(file_path) {
        if let Ok(modified) = meta.modified() {
            modified.hash(&mut hasher);
        }
    }
    max_dimension.hash(&mut hasher);
    format!("{:x}.jpeg", hasher.finish())
}

/// Convert a RAW file to JPEG bytes using macOS sips (Apple's native imaging pipeline).
/// Results are cached on disk keyed by file path + mtime + dimension.
#[cfg(target_os = "macos")]
fn convert_raw_with_sips(file_path: &Path, max_dimension: u32) -> Result<Vec<u8>> {
    let cache_dir = sips_cache_dir();
    let cache_key = sips_cache_key(file_path, max_dimension);
    let cache_path = cache_dir.join(&cache_key);

    // Check cache first
    if cache_path.exists() {
        if let Ok(data) = fs::read(&cache_path) {
            if !data.is_empty() {
                return Ok(data);
            }
        }
    }

    let output = Command::new("sips")
        .args([
            "-s", "format", "jpeg",
            "-s", "formatOptions", "90",
            "--resampleHeightWidthMax", &max_dimension.to_string(),
            file_path.to_str().unwrap_or_default(),
            "--out", cache_path.to_str().unwrap_or_default(),
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("sips failed: {}", stderr);
    }

    let data = fs::read(&cache_path)?;
    Ok(data)
}

#[cfg(not(target_os = "macos"))]
fn convert_raw_with_sips(_file_path: &Path, _max_dimension: u32) -> Result<Vec<u8>> {
    anyhow::bail!("RAW conversion via sips only available on macOS")
}

fn generate_thumbnail(file_path: &Path) -> Result<String> {
    // For RAW files, use macOS sips for proper rendering
    if is_raw_file(file_path) {
        let data = convert_raw_with_sips(file_path, 400)?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(data));
    }

    let img = image::open(file_path)?;
    let thumbnail = img.thumbnail(400, 400);

    let mut buffer = Vec::with_capacity(16384);
    let mut cursor = std::io::Cursor::new(&mut buffer);
    thumbnail.write_to(&mut cursor, ImageFormat::Jpeg)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(buffer))
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

    Some(Photo {
        id: Uuid::new_v4().to_string(),
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_size,
        file_type,
        thumbnail: None, // Thumbnails generated in phase 2
        exif: exif_data,
        created_at: Utc::now(),
        modified_at,
        paired_with: None,
    })
}

fn compute_stats(photos: &[Photo]) -> PhotoStats {
    let mut raw_count = 0;
    let mut paired_count = 0;
    let mut cameras: HashMap<String, usize> = HashMap::new();
    let mut lenses: HashMap<String, usize> = HashMap::new();

    for photo in photos {
        if is_raw_file(Path::new(&photo.file_path)) {
            raw_count += 1;
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
                base_names
                    .entry(stem_str.to_string())
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

                photos[raw].paired_with = Some(jpeg_id);
                photos[jpeg].paired_with = Some(raw_id);
            }
        }
    }
}

fn load_full_resolution_image(file_path: &Path) -> Response {
    // For RAW files, use macOS sips for proper color rendering
    if is_raw_file(file_path) {
        if let Ok(data) = convert_raw_with_sips(file_path, 8192) {
            return tauri::ipc::Response::new(data);
        }
        // If sips fails, fall through to raw bytes
        let data = fs::read(file_path).unwrap_or_default();
        return tauri::ipc::Response::new(data);
    }

    // For JPEG/PNG/TIFF, send the original file bytes directly (true full res)
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

    let _ = app.emit("scan-complete", &ScanProgress {
        current: total_files,
        total: total_files,
        percentage: 100.0,
        current_file: None,
    });

    Ok(ScanResult { photos, stats })
}

/// Phase 2: Generate thumbnails in background, streaming each one to the
/// frontend as it completes via "thumbnail-ready" events.
#[tauri::command]
async fn generate_thumbnails(photos: Vec<Photo>, app: AppHandle) -> Result<(), String> {
    let items: Vec<(String, String)> = photos
        .into_iter()
        .map(|p| (p.id, p.file_path))
        .collect();

    let app = Arc::new(app);

    tokio::task::spawn_blocking(move || {
        items.par_iter().for_each(|(id, file_path)| {
            let path = Path::new(file_path);
            if let Ok(thumb) = generate_thumbnail(path) {
                let event = ThumbnailReady {
                    id: id.clone(),
                    thumbnail: thumb,
                };
                let _ = app.emit("thumbnail-ready", &event);
            }
        });
    })
    .await
    .map_err(|e| format!("Thumbnail generation failed: {}", e))?;

    Ok(())
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

#[tauri::command]
async fn save_edited_image(
    file_path: String,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let path = Path::new(&file_path);

    // Derive output path: insert "_edited" before extension
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let parent = path.parent().unwrap_or(Path::new("."));
    let output_path = parent.join(format!("{}_edited.jpg", stem));

    fs::write(&output_path, &image_data).map_err(|e| format!("Failed to save: {}", e))?;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder_fast,
            generate_thumbnails,
            filter_photos,
            get_photo_stats,
            load_full_resolution_image_command,
            save_edited_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
