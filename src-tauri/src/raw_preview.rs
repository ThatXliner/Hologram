use anyhow::Result;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, RgbImage};
use exif::{In, Reader, Tag, Value};
use rsraw::{ImageFormat as RawImageFormat, RawImage, ThumbFormat, BIT_DEPTH_8};
use std::fs;
use std::path::{Path, PathBuf};

static RAW_EXTENSIONS: &[&str] = &[
    "3fr", "ari", "arw", "bay", "cap", "crw", "cr2", "cr3", "data", "dcs", "dcr", "dng", "drf",
    "erf", "fff", "gpr", "iiq", "k25", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm",
    "orf", "pef", "ptx", "pxn", "raf", "raw", "rw2", "rwl", "rwz", "sr2", "srf", "srw", "x3f",
];

static SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "tiff", "tif", "png", "3fr", "ari", "arw", "bay", "cap", "crw", "cr2", "cr3",
    "data", "dcs", "dcr", "dng", "drf", "erf", "fff", "gpr", "iiq", "k25", "kdc", "mdc", "mef",
    "mos", "mrw", "nef", "nrw", "obm", "orf", "pef", "ptx", "pxn", "raf", "raw", "rw2", "rwl",
    "rwz", "sr2", "srf", "srw", "x3f",
];

pub fn is_supported_file(path: &Path) -> bool {
    extension_matches(path, SUPPORTED_EXTENSIONS)
}

pub fn is_raw_file(path: &Path) -> bool {
    extension_matches(path, RAW_EXTENSIONS)
}

fn extension_matches(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| extensions.contains(&ext.to_lowercase().as_str()))
}

/// Convert a RAW file to JPEG bytes using LibRaw.
/// Results are cached on disk keyed by file path + mtime + dimension.
pub fn convert_raw_to_jpeg(file_path: &Path, max_dimension: u32) -> Result<Vec<u8>> {
    let cache_dir = raw_preview_cache_dir();
    let cache_key = raw_preview_cache_key(file_path, max_dimension);
    let cache_path = cache_dir.join(&cache_key);

    if cache_path.exists() {
        if let Ok(data) = fs::read(&cache_path) {
            if !data.is_empty() {
                return Ok(data);
            }
        }
    }

    let data = if max_dimension <= 1024 {
        extract_embedded_raw_preview(file_path, max_dimension)
            .or_else(|_| render_raw_with_libraw(file_path, max_dimension))?
    } else {
        render_raw_with_libraw(file_path, max_dimension)?
    };

    let _ = fs::write(&cache_path, &data);
    Ok(data)
}

pub fn generate_thumbnail(file_path: &Path) -> Result<String> {
    if is_raw_file(file_path) {
        let data = convert_raw_to_jpeg(file_path, 400)?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(data));
    }

    let img = image::open(file_path)?;
    let img = apply_exif_orientation(img, read_exif_orientation(file_path));
    let thumbnail = img.thumbnail(400, 400);
    let buffer = encode_jpeg(&thumbnail, 90)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(buffer))
}

fn read_exif_orientation(file_path: &Path) -> Option<u16> {
    let file = fs::File::open(file_path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = Reader::new().read_from_container(&mut reader).ok()?;
    let field = exif.get_field(Tag::Orientation, In::PRIMARY)?;

    match field.value {
        Value::Short(ref values) => values.first().copied(),
        Value::Long(ref values) => values.first().map(|value| *value as u16),
        _ => None,
    }
}

fn apply_exif_orientation(image: DynamicImage, orientation: Option<u16>) -> DynamicImage {
    match orientation.unwrap_or(1) {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.fliph().rotate90(),
        6 => image.rotate90(),
        7 => image.fliph().rotate270(),
        8 => image.rotate270(),
        _ => image,
    }
}

/// Get the cache directory for LibRaw conversions.
fn raw_preview_cache_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("hologram_raw_preview_cache");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Generate a cache key from file path + modification time + max dimension.
fn raw_preview_cache_key(file_path: &Path, max_dimension: u32) -> String {
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

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut buffer = Vec::with_capacity(16384);
    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder.encode_image(image)?;
    Ok(buffer)
}

fn bounded_jpeg_from_image(image: DynamicImage, max_dimension: u32) -> Result<Vec<u8>> {
    let max_dimension = max_dimension.max(1);
    let preview = image.thumbnail(max_dimension, max_dimension);
    encode_jpeg(&preview, 90)
}

fn extract_embedded_raw_preview(file_path: &Path, max_dimension: u32) -> Result<Vec<u8>> {
    let raw_bytes = fs::read(file_path)?;
    let mut raw_image = RawImage::open(&raw_bytes)?;
    let preview = raw_image
        .extract_thumbs()?
        .into_iter()
        .filter(|thumbnail| {
            thumbnail.format == ThumbFormat::Jpeg
                && thumbnail.width > 0
                && thumbnail.height > 0
                && !thumbnail.data.is_empty()
        })
        .max_by_key(|thumbnail| u64::from(thumbnail.width) * u64::from(thumbnail.height))
        .ok_or_else(|| anyhow::anyhow!("RAW file does not contain a JPEG preview"))?;

    let image = image::load_from_memory(&preview.data)?;
    let image = apply_exif_orientation(image, read_exif_orientation(file_path));
    bounded_jpeg_from_image(image, max_dimension)
}

fn render_raw_with_libraw(file_path: &Path, max_dimension: u32) -> Result<Vec<u8>> {
    let raw_bytes = fs::read(file_path)?;
    let mut raw_image = RawImage::open(&raw_bytes)?;
    raw_image.set_use_camera_wb(true);
    raw_image.set_use_camera_matrix(true);
    raw_image.unpack()?;

    let processed = raw_image.process::<BIT_DEPTH_8>()?;
    if processed.image_format() != RawImageFormat::Bitmap {
        anyhow::bail!("LibRaw returned an unsupported processed image format");
    }

    let colors = usize::from(processed.colors());
    let raw_pixels: &[u8] = &processed;
    let pixel_count = u64::from(processed.width()) * u64::from(processed.height());
    let mut rgb_pixels = Vec::with_capacity((pixel_count * 3) as usize);

    match colors {
        1 => {
            for value in raw_pixels {
                rgb_pixels.extend_from_slice(&[*value, *value, *value]);
            }
        }
        3 => rgb_pixels.extend_from_slice(raw_pixels),
        4 => {
            for pixel in raw_pixels.chunks_exact(4) {
                rgb_pixels.extend_from_slice(&pixel[..3]);
            }
        }
        _ => anyhow::bail!("LibRaw returned {} color channels", colors),
    }

    let image = RgbImage::from_raw(processed.width(), processed.height(), rgb_pixels)
        .ok_or_else(|| anyhow::anyhow!("Failed to assemble LibRaw RGB image"))?;
    let image = apply_exif_orientation(DynamicImage::ImageRgb8(image), read_exif_orientation(file_path));

    bounded_jpeg_from_image(image, max_dimension)
}
