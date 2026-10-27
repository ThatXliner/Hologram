use crate::{is_supported_file, Photo, PhotoMetadata};
use roxmltree::{Document, Node};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XMP: &str = "http://ns.adobe.com/xap/1.0/";
const DC: &str = "http://purl.org/dc/elements/1.1/";
const XMP_MM: &str = "http://ns.adobe.com/xap/1.0/mm/";
const DARKTABLE: &str = "http://darktable.sf.net/";

#[derive(Debug, PartialEq, Eq)]
enum Rating {
    Rejected,
    Stars(u8),
}

#[derive(Debug, Default)]
struct Patch {
    rating: Option<Rating>,
    flag: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    derived_from: Option<String>,
    ignored_colors: bool,
}

impl Patch {
    fn has_culling(&self) -> bool {
        self.rating.is_some() || self.flag.is_some()
    }

    fn has_metadata(&self) -> bool {
        self.has_culling() || self.tags.is_some() || self.notes.is_some()
    }

    fn apply(&self, existing: &PhotoMetadata) -> PhotoMetadata {
        let mut next = existing.clone();
        if let Some(tags) = &self.tags {
            next.tags = tags.clone();
        }
        if let Some(notes) = &self.notes {
            next.notes = notes.clone();
        }
        match self.rating {
            Some(Rating::Rejected) => {
                next.rating = 0;
                next.flag = "reject".into();
            }
            Some(Rating::Stars(stars)) => {
                next.rating = stars;
                next.flag = "none".into();
            }
            None => {}
        }
        if let Some(flag) = &self.flag {
            next.flag = flag.clone();
        }
        if self.has_culling()
            && (next.rating != existing.rating
                || next.flag != existing.flag
                || existing.xmp_cull_revision.is_none())
        {
            next.xmp_cull_revision = Some(Uuid::new_v4().to_string());
        }
        next
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Imported,
    Unchanged,
    Skipped,
    Error,
}

#[derive(Debug, Serialize)]
pub struct XmpImportOutcome {
    photo_id: String,
    file_path: String,
    sidecar_path: Option<String>,
    status: ImportStatus,
    message: String,
}

#[derive(Debug, Default, Serialize)]
pub struct XmpImportResult {
    imported_count: usize,
    unchanged_count: usize,
    skipped_count: usize,
    error_count: usize,
    outcomes: Vec<XmpImportOutcome>,
    metadata: HashMap<String, PhotoMetadata>,
}

impl XmpImportResult {
    fn record(
        &mut self,
        photo: &Photo,
        sidecar: Option<&Path>,
        status: ImportStatus,
        message: String,
    ) {
        match status {
            ImportStatus::Imported => self.imported_count += 1,
            ImportStatus::Unchanged => self.unchanged_count += 1,
            ImportStatus::Skipped => self.skipped_count += 1,
            ImportStatus::Error => self.error_count += 1,
        }
        self.outcomes.push(XmpImportOutcome {
            photo_id: photo.id.clone(),
            file_path: photo.file_path.clone(),
            sidecar_path: sidecar.map(|path| path.to_string_lossy().into_owned()),
            status,
            message,
        });
    }
}

fn assign<T: PartialEq>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.as_ref().is_some_and(|previous| previous != &value) {
        return Err(format!("Conflicting {name} properties"));
    }
    *slot = Some(value);
    Ok(())
}

fn scalar(node: Node<'_, '_>) -> Result<String, String> {
    if node.children().any(|child| child.is_element())
        || node.attribute((RDF, "resource")).is_some()
    {
        return Err(format!("Unsupported {} value", node.tag_name().name()));
    }
    Ok(node
        .children()
        .filter_map(|child| child.text().filter(|_| child.is_text()))
        .collect())
}

fn apply_scalar(patch: &mut Patch, namespace: &str, name: &str, value: &str) -> Result<(), String> {
    match (namespace, name) {
        (XMP, "Rating") => {
            let rating = match value.trim().parse::<i8>() {
                Ok(-1) => Rating::Rejected,
                Ok(value @ 0..=5) => Rating::Stars(value as u8),
                _ => return Err("Unsupported xmp:Rating; expected -1 or 0 through 5".into()),
            };
            assign(&mut patch.rating, rating, "rating")?;
        }
        (XMP, "Label") => match value.trim().to_ascii_lowercase().as_str() {
            "pick" | "select" | "selected" => assign(&mut patch.flag, "pick".into(), "flag")?,
            "reject" | "rejected" => assign(&mut patch.flag, "reject".into(), "flag")?,
            "" => {}
            _ => patch.ignored_colors = true,
        },
        (XMP_MM, "DerivedFrom") => assign(
            &mut patch.derived_from,
            value.trim().to_owned(),
            "source filename",
        )?,
        (DC, "description") => assign(&mut patch.notes, value.to_owned(), "description")?,
        _ => {}
    }
    Ok(())
}

fn container_values(
    node: Node<'_, '_>,
    allowed: &[&str],
) -> Result<Vec<(String, Option<String>)>, String> {
    let children: Vec<_> = node.children().filter(|child| child.is_element()).collect();
    if children.len() != 1
        || children[0].tag_name().namespace() != Some(RDF)
        || !allowed.contains(&children[0].tag_name().name())
    {
        return Err(format!("Unsupported {} container", node.tag_name().name()));
    }
    let mut values = Vec::new();
    for child in children[0].children().filter(|child| child.is_element()) {
        if !child.has_tag_name((RDF, "li")) {
            return Err(format!("Unsupported {} item", node.tag_name().name()));
        }
        values.push((
            scalar(child)?,
            child
                .attribute(("http://www.w3.org/XML/1998/namespace", "lang"))
                .map(str::to_owned),
        ));
    }
    Ok(values)
}

fn parse(contents: &str) -> Result<Patch, String> {
    let document = Document::parse(contents).map_err(|error| format!("Invalid XML: {error}"))?;
    let mut patch = Patch::default();
    for rdf in document
        .descendants()
        .filter(|node| node.has_tag_name((RDF, "RDF")))
    {
        if rdf
            .ancestors()
            .skip(1)
            .any(|node| node.has_tag_name((RDF, "Description")))
        {
            continue;
        }
        for description in rdf
            .children()
            .filter(|node| node.has_tag_name((RDF, "Description")))
        {
            if description
                .attribute((RDF, "about"))
                .is_some_and(|value| !value.is_empty())
            {
                return Err("XMP describes a different RDF subject".into());
            }
            for attribute in description.attributes() {
                apply_scalar(
                    &mut patch,
                    attribute.namespace().unwrap_or(""),
                    attribute.name(),
                    attribute.value(),
                )?;
            }
            for property in description.children().filter(|node| node.is_element()) {
                let name = property.tag_name();
                match (name.namespace(), name.name()) {
                    (Some(XMP), "Rating" | "Label") | (Some(XMP_MM), "DerivedFrom") => {
                        apply_scalar(
                            &mut patch,
                            name.namespace().unwrap(),
                            name.name(),
                            &scalar(property)?,
                        )?;
                    }
                    (Some(DC), "subject") => {
                        let tags = container_values(property, &["Bag", "Seq"])?
                            .into_iter()
                            .map(|(value, _)| value.trim().to_owned())
                            .filter(|value| !value.is_empty())
                            .collect();
                        assign(&mut patch.tags, tags, "tags")?;
                    }
                    (Some(DC), "description") => {
                        let notes = if property.children().any(|child| child.is_element()) {
                            let values = container_values(property, &["Alt"])?;
                            values
                                .iter()
                                .find(|(_, language)| language.as_deref() == Some("x-default"))
                                .or_else(|| values.first())
                                .map(|(value, _)| value.clone())
                                .unwrap_or_default()
                        } else {
                            scalar(property)?
                        };
                        assign(&mut patch.notes, notes, "description")?;
                    }
                    (Some(DARKTABLE), "colorlabels") => patch.ignored_colors = true,
                    _ => {}
                }
            }
        }
    }
    if patch.rating == Some(Rating::Rejected) && patch.flag.as_deref() == Some("pick") {
        return Err("Rejected rating conflicts with an explicit pick flag".into());
    }
    Ok(patch)
}

fn directory_files(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().is_file() {
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files)
}

fn resolve(photo: &Path, files: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    let appended = crate::xmp_sidecar_path(photo);
    let stem = photo.with_extension("xmp");
    let candidates = |expected: &Path| -> Vec<PathBuf> {
        files
            .iter()
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("xmp"))
                    && path.file_stem() == expected.file_stem()
            })
            .cloned()
            .collect()
    };
    let exact = candidates(&appended);
    if exact.len() > 1 {
        return Err("Multiple sidecars match the original filename".into());
    }
    if let Some(path) = exact.into_iter().next() {
        return Ok(Some(path));
    }
    let bare = candidates(&stem);
    if bare.len() > 1 {
        return Err("Multiple sidecars match the image stem".into());
    }
    if let Some(path) = bare.into_iter().next() {
        let originals = files
            .iter()
            .filter(|candidate| {
                is_supported_file(candidate) && candidate.file_stem() == photo.file_stem()
            })
            .count();
        if originals != 1 {
            return Err(
                "Shared stem sidecar is ambiguous across original files; use filename.ext.xmp"
                    .into(),
            );
        }
        return Ok(Some(path));
    }
    Ok(None)
}

fn version_base(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?.to_str()?;
    let (base, version) = stem.rsplit_once('_')?;
    if version.len() < 2
        || !version.bytes().all(|byte| byte.is_ascii_digit())
        || version.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    Some(path.with_file_name(format!("{base}.{}", path.extension()?.to_str()?)))
}

fn association_error(photo: &Path, patch: &Patch, files: &[PathBuf]) -> Option<String> {
    if let Some(source) = &patch.derived_from {
        if photo.file_name() != Some(std::ffi::OsStr::new(source)) {
            return Some(format!(
                "Sidecar identifies a different source file: {source}"
            ));
        }
    } else if version_base(photo).is_some_and(|base| files.iter().any(|file| file == &base)) {
        return Some(
            "Numbered filename could be a darktable duplicate; source identity is missing".into(),
        );
    }
    None
}

fn existing_metadata(conn: &Connection, photo: &Photo) -> Result<PhotoMetadata, String> {
    conn.query_row(
        "SELECT tags, notes, rating, flag, xmp_cull_revision FROM photo_metadata WHERE photo_id=?1",
        [&photo.id],
        |row| {
            let tags: String = row.get(0)?;
            let tags = serde_json::from_str(&tags).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(PhotoMetadata {
                tags,
                notes: row.get(1)?,
                rating: row.get(2)?,
                flag: row.get(3)?,
                xmp_cull_revision: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|metadata| {
        metadata.unwrap_or_else(|| PhotoMetadata {
            tags: photo.tags.clone().unwrap_or_default(),
            notes: photo.notes.clone().unwrap_or_default(),
            rating: photo.rating.unwrap_or(0).min(5),
            flag: photo.flag.clone().unwrap_or_else(|| "none".into()),
            xmp_cull_revision: None,
        })
    })
}

pub fn import(conn: &mut Connection, photos: &[Photo]) -> Result<XmpImportResult, String> {
    let mut report = XmpImportResult::default();
    let mut directories = HashMap::new();
    let mut consumed = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    for photo in photos {
        let path = Path::new(&photo.file_path);
        if !seen_ids.insert(&photo.id) || !seen_paths.insert(path) {
            report.record(
                photo,
                None,
                ImportStatus::Skipped,
                "Duplicate catalog entry".into(),
            );
            continue;
        }
        if !path.is_file() {
            report.record(
                photo,
                None,
                ImportStatus::Skipped,
                "Original file is missing".into(),
            );
            continue;
        }
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let files = directories
            .entry(parent.to_path_buf())
            .or_insert_with(|| directory_files(parent));
        let files = match files {
            Ok(files) => files,
            Err(error) => {
                report.record(
                    photo,
                    None,
                    ImportStatus::Error,
                    format!("Could not read photo folder: {error}"),
                );
                continue;
            }
        };
        let sidecar = match resolve(path, files) {
            Ok(Some(sidecar)) => sidecar,
            Ok(None) => {
                report.record(
                    photo,
                    None,
                    ImportStatus::Skipped,
                    "No matching sidecar".into(),
                );
                continue;
            }
            Err(error) => {
                report.record(photo, None, ImportStatus::Skipped, error);
                continue;
            }
        };
        consumed.insert(sidecar.clone());
        let patch = match fs::read_to_string(&sidecar)
            .map_err(|error| format!("Could not read sidecar: {error}"))
            .and_then(|contents| parse(&contents))
        {
            Ok(patch) => patch,
            Err(error) => {
                report.record(photo, Some(&sidecar), ImportStatus::Error, error);
                continue;
            }
        };
        if let Some(error) = association_error(path, &patch, files) {
            report.record(photo, Some(&sidecar), ImportStatus::Skipped, error);
            continue;
        }
        if !patch.has_metadata() {
            report.record(
                photo,
                Some(&sidecar),
                ImportStatus::Skipped,
                if patch.ignored_colors {
                    "Color labels are not supported; no supported metadata".into()
                } else {
                    "No supported culling or metadata properties".into()
                },
            );
            continue;
        }
        let existing = existing_metadata(&transaction, photo)?;
        let next = patch.apply(&existing);
        let changed = existing != next;
        transaction.execute(
            "INSERT INTO photo_metadata (photo_id, tags, notes, rating, flag, xmp_cull_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(photo_id) DO UPDATE SET tags=excluded.tags, notes=excluded.notes, rating=excluded.rating, flag=excluded.flag, xmp_cull_revision=excluded.xmp_cull_revision",
            params![photo.id, serde_json::to_string(&next.tags).map_err(|error| error.to_string())?, next.notes, next.rating, next.flag, next.xmp_cull_revision],
        ).map_err(|error| format!("Import was rolled back because metadata could not be saved: {error}"))?;
        report.metadata.insert(photo.id.clone(), next);
        let message = if patch.ignored_colors {
            "Supported metadata imported; color labels ignored"
        } else {
            "Supported fields replace existing values; absent fields preserved"
        };
        report.record(
            photo,
            Some(&sidecar),
            if changed {
                ImportStatus::Imported
            } else {
                ImportStatus::Unchanged
            },
            message.into(),
        );
    }
    for photo in photos {
        let path = Path::new(&photo.file_path);
        let Some(Ok(files)) = path.parent().and_then(|parent| directories.get(parent)) else {
            continue;
        };
        for candidate in files {
            if !candidate
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xmp"))
                || consumed.contains(candidate)
            {
                continue;
            }
            let original = candidate.with_extension("");
            if version_base(&original).as_deref() == Some(path) {
                consumed.insert(candidate.clone());
                report.record(photo, Some(candidate), ImportStatus::Skipped, "Darktable duplicate version has no matching catalog original; base photo was not changed by this sidecar".into());
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Import was rolled back: {error}"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DARKTABLE_FIXTURE: &str = include_str!("../tests/fixtures/xmp/darktable-unrated.xmp");

    struct Catalog {
        directory: PathBuf,
        connection: Connection,
    }

    impl Catalog {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("hologram-xmp-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let connection = Connection::open(directory.join("hologram.sql")).unwrap();
            crate::initialize_metadata_db(&connection).unwrap();
            Self {
                directory,
                connection,
            }
        }

        fn photo(&self, name: &str, rating: u8, flag: &str) -> Photo {
            let path = self.directory.join(name);
            fs::write(&path, b"original image bytes").unwrap();
            Photo {
                id: name.into(),
                file_path: path.to_string_lossy().into_owned(),
                file_name: name.into(),
                file_size: 20,
                file_type: "RAW".into(),
                thumbnail: None,
                exif: Default::default(),
                created_at: chrono::Utc::now(),
                modified_at: chrono::Utc::now(),
                paired_with: None,
                embedded_jpeg_preview: None,
                paired_raw_embedded_jpeg_preview: None,
                tags: Some(vec!["existing".into()]),
                notes: Some("existing note".into()),
                rating: Some(rating),
                flag: Some(flag.into()),
            }
        }

        fn sidecar(&self, name: &str, contents: &str) {
            fs::write(self.directory.join(name), contents).unwrap();
        }
    }

    impl Drop for Catalog {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn document(properties: &str) -> String {
        format!(
            r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="{RDF}"><r:Description xmlns:m="{XMP}" xmlns:d="{DC}" xmlns:dt="{DARKTABLE}" xmlns:mm="{XMP_MM}">{properties}</r:Description></r:RDF></x:xmpmeta>"#
        )
    }

    fn metadata(rating: u8, flag: &str) -> PhotoMetadata {
        PhotoMetadata {
            tags: vec!["keep".into()],
            notes: "keep".into(),
            rating,
            flag: flag.into(),
            xmp_cull_revision: None,
        }
    }

    #[test]
    fn reads_actual_darktable_writer_fixture_and_ignores_processing_history() {
        let patch = parse(DARKTABLE_FIXTURE).unwrap();
        assert_eq!(patch.rating, Some(Rating::Stars(0)));
        assert_eq!(patch.derived_from.as_deref(), Some("mire1.cr2"));
        assert_eq!(patch.flag, None);
        assert_eq!(patch.tags, None);
        assert_eq!(patch.notes, None);
        let rejected = parse(&DARKTABLE_FIXTURE.replace("xmp:Rating=\"0\"", "xmp:Rating=\"-1\""))
            .unwrap()
            .apply(&metadata(5, "pick"));
        assert_eq!((rejected.rating, rejected.flag.as_str()), (0, "reject"));
        for stars in 0..=5 {
            let patch = parse(
                &DARKTABLE_FIXTURE.replace("xmp:Rating=\"0\"", &format!("xmp:Rating=\"{stars}\"")),
            )
            .unwrap();
            let neutral = patch.apply(&metadata(2, "none"));
            assert_eq!((neutral.rating, neutral.flag.as_str()), (stars, "none"));
            assert_eq!(patch.apply(&metadata(2, "pick")).flag, "none");
            assert_eq!(patch.apply(&metadata(2, "reject")).flag, "none");
        }
    }

    #[test]
    fn namespace_aliases_elements_whitespace_and_entities_are_read_without_touching_colors() {
        let contents = document(
            r#"<m:Rating> 4 </m:Rating><m:Label>Red</m:Label><dt:colorlabels><r:Seq><r:li>0</r:li><r:li>2</r:li></r:Seq></dt:colorlabels><d:subject><r:Bag><r:li>client &amp; &#x65;dit</r:li></r:Bag></d:subject><d:description><r:Alt><r:li xml:lang="fr">français</r:li><r:li xml:lang="x-default">  &lt;hero&gt; &#9733;  </r:li></r:Alt></d:description>"#,
        );
        let patch = parse(&contents).unwrap();
        let updated = patch.apply(&metadata(0, "pick"));
        assert_eq!(updated.rating, 4);
        assert_eq!(updated.flag, "none");
        assert_eq!(updated.tags, vec!["client & edit"]);
        assert_eq!(updated.notes, "  <hero> ★  ");
        assert!(patch.ignored_colors);
        let wrong_namespace = document("<bad:Rating xmlns:bad=\"urn:unrelated\">-1</bad:Rating><dt:history><r:Description m:Rating=\"-1\"/></dt:history>");
        assert!(!parse(&wrong_namespace).unwrap().has_metadata());
    }

    #[test]
    fn malformed_unsupported_and_conflicting_properties_reject_the_whole_patch() {
        for properties in [
            "<m:Rating>6</m:Rating>",
            "<m:Rating>-2</m:Rating>",
            "<m:Rating>2.5</m:Rating>",
            "<m:Rating>hello</m:Rating>",
            "<m:Rating>1</m:Rating><m:Rating>2</m:Rating>",
            "<m:Rating>-1</m:Rating><m:Label>Pick</m:Label>",
            "<m:Rating><r:Bag/></m:Rating>",
            "<d:subject>text</d:subject>",
            "<d:description><r:Alt><r:li><r:Description/></r:li></r:Alt></d:description>",
            "<m:Rating>-1",
        ] {
            assert!(parse(&document(properties)).is_err(), "{properties}");
        }
        assert!(parse("<!DOCTYPE x [<!ENTITY v '4'>]><x/>").is_err());
        assert!(parse(&document("<m:Rating>1</m:Rating>").replace(
            "<r:Description ",
            "<r:Description r:about=\"another-image\" "
        ))
        .is_err());
    }

    #[test]
    fn empty_metadata_is_explicit_and_legacy_flags_round_trip() {
        let patch = parse(&document(
            "<d:subject><r:Bag/></d:subject><d:description><r:Alt/></d:description>",
        ))
        .unwrap();
        let existing = metadata(4, "pick");
        let updated = patch.apply(&existing);
        assert!(updated.tags.is_empty());
        assert!(updated.notes.is_empty());
        assert_eq!((updated.rating, updated.flag.as_str()), (4, "pick"));
        assert!(updated.xmp_cull_revision.is_none());
        let catalog = Catalog::new();
        for flag in ["pick", "reject"] {
            let photo = catalog.photo("roundtrip.jpg", 4, flag);
            let updated = parse(&crate::lightroom_xmp(&photo))
                .unwrap()
                .apply(&metadata(0, "none"));
            assert_eq!((updated.rating, updated.flag.as_str()), (4, flag));
        }
    }

    #[test]
    fn persists_culling_and_revision_then_repeat_import_converges_and_sources_are_untouched() {
        let mut catalog = Catalog::new();
        let photo = catalog.photo("mire1.cr2", 0, "none");
        catalog.sidecar("mire1.cr2.xmp", DARKTABLE_FIXTURE);
        let before = fs::read(&photo.file_path).unwrap();
        let first = import(&mut catalog.connection, &[photo.clone()]).unwrap();
        assert_eq!((first.imported_count, first.unchanged_count), (1, 0));
        let saved = first.metadata.get(&photo.id).unwrap();
        assert!(saved.xmp_cull_revision.is_some());
        assert_eq!(saved.tags, vec!["existing"]);
        let second = import(&mut catalog.connection, &[photo.clone()]).unwrap();
        assert_eq!((second.imported_count, second.unchanged_count), (0, 1));
        assert_eq!(second.metadata, first.metadata);
        let reopened = Connection::open(catalog.directory.join("hologram.sql")).unwrap();
        assert_eq!(
            crate::read_photo_metadata(&reopened, &[photo.id.clone()]),
            first.metadata
        );
        assert_eq!(fs::read(&photo.file_path).unwrap(), before);
        assert_eq!(
            fs::read_to_string(catalog.directory.join("mire1.cr2.xmp")).unwrap(),
            DARKTABLE_FIXTURE
        );
    }

    #[test]
    fn a_bad_sidecar_does_not_replace_existing_data_or_abort_other_photos() {
        let mut catalog = Catalog::new();
        let good = catalog.photo("good.cr2", 5, "pick");
        let bad = catalog.photo("bad.cr2", 3, "pick");
        catalog.sidecar("bad.cr2.xmp", &document("<m:Rating>3</m:Rating>"));
        import(&mut catalog.connection, &[bad.clone()]).unwrap();
        let before = existing_metadata(&catalog.connection, &bad).unwrap();
        catalog.sidecar(
            "bad.cr2.xmp",
            &document("<m:Rating>99</m:Rating><d:subject><r:Bag/></d:subject>"),
        );
        catalog.sidecar("good.cr2.xmp", &document("<m:Rating>-1</m:Rating>"));
        let report = import(&mut catalog.connection, &[bad.clone(), good.clone()]).unwrap();
        assert_eq!((report.imported_count, report.error_count), (1, 1));
        assert_eq!(
            existing_metadata(&catalog.connection, &bad).unwrap(),
            before
        );
        let saved = existing_metadata(&catalog.connection, &good).unwrap();
        assert_eq!((saved.rating, saved.flag.as_str()), (0, "reject"));
    }

    #[test]
    fn maps_exact_raw_jpeg_and_unique_stem_sidecars_without_pair_propagation() {
        let mut catalog = Catalog::new();
        let mut raw = catalog.photo("pair.cr2", 0, "none");
        let mut jpeg = catalog.photo("pair.jpg", 0, "none");
        raw.paired_with = Some(jpeg.id.clone());
        jpeg.paired_with = Some(raw.id.clone());
        catalog.sidecar("pair.xmp", &document("<m:Rating>5</m:Rating>"));
        let ambiguous = import(&mut catalog.connection, &[raw.clone()]).unwrap();
        assert_eq!(ambiguous.skipped_count, 1);
        assert!(ambiguous.metadata.is_empty());
        catalog.sidecar("pair.cr2.xmp", &document("<m:Rating>-1</m:Rating>"));
        catalog.sidecar("pair.jpg.XMP", &document("<m:Rating>4</m:Rating>"));
        let report = import(&mut catalog.connection, &[raw.clone(), jpeg.clone()]).unwrap();
        assert_eq!(report.imported_count, 2);
        assert_eq!(report.metadata[&raw.id].flag, "reject");
        assert_eq!(report.metadata[&jpeg.id].flag, "none");
        assert_eq!(report.metadata[&jpeg.id].rating, 4);
        let solo = catalog.photo("solo.nef", 0, "none");
        catalog.sidecar("solo.xmp", &document("<m:Rating>2</m:Rating>"));
        assert_eq!(
            import(&mut catalog.connection, &[solo])
                .unwrap()
                .imported_count,
            1
        );
    }

    #[test]
    fn versioned_sidecars_are_reported_and_cannot_target_a_different_original() {
        let mut catalog = Catalog::new();
        let base = catalog.photo("mire1.cr2", 0, "none");
        catalog.sidecar(
            "mire1_01.cr2.xmp",
            &DARKTABLE_FIXTURE.replace("xmp:Rating=\"0\"", "xmp:Rating=\"-1\""),
        );
        let report = import(&mut catalog.connection, &[base.clone()]).unwrap();
        assert_eq!(report.skipped_count, 2);
        assert!(report.metadata.is_empty());
        let numbered = catalog.photo("mire1_01.cr2", 0, "none");
        let report = import(&mut catalog.connection, &[base.clone(), numbered.clone()]).unwrap();
        assert!(report.metadata.is_empty());
        assert!(report
            .outcomes
            .iter()
            .any(|outcome| outcome.message.contains("different source file")));
        catalog.sidecar("mire1_01.cr2.xmp", &document("<m:Rating>3</m:Rating>"));
        assert!(import(&mut catalog.connection, &[numbered.clone()])
            .unwrap()
            .metadata
            .is_empty());
        catalog.sidecar(
            "mire1_01.cr2.xmp",
            &document("<m:Rating>3</m:Rating><mm:DerivedFrom>mire1_01.cr2</mm:DerivedFrom>"),
        );
        assert_eq!(
            import(&mut catalog.connection, &[numbered])
                .unwrap()
                .imported_count,
            1
        );
    }

    #[test]
    fn database_failure_rolls_back_all_successful_photos() {
        let mut catalog = Catalog::new();
        let first = catalog.photo("first.cr2", 0, "none");
        let last = catalog.photo("last.cr2", 0, "none");
        for photo in [&first, &last] {
            catalog.sidecar(
                &format!("{}.xmp", photo.file_name),
                &document("<m:Rating>-1</m:Rating>"),
            );
        }
        catalog.connection.execute_batch("CREATE TRIGGER fail_last BEFORE INSERT ON photo_metadata WHEN NEW.photo_id='last.cr2' BEGIN SELECT RAISE(FAIL, 'test failure'); END;").unwrap();
        assert!(import(&mut catalog.connection, &[first.clone(), last]).is_err());
        assert!(crate::read_photo_metadata(&catalog.connection, &[first.id]).is_empty());
    }

    #[test]
    fn migrates_existing_catalog_without_losing_decisions() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE photo_metadata (photo_id TEXT PRIMARY KEY, tags TEXT NOT NULL, notes TEXT NOT NULL); INSERT INTO photo_metadata VALUES ('photo','[\"tag\"]','note');").unwrap();
        crate::initialize_metadata_db(&connection).unwrap();
        crate::initialize_metadata_db(&connection).unwrap();
        let values = crate::read_photo_metadata(&connection, &["photo".into()]);
        assert_eq!(values["photo"].tags, vec!["tag"]);
        assert_eq!(values["photo"].notes, "note");
        assert_eq!(values["photo"].rating, 0);
        assert!(values["photo"].xmp_cull_revision.is_none());
    }
    #[test]
    fn manual_cull_changes_clear_import_revision_but_metadata_edits_preserve_it() {
        let mut catalog = Catalog::new();
        let photo = catalog.photo("portrait.cr2", 0, "none");
        catalog.sidecar("portrait.cr2.xmp", &document("<m:Rating>4</m:Rating>"));
        let first = import(&mut catalog.connection, &[photo.clone()]).unwrap();
        let revision = first.metadata[&photo.id].xmp_cull_revision.clone();
        crate::write_photo_metadata(
            &catalog.connection,
            &photo.id,
            &["new tag".into()],
            "new note",
            4,
            "none",
        )
        .unwrap();
        assert_eq!(
            existing_metadata(&catalog.connection, &photo)
                .unwrap()
                .xmp_cull_revision,
            revision
        );
        crate::write_photo_metadata(&catalog.connection, &photo.id, &[], "", 4, "pick").unwrap();
        assert!(existing_metadata(&catalog.connection, &photo)
            .unwrap()
            .xmp_cull_revision
            .is_none());
        let imported = import(&mut catalog.connection, &[photo.clone()]).unwrap();
        assert_eq!(imported.metadata[&photo.id].flag, "none");
        assert_ne!(imported.metadata[&photo.id].xmp_cull_revision, revision);
    }
}
