use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, Runtime};

fn root() -> Result<PathBuf, String> {
    let path = std::env::var_os("HOLOGRAM_AUTOCULL_SMOKE_DIR")
        .map(PathBuf::from)
        .ok_or("HOLOGRAM_AUTOCULL_SMOKE_DIR is required for the smoke build")?;
    if !path.is_absolute() || !path.is_dir() {
        return Err("smoke directory must be an existing absolute directory".into());
    }
    Ok(path)
}

pub fn configure(context: &mut tauri::Context<tauri::Wry>) -> Result<(), String> {
    root()?;
    let identifier = uuid::Uuid::new_v4();
    context.config_mut().identifier = format!("dev.thatxliner.hologram.smoke.{identifier}");
    for window in &mut context.config_mut().app.windows {
        window.create = false;
        window.width = 1440.0;
        window.height = 1000.0;
    }
    Ok(())
}

pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), String> {
    let root = root()?;
    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("smoke window config missing")?
        .clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .data_directory(root.join("webview"))
        .data_store_identifier(*uuid::Uuid::new_v4().as_bytes())
        .title("Hologram native AutoCull verification")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn on_page_load<R: Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() == tauri::webview::PageLoadEvent::Finished {
        if let Err(error) = webview.eval(include_str!("../../scripts/native-autocull-smoke.js")) {
            eprintln!("native smoke injection failed: {error}");
            webview.app_handle().exit(1);
        }
    }
}

#[derive(Serialize)]
pub struct SmokeFixture {
    folder: String,
    other_folder: String,
    portrait: String,
}

#[tauri::command]
pub fn autocull_smoke_fixture() -> Result<SmokeFixture, String> {
    let root = root()?;
    let folder = root.join("shoot-a");
    let other = root.join("shoot-b");
    let portrait = include_bytes!("../../scripts/fixtures/stock/portrait.jpg");
    for path in [&folder, &other] {
        std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
        for name in ["original", "duplicate", "blurred", "black", "white"] {
            std::fs::write(path.join(format!("{name}.jpg")), portrait)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(SmokeFixture {
        folder: folder.to_string_lossy().into_owned(),
        other_folder: other.to_string_lossy().into_owned(),
        portrait: base64::engine::general_purpose::STANDARD.encode(portrait),
    })
}

#[tauri::command]
pub fn report_autocull_smoke(
    app: tauri::AppHandle,
    result: serde_json::Value,
) -> Result<(), String> {
    let success = result.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
    let output = serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?;
    std::fs::write(root()?.join("report.json"), output).map_err(|e| e.to_string())?;
    app.exit(if success { 0 } else { 1 });
    Ok(())
}
