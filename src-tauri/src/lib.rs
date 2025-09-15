use anyhow::Result;
use base64::Engine;
use chrono::{DateTime, Utc};
use exif as kamadak_exif;
use futures::future::join_all;
use image::GenericImageView;
use image::ImageFormat;
use kamadak_exif::{In, Reader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
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
        // Camera make
        if let Some(field) = exif.get_field(kamadak_exif::Tag::Make, In::PRIMARY) {
            exif_data.camera_make = Some(field.display_value().to_string());
        }

        // Camera model
        if let Some(field) = exif.get_field(kamadak_exif::Tag::Model, In::PRIMARY) {
            exif_data.camera_model = Some(field.display_value().to_string());
        }

        // Lens model
        if let Some(field) = exif.get_field(kamadak_exif::Tag::LensModel, In::PRIMARY) {
            exif_data.lens_model = Some(field.display_value().to_string());
        }

        // Focal length
        if let Some(field) = exif.get_field(kamadak_exif::Tag::FocalLength, In::PRIMARY) {
            if let kamadak_exif::Value::Rational(ref vec) = field.value {
                if let Some(rational) = vec.first() {
                    exif_data.focal_length = Some(rational.to_f64());
                }
            }
        }

        // Aperture
        if let Some(field) = exif.get_field(kamadak_exif::Tag::FNumber, In::PRIMARY) {
            if let kamadak_exif::Value::Rational(ref vec) = field.value {
                if let Some(rational) = vec.first() {
                    exif_data.aperture = Some(rational.to_f64());
                }
            }
        }

        // ISO
        if let Some(field) = exif.get_field(kamadak_exif::Tag::PhotographicSensitivity, In::PRIMARY)
        {
            if let kamadak_exif::Value::Short(ref vec) = field.value {
                if let Some(iso) = vec.first() {
                    exif_data.iso = Some(*iso as u32);
                }
            }
        }

        // Shutter speed
        if let Some(field) = exif.get_field(kamadak_exif::Tag::ExposureTime, In::PRIMARY) {
            exif_data.shutter_speed = Some(field.display_value().to_string());
        }

        // Image dimensions
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

        if exif_data.width.is_none() || exif_data.height.is_none() {
            if let Ok(img) = image::open(file_path) {
                let (width, height) = img.dimensions();
                exif_data.width = Some(width);
                exif_data.height = Some(height);
            }
        }
    }

    Ok(exif_data)
}

fn generate_thumbnail(file_path: &Path) -> Result<String> {
    let img = image::open(file_path)?;
    let thumbnail = img.thumbnail(200, 200);

    let mut buffer = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buffer);
    thumbnail.write_to(&mut cursor, ImageFormat::Jpeg)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(buffer))
}

async fn process_photo_parallel(path: &Path) -> Option<Photo> {
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

    let path_clone = path.to_path_buf();
    let (exif_data, thumbnail) = tokio::task::spawn_blocking(move || {
        let exif = extract_exif_data(&path_clone).unwrap_or_default();
        let thumb = generate_thumbnail(&path_clone).ok();
        (exif, thumb)
    })
    .await
    .ok()?;

    Some(Photo {
        id: Uuid::new_v4().to_string(),
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_size,
        file_type,
        thumbnail,
        exif: exif_data,
        created_at: Utc::now(),
        modified_at,
        paired_with: None,
    })
}

fn load_full_resolution_image(file_path: &Path) -> Response {
    let img = fs::read(file_path).unwrap();
    tauri::ipc::Response::new(img)
    // let img = image::open(file_path)?;

    // // Resize if image is too large (max 2048px on longest side)
    // let (width, height) = img.dimensions();
    // let max_dimension = width.max(height);

    // let processed_img = if max_dimension > 2048 {
    //     let scale = 2048.0 / max_dimension as f32;
    //     let new_width = (width as f32 * scale) as u32;
    //     let new_height = (height as f32 * scale) as u32;
    //     img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
    // } else {
    //     img
    // };

    // let mut buffer = Vec::new();
    // let mut cursor = std::io::Cursor::new(&mut buffer);
    // processed_img.write_to(&mut cursor, ImageFormat::Jpeg)?;

    // Ok(base64::engine::general_purpose::STANDARD.encode(buffer))
}

fn pair_raw_jpeg(photos: &mut Vec<Photo>) {
    let mut base_names: HashMap<String, Vec<usize>> = HashMap::new();

    // Group photos by base filename (without extension)
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

    // Pair RAW and JPEG files with the same base name
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

#[tauri::command]
async fn scan_folder(folder_path: String) -> Result<Vec<Photo>, String> {
    scan_folder_parallel(folder_path).await
}

#[tauri::command]
async fn scan_folder_parallel(folder_path: String) -> Result<Vec<Photo>, String> {
    let paths: Vec<std::path::PathBuf> = WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| is_supported_file(path))
        .collect();

    const CHUNK_SIZE: usize = 50;
    let mut all_photos = Vec::new();

    for chunk in paths.chunks(CHUNK_SIZE) {
        let chunk_futures: Vec<_> = chunk
            .iter()
            .map(|path| process_photo_parallel(path))
            .collect();

        let chunk_results = join_all(chunk_futures).await;
        let chunk_photos: Vec<Photo> = chunk_results.into_iter().filter_map(|p| p).collect();
        all_photos.extend(chunk_photos);
    }

    pair_raw_jpeg(&mut all_photos);
    Ok(all_photos)
}

#[tauri::command]
async fn scan_folder_with_progress(folder_path: String, app: AppHandle) -> Result<Vec<Photo>, String> {
    let paths: Vec<std::path::PathBuf> = WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| is_supported_file(path))
        .collect();

    let total_files = paths.len();
    let processed_count = Arc::new(AtomicUsize::new(0));

    const CHUNK_SIZE: usize = 50;
    let mut all_photos = Vec::new();

    for chunk in paths.chunks(CHUNK_SIZE) {
        let chunk_futures: Vec<_> = chunk
            .iter()
            .map(|path| {
                let processed_count = Arc::clone(&processed_count);
                let app = app.clone();
                let path = path.clone();
                async move {
                    let result = process_photo_parallel(&path).await;

                    let current = processed_count.fetch_add(1, Ordering::SeqCst) + 1;
                    let percentage = (current as f64 / total_files as f64) * 100.0;

                    let progress = ScanProgress {
                        current,
                        total: total_files,
                        percentage,
                        current_file: Some(path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string()),
                    };

                    if let Err(e) = app.emit("scan-progress", &progress) {
                        eprintln!("Failed to emit progress: {}", e);
                    }

                    result
                }
            })
            .collect();

        let chunk_results = join_all(chunk_futures).await;
        let chunk_photos: Vec<Photo> = chunk_results.into_iter().filter_map(|p| p).collect();
        all_photos.extend(chunk_photos);
    }

    pair_raw_jpeg(&mut all_photos);

    let final_progress = ScanProgress {
        current: total_files,
        total: total_files,
        percentage: 100.0,
        current_file: None,
    };

    if let Err(e) = app.emit("scan-complete", &final_progress) {
        eprintln!("Failed to emit completion: {}", e);
    }

    Ok(all_photos)
}

#[tauri::command]
async fn scan_folder_sequential(folder_path: String) -> Result<Vec<Photo>, String> {
    let mut photos = Vec::new();

    for entry in WalkDir::new(&folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        if !is_supported_file(path) {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };

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

        let thumbnail = generate_thumbnail(path).ok();

        let photo = Photo {
            id: Uuid::new_v4().to_string(),
            file_path: path.to_string_lossy().to_string(),
            file_name,
            file_size,
            file_type,
            thumbnail,
            exif: exif_data,
            created_at: Utc::now(),
            modified_at,
            paired_with: None,
        };

        photos.push(photo);
    }

    pair_raw_jpeg(&mut photos);

    Ok(photos)
}

#[tauri::command]
async fn filter_photos(photos: Vec<Photo>, filter: PhotoFilter) -> Result<Vec<Photo>, String> {
    filter_photos_parallel(photos, filter).await
}

#[tauri::command]
async fn filter_photos_parallel(
    photos: Vec<Photo>,
    filter: PhotoFilter,
) -> Result<Vec<Photo>, String> {
    let filter = Arc::new(filter);

    let filtered: Vec<Photo> = photos
        .into_par_iter()
        .filter(|photo| {
            let filter = Arc::clone(&filter);

            // Camera make filter
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

            // Camera model filter
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

            // Lens model filter
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

            // Focal length range filter
            if let Some((min_fl, max_fl)) = filter.focal_length_range {
                if let Some(fl) = photo.exif.focal_length {
                    if fl < min_fl || fl > max_fl {
                        return false;
                    }
                } else {
                    return false;
                }
            }

            // Aperture range filter
            if let Some((min_ap, max_ap)) = filter.aperture_range {
                if let Some(ap) = photo.exif.aperture {
                    if ap < min_ap || ap > max_ap {
                        return false;
                    }
                } else {
                    return false;
                }
            }

            // ISO range filter
            if let Some((min_iso, max_iso)) = filter.iso_range {
                if let Some(iso) = photo.exif.iso {
                    if iso < min_iso || iso > max_iso {
                        return false;
                    }
                } else {
                    return false;
                }
            }

            // File type filter
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
async fn get_photo_stats(photos: Vec<Photo>) -> Result<HashMap<String, serde_json::Value>, String> {
    let mut stats = HashMap::new();

    let total_photos = photos.len();
    let raw_count = photos
        .iter()
        .filter(|p| is_raw_file(Path::new(&p.file_path)))
        .count();
    let jpeg_count = total_photos - raw_count;
    let paired_count = photos.iter().filter(|p| p.paired_with.is_some()).count();

    let mut cameras = HashMap::new();
    let mut lenses = HashMap::new();

    for photo in &photos {
        if let Some(ref camera) = photo.exif.camera_model {
            *cameras.entry(camera.clone()).or_insert(0) += 1;
        }
        if let Some(ref lens) = photo.exif.lens_model {
            *lenses.entry(lens.clone()).or_insert(0) += 1;
        }
    }

    stats.insert(
        "total_photos".to_string(),
        serde_json::Value::Number(total_photos.into()),
    );
    stats.insert(
        "raw_count".to_string(),
        serde_json::Value::Number(raw_count.into()),
    );
    stats.insert(
        "jpeg_count".to_string(),
        serde_json::Value::Number(jpeg_count.into()),
    );
    stats.insert(
        "paired_count".to_string(),
        serde_json::Value::Number(paired_count.into()),
    );
    stats.insert(
        "cameras".to_string(),
        serde_json::to_value(cameras).unwrap(),
    );
    stats.insert("lenses".to_string(), serde_json::to_value(lenses).unwrap());

    Ok(stats)
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
    // load_full_resolution_image(path).map_err(|e| format!("Failed to load image: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            scan_folder_parallel,
            scan_folder_with_progress,
            scan_folder_sequential,
            filter_photos,
            filter_photos_parallel,
            get_photo_stats,
            load_full_resolution_image_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
