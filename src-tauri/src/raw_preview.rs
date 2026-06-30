use anyhow::Result;
use base64::Engine;
use exif::{Exif, In, Reader, Tag, Value};
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
#[cfg(not(target_env = "msvc"))]
use image::RgbImage;
#[cfg(not(target_env = "msvc"))]
use rsraw::{ImageFormat as RawImageFormat, RawImage, ThumbFormat, BIT_DEPTH_8};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedJpegPreview {
    pub width: u32,
    pub height: u32,
    pub byte_size: usize,
}

#[derive(Debug, Clone)]
pub struct RawPreview {
    pub data: Vec<u8>,
    pub embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
}

#[derive(Debug, Clone)]
pub struct GeneratedThumbnail {
    pub thumbnail: String,
    pub embedded_jpeg_preview: Option<EmbeddedJpegPreview>,
}

struct EmbeddedJpegPreviewData {
    info: EmbeddedJpegPreview,
    data: Vec<u8>,
}

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

/// Convert a RAW file to browser-friendly JPEG bytes.
/// This prefers the camera's embedded JPEG preview and only falls back to a
/// full LibRaw render when the file has no usable embedded JPEG.
#[cfg(not(target_env = "msvc"))]
pub fn convert_raw_preview_to_jpeg(file_path: &Path, max_dimension: u32) -> Result<RawPreview> {
    let cache_dir = raw_preview_cache_dir();
    let cache_key = raw_preview_cache_key(file_path, max_dimension, "preview");
    let cache_path = cache_dir.join(&cache_key);

    if let Some(data) = read_cached_jpeg(&cache_path) {
        return Ok(RawPreview {
            data,
            embedded_jpeg_preview: read_cached_preview_info(&cache_path),
        });
    }

    let preview = extract_embedded_raw_preview(file_path, max_dimension).or_else(|_| {
        render_raw_with_libraw(file_path, max_dimension).map(|data| RawPreview {
            data,
            embedded_jpeg_preview: None,
        })
    })?;

    write_cached_jpeg(&cache_path, &preview.data);
    write_cached_preview_info(&cache_path, preview.embedded_jpeg_preview.as_ref());
    Ok(preview)
}

#[cfg(target_env = "msvc")]
pub fn convert_raw_preview_to_jpeg(_file_path: &Path, _max_dimension: u32) -> Result<RawPreview> {
    anyhow::bail!("RAW preview rendering is not supported on MSVC builds")
}

/// Render RAW pixels through LibRaw. This is intentionally separate from the
/// preview path so editing/exporting can request a true render without being
/// served a cached embedded JPEG preview.
#[cfg(not(target_env = "msvc"))]
pub fn render_raw_to_jpeg(file_path: &Path, max_dimension: u32) -> Result<Vec<u8>> {
    let cache_dir = raw_preview_cache_dir();
    let cache_key = raw_preview_cache_key(file_path, max_dimension, "render");
    let cache_path = cache_dir.join(&cache_key);

    if let Some(data) = read_cached_jpeg(&cache_path) {
        return Ok(data);
    }

    let data = render_raw_with_libraw(file_path, max_dimension)?;
    write_cached_jpeg(&cache_path, &data);
    Ok(data)
}

#[cfg(target_env = "msvc")]
pub fn render_raw_to_jpeg(_file_path: &Path, _max_dimension: u32) -> Result<Vec<u8>> {
    anyhow::bail!("RAW rendering is not supported on MSVC builds")
}

pub fn generate_thumbnail_with_info(file_path: &Path) -> Result<GeneratedThumbnail> {
    if is_raw_file(file_path) {
        let preview = convert_raw_preview_to_jpeg(file_path, 400)?;
        return Ok(GeneratedThumbnail {
            thumbnail: base64::engine::general_purpose::STANDARD.encode(preview.data),
            embedded_jpeg_preview: preview.embedded_jpeg_preview,
        });
    }

    let img = image::open(file_path)?;
    let img = apply_exif_orientation(img, read_exif_orientation(file_path));
    let thumbnail = img.thumbnail(400, 400);
    let buffer = encode_jpeg(&thumbnail, 90)?;

    Ok(GeneratedThumbnail {
        thumbnail: base64::engine::general_purpose::STANDARD.encode(buffer),
        embedded_jpeg_preview: None,
    })
}

pub fn generate_embedded_thumbnail(file_path: &Path) -> Option<String> {
    extract_embedded_jpeg_thumbnail(file_path)
        .ok()
        .map(|data| base64::engine::general_purpose::STANDARD.encode(data))
}

fn read_exif(file_path: &Path) -> Result<Exif> {
    let file = fs::File::open(file_path)?;
    let mut reader = std::io::BufReader::new(file);
    Ok(Reader::new().read_from_container(&mut reader)?)
}

fn read_exif_orientation(file_path: &Path) -> Option<u16> {
    read_exif(file_path)
        .ok()
        .and_then(|exif| exif_orientation(&exif, In::PRIMARY))
}

fn read_exif_orientation_from_bytes(data: &[u8]) -> Option<u16> {
    let mut cursor = std::io::Cursor::new(data);
    Reader::new()
        .read_from_container(&mut cursor)
        .ok()
        .and_then(|exif| exif_orientation(&exif, In::PRIMARY))
}

fn first_exif_u32(value: &Value) -> Option<u32> {
    value.get_uint(0)
}

fn exif_orientation(exif: &Exif, ifd: In) -> Option<u16> {
    exif.get_field(Tag::Orientation, ifd)
        .and_then(|field| first_exif_u32(&field.value))
        .and_then(|value| u16::try_from(value).ok())
}

fn extract_embedded_jpeg_thumbnail(file_path: &Path) -> Result<Vec<u8>> {
    let exif = read_exif(file_path)?;
    extract_embedded_jpeg_thumbnail_from_exif(&exif)
}

fn extract_embedded_jpeg_thumbnail_from_exif(exif: &Exif) -> Result<Vec<u8>> {
    let offset =
        exif.get_field(Tag::JPEGInterchangeFormat, In::THUMBNAIL)
            .and_then(|field| first_exif_u32(&field.value))
            .ok_or_else(|| anyhow::anyhow!("No embedded JPEG thumbnail offset"))? as usize;
    let len =
        exif.get_field(Tag::JPEGInterchangeFormatLength, In::THUMBNAIL)
            .and_then(|field| first_exif_u32(&field.value))
            .ok_or_else(|| anyhow::anyhow!("No embedded JPEG thumbnail length"))? as usize;
    let end = offset
        .checked_add(len)
        .filter(|end| *end <= exif.buf().len())
        .ok_or_else(|| anyhow::anyhow!("Invalid embedded JPEG thumbnail range"))?;
    let data = exif.buf()[offset..end].to_vec();
    if !data.starts_with(&[0xFF, 0xD8]) {
        anyhow::bail!("Embedded thumbnail is not a JPEG");
    }
    let orientation =
        exif_orientation(&exif, In::THUMBNAIL).or_else(|| exif_orientation(&exif, In::PRIMARY));
    orient_jpeg_bytes(data, orientation)
}

fn orient_jpeg_bytes(data: Vec<u8>, orientation: Option<u16>) -> Result<Vec<u8>> {
    if matches!(orientation.unwrap_or(1), 1) {
        return Ok(data);
    }

    let image = image::load_from_memory(&data)?;
    let image = apply_exif_orientation(image, orientation);
    encode_jpeg(&image, 90)
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

/// Generate a cache key from mode + file path + modification time + max dimension.
fn raw_preview_cache_key(file_path: &Path, max_dimension: u32, cache_kind: &str) -> String {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cache_kind.hash(&mut hasher);
    file_path.hash(&mut hasher);
    if let Ok(meta) = fs::metadata(file_path) {
        if let Ok(modified) = meta.modified() {
            modified.hash(&mut hasher);
        }
    }
    max_dimension.hash(&mut hasher);
    format!("{:x}.jpeg", hasher.finish())
}

fn read_cached_jpeg(cache_path: &Path) -> Option<Vec<u8>> {
    fs::read(cache_path).ok().filter(|data| !data.is_empty())
}

fn write_cached_jpeg(cache_path: &Path, data: &[u8]) {
    let _ = fs::write(cache_path, data);
}

fn preview_info_cache_path(cache_path: &Path) -> PathBuf {
    cache_path.with_extension("json")
}

fn read_cached_preview_info(cache_path: &Path) -> Option<EmbeddedJpegPreview> {
    let info_path = preview_info_cache_path(cache_path);
    fs::read(info_path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
}

fn write_cached_preview_info(cache_path: &Path, info: Option<&EmbeddedJpegPreview>) {
    let info_path = preview_info_cache_path(cache_path);
    if let Some(info) = info {
        if let Ok(data) = serde_json::to_vec(info) {
            let _ = fs::write(info_path, data);
        }
    } else {
        let _ = fs::remove_file(info_path);
    }
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

#[cfg(not(target_env = "msvc"))]
fn extract_largest_embedded_jpeg_preview(file_path: &Path) -> Result<EmbeddedJpegPreviewData> {
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
                && thumbnail.data.starts_with(&[0xFF, 0xD8])
        })
        .max_by_key(|thumbnail| u64::from(thumbnail.width) * u64::from(thumbnail.height))
        .ok_or_else(|| anyhow::anyhow!("RAW file does not contain a JPEG preview"))?;

    Ok(EmbeddedJpegPreviewData {
        info: EmbeddedJpegPreview {
            width: preview.width,
            height: preview.height,
            byte_size: preview.data.len(),
        },
        data: preview.data,
    })
}

#[cfg(not(target_env = "msvc"))]
fn extract_embedded_raw_preview(file_path: &Path, max_dimension: u32) -> Result<RawPreview> {
    let preview = extract_largest_embedded_jpeg_preview(file_path)?;
    let image = image::load_from_memory(&preview.data)?;
    let image = apply_exif_orientation(image, read_exif_orientation_from_bytes(&preview.data));
    Ok(RawPreview {
        data: bounded_jpeg_from_image(image, max_dimension)?,
        embedded_jpeg_preview: Some(preview.info),
    })
}

#[cfg(not(target_env = "msvc"))]
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
    let image = apply_exif_orientation(
        DynamicImage::ImageRgb8(image),
        read_exif_orientation(file_path),
    );

    bounded_jpeg_from_image(image, max_dimension)
}
