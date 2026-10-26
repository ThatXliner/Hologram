use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

#[derive(Deserialize)]
struct DecisionBookHeader {
    schema_version: u32,
    kind: String,
}

fn write_decision_book(path: &Path, contents: &str) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Save the decision book as a .json file".into());
    }
    let header: DecisionBookHeader =
        serde_json::from_str(contents).map_err(|_| "Invalid decision book JSON".to_string())?;
    if header.schema_version != 1 || header.kind != "hologram-decision-book" {
        return Err("Unsupported decision book format".into());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".hologram-decision-book-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save decision book: {error}"))
}

#[tauri::command]
pub async fn save_decision_book(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_decision_book(Path::new(&path), &contents))
        .await
        .map_err(|error| format!("Decision book save failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(std::path::PathBuf);

    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("hologram-decision-book-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const BOOK: &str = r#"{"schema_version":1,"kind":"hologram-decision-book","datasets":[]}"#;

    #[test]
    fn saves_the_generated_book_without_changing_its_contents() {
        let directory = Directory::new();
        let path = directory.0.join("review.JSON");
        write_decision_book(&path, BOOK).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), BOOK);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn invalid_exports_leave_existing_files_untouched() {
        let directory = Directory::new();
        let photo = directory.0.join("original.jpg");
        fs::write(&photo, "original").unwrap();
        assert!(write_decision_book(&photo, BOOK).is_err());
        assert_eq!(fs::read_to_string(photo).unwrap(), "original");
        let path = directory.0.join("review.json");
        fs::write(&path, "previous book").unwrap();
        for contents in [
            "not JSON",
            r#"{"schema_version":2,"kind":"hologram-decision-book"}"#,
        ] {
            assert!(write_decision_book(&path, contents).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "previous book");
        }
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn replacing_a_linked_export_does_not_modify_the_original() {
        let directory = Directory::new();
        let original = directory.0.join("original.jpg");
        let export = directory.0.join("review.json");
        fs::write(&original, "original").unwrap();
        fs::hard_link(&original, &export).unwrap();
        write_decision_book(&export, BOOK).unwrap();
        assert_eq!(fs::read_to_string(original).unwrap(), "original");
        assert_eq!(fs::read_to_string(export).unwrap(), BOOK);
    }
}
