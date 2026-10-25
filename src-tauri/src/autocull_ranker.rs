use hologram_autocull_ranker::{evaluate, Request, Response, LIBRARY_FILE_NAME};
use tauri::Manager;

static NATIVE_RANKING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const MAX_NATIVE_FEATURE_CELLS: usize = 4_000_000;

fn validate_native_size(request: &Request) -> Result<(), String> {
    if request.dimensions != 267 {
        return Err("AutoCull requires 267 ranking features".into());
    }
    let rows = request
        .pointwise
        .len()
        .saturating_add(request.pairs.len().saturating_mul(2))
        .saturating_add(request.predict.len());
    if rows.saturating_mul(request.dimensions) > MAX_NATIVE_FEATURE_CELLS {
        return Err(
            "Native analysis is too large. Use the built-in learner or analyze a smaller folder."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn score_autocull_native(
    request: Request,
    app: tauri::AppHandle,
) -> Result<Response, String> {
    request.validate()?;
    validate_native_size(&request)?;
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources/xgboost")
        .join(LIBRARY_FILE_NAME);
    let permit = NATIVE_RANKING.try_acquire().map_err(|_| {
        "Native analysis is busy. Retry after the previous analysis finishes.".to_string()
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        evaluate(request, &path)
    })
    .await
    .map_err(|error| format!("native AutoCull task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use hologram_autocull_ranker::Pair;

    fn request(rows: usize) -> Request {
        Request {
            schema_version: 1,
            dimensions: 267,
            pointwise: vec![],
            pairs: vec![],
            predict: vec![vec![]; rows],
        }
    }

    #[test]
    fn limits_combined_training_and_prediction_cells() {
        let mut request = request(MAX_NATIVE_FEATURE_CELLS / 267);
        assert!(validate_native_size(&request).is_ok());
        request.pairs.push(Pair {
            winner: vec![],
            loser: vec![],
            weight: 1.0,
        });
        assert!(validate_native_size(&request)
            .unwrap_err()
            .contains("smaller folder"));
    }

    #[test]
    fn rejects_other_feature_schemas() {
        let mut request = request(0);
        request.dimensions = 266;
        assert!(validate_native_size(&request).unwrap_err().contains("267"));
    }
}
