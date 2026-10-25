use hologram_autocull_ranker::{evaluate, Request, Response, LIBRARY_FILE_NAME};
use tauri::Manager;

static NATIVE_RANKING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[tauri::command]
pub async fn score_autocull_native(
    request: Request,
    app: tauri::AppHandle,
) -> Result<Response, String> {
    request.validate()?;
    if request.dimensions != 267 {
        return Err("AutoCull requires 267 ranking features".into());
    }
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources/xgboost")
        .join(LIBRARY_FILE_NAME);
    let permit = NATIVE_RANKING
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        evaluate(request, &path)
    })
    .await
    .map_err(|error| format!("native AutoCull task failed: {error}"))?
}
