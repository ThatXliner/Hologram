use anyhow::Result;
use rusqlite;
use base64::Engine;
use chrono::{DateTime, Utc};
use exif as kamadak_exif;
use image::ImageFormat;
use kamadak_exif::{In, Reader};
use ndarray::Array4;
use ort::session::Session;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAdjustments {
    pub exposure: f64,     // -100 to 100
    pub contrast: f64,     // -100 to 100
    pub saturation: f64,   // -100 to 100
    pub temperature: f64,  // -100 to 100
    pub highlights: f64,   // -100 to 100
    pub shadows: f64,      // -100 to 100
    pub sharpen: f64,      // 0 to 100
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
        deltas.push(if dx.abs() < 1e-6 { 0.0 } else { (ys[i + 1] - ys[i]) / dx });
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
    let has_curve = adj.curve_points.len() >= 2
        && adj.curve_points.iter().any(|(x, y)| (x - y).abs() > 0.01);

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
                r *= a; g *= a; b *= a;
            }
            if has_shad {
                let w = (1.0 - lum_norm) * (1.0 - lum_norm);
                let a = 1.0 + (shad_mul - 1.0) * w;
                r *= a; g *= a; b *= a;
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
                    if ny < 0 || ny >= h as i32 { continue; }
                    for dx in -1i32..=1 {
                        let nx = x as i32 + dx;
                        if nx < 0 || nx >= w as i32 { continue; }
                        let kernel_w = (if dx == 0 { 2.0 } else { 1.0 }) * (if dy == 0 { 2.0 } else { 1.0 });
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
                w * h * 4, w, h, image_bytes.len()
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
        let session = guard.as_mut().ok_or_else(|| "Denoise model not loaded".to_string())?;

        let input_value = ort::value::Tensor::from_array(input)
            .map_err(|e| format!("Input error: {}", e))?;
        let outputs = session.run(
            ort::inputs!["input" => input_value]
        ).map_err(|e| format!("Inference error: {}", e))?;

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

    // Load the full-res image (handle RAW via sips conversion)
    let image_bytes = if is_raw_file(path) {
        convert_raw_with_sips(path, 8192).map_err(|e| format!("RAW conversion failed: {}", e))?
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
}

fn open_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hologram.db");
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_metadata (
            photo_id TEXT PRIMARY KEY,
            tags TEXT NOT NULL DEFAULT '[]',
            notes TEXT NOT NULL DEFAULT ''
        )",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn set_photo_metadata(
    app: AppHandle,
    photo_id: String,
    tags: Vec<String>,
    notes: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO photo_metadata (photo_id, tags, notes) VALUES (?1, ?2, ?3)
         ON CONFLICT(photo_id) DO UPDATE SET tags=excluded.tags, notes=excluded.notes",
        rusqlite::params![photo_id, tags_json, notes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_photo_metadata(
    app: AppHandle,
    photo_ids: Vec<String>,
) -> Result<HashMap<String, PhotoMetadata>, String> {
    let conn = open_db(&app)?;
    let mut result = HashMap::new();
    for photo_id in &photo_ids {
        if let Ok((tags_json, notes)) = conn.query_row(
            "SELECT tags, notes FROM photo_metadata WHERE photo_id = ?1",
            rusqlite::params![photo_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            result.insert(photo_id.clone(), PhotoMetadata { tags, notes });
        }
    }
    Ok(result)
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
                match Session::builder()
                    .and_then(|mut b| b.commit_from_file(&model_path))
                {
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
            filter_photos,
            get_photo_stats,
            load_full_resolution_image_command,
            apply_edits_and_save,
            denoise_image,
            set_photo_metadata,
            get_photo_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
