use hologram_autocull_ranker::{evaluate, Request, LIBRARY_FILE_NAME};
use std::{
    io::{self, Read},
    path::PathBuf,
};

fn run() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(64 * 1024 * 1024 + 1)
        .read_to_string(&mut input)
        .map_err(|error| error.to_string())?;
    if input.len() > 64 * 1024 * 1024 {
        return Err("JSON request exceeds 64 MiB".into());
    }
    let request: Request =
        serde_json::from_str(&input).map_err(|error| format!("invalid request JSON: {error}"))?;
    let directory = std::env::var_os("XGBOOST_LIB_DIR")
        .ok_or("set XGBOOST_LIB_DIR to the pinned XGBoost library directory")?;
    let path = PathBuf::from(directory)
        .join(LIBRARY_FILE_NAME)
        .canonicalize()
        .map_err(|error| format!("could not resolve XGBoost library: {error}"))?;
    let response = evaluate(request, &path)?;
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
