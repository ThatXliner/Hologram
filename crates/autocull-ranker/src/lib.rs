use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
    ptr,
    time::Instant,
};

pub type Result<T> = std::result::Result<T, String>;
type Handle = *mut c_void;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pointwise {
    pub features: Vec<f64>,
    pub target: f64,
    pub weight: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pair {
    pub winner: Vec<f64>,
    pub loser: Vec<f64>,
    pub weight: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema_version: u32,
    pub dimensions: usize,
    pub pointwise: Vec<Pointwise>,
    pub pairs: Vec<Pair>,
    pub predict: Vec<Vec<f64>>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Response {
    pub schema_version: u32,
    pub xgboost_version: String,
    pub ranker_version: String,
    pub scores: Vec<Option<f64>>,
    pub base_margin: f64,
    pub training_rows: usize,
    pub train_ms: f64,
    pub predict_ms: f64,
}

pub const RANKER_VERSION: &str = "xgboost-personal-ranker-v1";
pub const XGBOOST_VERSION: &str = "3.1.1";
#[cfg(target_os = "windows")]
pub const LIBRARY_FILE_NAME: &str = "xgboost.dll";
#[cfg(target_os = "macos")]
pub const LIBRARY_FILE_NAME: &str = "libxgboost.dylib";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const LIBRARY_FILE_NAME: &str = "libxgboost.so";

type Version = unsafe extern "C" fn(*mut c_int, *mut c_int, *mut c_int);
type LastError = unsafe extern "C" fn() -> *const c_char;
type CreateMatrix = unsafe extern "C" fn(*const f32, u64, u64, f32, *mut Handle) -> c_int;
type FreeMatrix = unsafe extern "C" fn(Handle) -> c_int;
type CreateBooster = unsafe extern "C" fn(*const Handle, u64, *mut Handle) -> c_int;
type FreeBooster = unsafe extern "C" fn(Handle) -> c_int;
type SetParam = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int;
type Boost = unsafe extern "C" fn(Handle, Handle, *mut f32, *mut f32, u64) -> c_int;
type Predict =
    unsafe extern "C" fn(Handle, Handle, c_int, u32, c_int, *mut u64, *mut *const f32) -> c_int;

struct Api {
    _library: libloading::Library,
    last_error: LastError,
    create_matrix: CreateMatrix,
    free_matrix: FreeMatrix,
    create_booster: CreateBooster,
    free_booster: FreeBooster,
    set_param: SetParam,
    boost: Boost,
    predict: Predict,
}
impl Api {
    fn load(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err("XGBoost library path must be absolute".into());
        }
        let library = unsafe { libloading::Library::new(path) }
            .map_err(|error| format!("could not load bundled XGBoost: {error}"))?;
        unsafe fn symbol<T: Copy>(library: &libloading::Library, name: &[u8]) -> Result<T> {
            unsafe { library.get::<T>(name) }
                .map(|symbol| *symbol)
                .map_err(|error| format!("unsupported XGBoost C API: {error}"))
        }
        let version: Version = unsafe { symbol(&library, b"XGBoostVersion\0") }?;
        let (mut major, mut minor, mut patch) = (0, 0, 0);
        unsafe { version(&mut major, &mut minor, &mut patch) };
        check_version(&format!("{major}.{minor}.{patch}"))?;
        Ok(Self {
            last_error: unsafe { symbol(&library, b"XGBGetLastError\0") }?,
            create_matrix: unsafe { symbol(&library, b"XGDMatrixCreateFromMat\0") }?,
            free_matrix: unsafe { symbol(&library, b"XGDMatrixFree\0") }?,
            create_booster: unsafe { symbol(&library, b"XGBoosterCreate\0") }?,
            free_booster: unsafe { symbol(&library, b"XGBoosterFree\0") }?,
            set_param: unsafe { symbol(&library, b"XGBoosterSetParam\0") }?,
            boost: unsafe { symbol(&library, b"XGBoosterBoostOneIter\0") }?,
            predict: unsafe { symbol(&library, b"XGBoosterPredict\0") }?,
            _library: library,
        })
    }
    fn checked(&self, code: c_int) -> Result<()> {
        if code == 0 {
            Ok(())
        } else {
            Err(unsafe { CStr::from_ptr((self.last_error)()) }
                .to_string_lossy()
                .into_owned())
        }
    }
}
fn check_version(version: &str) -> Result<()> {
    if version == XGBOOST_VERSION {
        Ok(())
    } else {
        Err(format!(
            "expected XGBoost {XGBOOST_VERSION}, found {version}"
        ))
    }
}
struct Matrix<'a> {
    handle: Handle,
    api: &'a Api,
}
impl<'a> Matrix<'a> {
    fn new(api: &'a Api, rows: &[Vec<f64>], dimensions: usize) -> Result<Self> {
        let values: Vec<f32> = rows.iter().flatten().map(|v| *v as f32).collect();
        let mut handle = ptr::null_mut();
        api.checked(unsafe {
            (api.create_matrix)(
                values.as_ptr(),
                rows.len() as u64,
                dimensions as u64,
                f32::NAN,
                &mut handle,
            )
        })?;
        Ok(Self { handle, api })
    }
}
impl Drop for Matrix<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.api.free_matrix)(self.handle);
        }
    }
}
struct Booster<'a> {
    handle: Handle,
    api: &'a Api,
}
impl<'a> Booster<'a> {
    fn new(train: &Matrix<'a>, base: f64) -> Result<Self> {
        let api = train.api;
        let mut handle = ptr::null_mut();
        api.checked(unsafe { (api.create_booster)(&train.handle, 1, &mut handle) })?;
        let model = Self { handle, api };
        for (name, value) in [
            ("objective", "reg:squarederror".to_owned()),
            ("base_score", base.to_string()),
            ("tree_method", "exact".to_owned()),
            ("device", "cpu".to_owned()),
            ("max_depth", "3".to_owned()),
            ("eta", "0.08".to_owned()),
            ("lambda", "1.2".to_owned()),
            ("min_child_weight", "0.08".to_owned()),
            ("gamma", "0.0008".to_owned()),
            ("max_delta_step", "3".to_owned()),
            ("nthread", "1".to_owned()),
            ("seed", "0".to_owned()),
            ("verbosity", "0".to_owned()),
        ] {
            let name = CString::new(name).unwrap();
            let value = CString::new(value).unwrap();
            api.checked(unsafe { (api.set_param)(model.handle, name.as_ptr(), value.as_ptr()) })?;
        }
        Ok(model)
    }
    fn predict(&self, matrix: &Matrix<'_>, expected: usize, training: bool) -> Result<Vec<f64>> {
        let mut len = 0;
        let mut result = ptr::null();
        self.api.checked(unsafe {
            (self.api.predict)(
                self.handle,
                matrix.handle,
                1,
                0,
                training as c_int,
                &mut len,
                &mut result,
            )
        })?;
        if len as usize != expected || (expected > 0 && result.is_null()) {
            return Err("XGBoost returned unexpected prediction shape".into());
        }
        let values = unsafe { std::slice::from_raw_parts(result, expected) }
            .iter()
            .map(|v| *v as f64)
            .collect::<Vec<_>>();
        if values.iter().any(|v| !v.is_finite()) {
            return Err("XGBoost returned non-finite predictions".into());
        }
        Ok(values)
    }
}
impl Drop for Booster<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.api.free_booster)(self.handle);
        }
    }
}

impl Request {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            return Err("schema_version must be 1".into());
        }
        if !(1..=4096).contains(&self.dimensions) {
            return Err("dimensions must be in 1..=4096".into());
        }
        let rows = self
            .pointwise
            .len()
            .checked_add(self.pairs.len().saturating_mul(2))
            .ok_or("too many rows")?;
        if rows > 100_000
            || self.predict.len() > 100_000
            || (rows + self.predict.len()).saturating_mul(self.dimensions) > 20_000_000
        {
            return Err("request exceeds row or feature-cell limit".into());
        }
        let vector = |v: &[f64]| {
            if v.len() != self.dimensions
                || v.iter().any(|x| !x.is_finite() || !(*x as f32).is_finite())
            {
                Err("feature vectors must have dimensions finite float32 values".to_owned())
            } else {
                Ok(())
            }
        };
        let weight = |w: f64| {
            if !w.is_finite() || w <= 0.0 || w > 100.0 {
                Err("weight must be finite and in (0, 100]".to_owned())
            } else {
                Ok(())
            }
        };
        for row in &self.pointwise {
            vector(&row.features)?;
            weight(row.weight)?;
            if !row.target.is_finite() || !(0.03..=0.97).contains(&row.target) {
                return Err("target must be in [0.03, 0.97]".into());
            }
        }
        for row in &self.pairs {
            vector(&row.winner)?;
            vector(&row.loser)?;
            weight(row.weight)?;
        }
        for row in &self.predict {
            vector(row)?;
        }
        Ok(())
    }
    fn base_margin(&self) -> f64 {
        let weight: f64 = self.pointwise.iter().map(|r| r.weight).sum();
        let mean = if weight > f64::EPSILON {
            self.pointwise
                .iter()
                .map(|r| r.target * r.weight)
                .sum::<f64>()
                / weight
        } else {
            0.5
        };
        let p = mean.clamp(0.02, 0.98);
        (p / (1.0 - p)).ln()
    }
    fn gradients(&self, margins: &[f64]) -> (Vec<f32>, Vec<f32>) {
        let mut grad = vec![0.0; margins.len()];
        let mut hess = vec![0.0; margins.len()];
        for (i, row) in self.pointwise.iter().enumerate() {
            let p = sigmoid(margins[i]);
            grad[i] = ((p - row.target) * row.weight) as f32;
            hess[i] = (p * (1.0 - p) * row.weight).max(0.0001) as f32;
        }
        for (i, pair) in self.pairs.iter().enumerate() {
            let winner = self.pointwise.len() + i * 2;
            let loser = winner + 1;
            let p = sigmoid(margins[winner] - margins[loser]);
            let g = ((1.0 - p) * pair.weight) as f32;
            let h = (p * (1.0 - p) * pair.weight).max(0.0001) as f32;
            grad[winner] -= g;
            grad[loser] += g;
            hess[winner] += h;
            hess[loser] += h;
        }
        (grad, hess)
    }
}
fn sigmoid(value: f64) -> f64 {
    1.0 / (1.0 + (-value.clamp(-40.0, 40.0)).exp())
}
pub fn evaluate(request: Request, library_path: &Path) -> Result<Response> {
    request.validate()?;
    let api = Api::load(library_path)?;
    let xgboost_version = XGBOOST_VERSION.to_owned();
    let base_margin = request.base_margin();
    let training_rows = request.pointwise.len() + request.pairs.len() * 2;
    let mut response = Response {
        schema_version: 1,
        xgboost_version,
        ranker_version: RANKER_VERSION.to_owned(),
        scores: vec![None; request.predict.len()],
        base_margin,
        training_rows,
        train_ms: 0.0,
        predict_ms: 0.0,
    };
    if training_rows == 0 {
        return Ok(response);
    }
    let start = Instant::now();
    let rows: Vec<Vec<f64>> = request
        .pointwise
        .iter()
        .map(|r| r.features.clone())
        .chain(
            request
                .pairs
                .iter()
                .flat_map(|p| [p.winner.clone(), p.loser.clone()]),
        )
        .collect();
    let train = Matrix::new(&api, &rows, request.dimensions)?;
    let booster = Booster::new(&train, base_margin)?;
    for _ in 0..48 {
        let margins = booster.predict(&train, training_rows, true)?;
        let (mut grad, mut hess) = request.gradients(&margins);
        api.checked(unsafe {
            (api.boost)(
                booster.handle,
                train.handle,
                grad.as_mut_ptr(),
                hess.as_mut_ptr(),
                training_rows as u64,
            )
        })?;
    }
    response.train_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    if !request.predict.is_empty() {
        let predict = Matrix::new(&api, &request.predict, request.dimensions)?;
        response.scores = booster
            .predict(&predict, request.predict.len(), false)?
            .iter()
            .map(|raw| Some(sigmoid(raw - base_margin)))
            .collect();
    }
    response.predict_ms = start.elapsed().as_secs_f64() * 1000.0;
    Ok(response)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(value: serde_json::Value) -> Request {
        serde_json::from_value(value).unwrap()
    }
    fn evaluate_native(request: Request) -> Result<Response> {
        let directory =
            std::env::var_os("XGBOOST_LIB_DIR").expect("set XGBOOST_LIB_DIR for native tests");
        evaluate(
            request,
            &std::path::PathBuf::from(directory).join(LIBRARY_FILE_NAME),
        )
    }
    fn empty() -> Request {
        request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[],"pairs":[],"predict":[[0,1]]}),
        )
    }
    #[test]
    fn rejects_invalid_vectors_and_weights() {
        let mut r = empty();
        r.predict[0].push(1.0);
        assert!(r.validate().is_err());
        let mut r = empty();
        r.predict[0][0] = f64::INFINITY;
        assert!(r.validate().is_err());
        let mut r = empty();
        r.pointwise.push(Pointwise {
            features: vec![0.0, 1.0],
            target: 0.97,
            weight: 0.0,
        });
        assert!(r.validate().is_err());
        r.pointwise[0].weight = 1.0;
        r.pointwise[0].target = 1.0;
        assert!(r.validate().is_err());
    }
    #[test]
    fn empty_feedback_has_null_scores() {
        assert_eq!(evaluate_native(empty()).unwrap().scores, vec![None]);
    }
    #[test]
    fn pair_only_ranks_winner_and_preserves_unrelated_dimension() {
        let r = request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[],"pairs":[{"winner":[1,0],"loser":[0,0],"weight":1}],"predict":[[1,0],[0,0],[1,42]]}),
        );
        let result = evaluate_native(r).unwrap();
        assert_eq!(result.base_margin, 0.0);
        assert!(result.scores[0].unwrap() > result.scores[1].unwrap());
        assert_eq!(result.scores[0], result.scores[2]);
    }
    #[test]
    fn one_sided_identical_feedback_is_centered() {
        let r = request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[{"features":[1,0],"target":0.97,"weight":1}],"pairs":[],"predict":[[0,0],[1,0],[2,42]]}),
        );
        for score in evaluate_native(r).unwrap().scores {
            assert!((score.unwrap() - 0.5).abs() < 1e-6);
        }
    }
    #[test]
    fn missing_library_is_an_error_even_without_training_rows() {
        let path = std::env::temp_dir()
            .join("hologram-missing-native-ranker")
            .join(LIBRARY_FILE_NAME);
        let error = evaluate(empty(), &path).unwrap_err();
        assert!(error.contains("could not load bundled XGBoost"));
        let error = evaluate(empty(), Path::new(LIBRARY_FILE_NAME)).unwrap_err();
        assert_eq!(error, "XGBoost library path must be absolute");
    }
    #[test]
    fn rejects_unpinned_native_version() {
        assert!(check_version("3.1.1").is_ok());
        for version in ["3.1.0", "3.1.10", "3.2.0", "4.0.0"] {
            assert_eq!(
                check_version(version).unwrap_err(),
                format!("expected XGBoost 3.1.1, found {version}")
            );
        }
    }
    #[test]
    fn request_bounds_fail_before_loading_native_code() {
        let mut r = empty();
        r.schema_version = 2;
        assert_eq!(r.validate().unwrap_err(), "schema_version must be 1");
        r.schema_version = 1;
        r.dimensions = 4097;
        assert_eq!(r.validate().unwrap_err(), "dimensions must be in 1..=4096");
        r.dimensions = 2;
        r.pointwise = vec![
            Pointwise {
                features: vec![],
                target: 0.5,
                weight: 1.0
            };
            100_001
        ];
        assert_eq!(
            r.validate().unwrap_err(),
            "request exceeds row or feature-cell limit"
        );
    }
    #[test]
    fn mixed_evidence_is_repeatable_across_library_and_handle_cleanup() {
        let r = request(serde_json::json!({"schema_version":1,"dimensions":2,
            "pointwise":[{"features":[0,0],"target":0.03,"weight":1},{"features":[1,0],"target":0.97,"weight":1}],
            "pairs":[{"winner":[1,0],"loser":[0,0],"weight":0.9}],"predict":[[0,0],[1,0]]}));
        let first = evaluate_native(r.clone()).unwrap();
        assert_eq!(first.training_rows, 4);
        assert_eq!(first.ranker_version, RANKER_VERSION);
        assert!(first.scores[0].unwrap() < 0.5);
        assert!(first.scores[1].unwrap() > 0.5);
        for _ in 0..12 {
            assert_eq!(evaluate_native(r.clone()).unwrap().scores, first.scores);
        }
    }
    #[test]
    fn opposite_pairs_cancel_without_absolute_labels() {
        let r = request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[],
            "pairs":[{"winner":[1,0],"loser":[0,0],"weight":0.9},{"winner":[0,0],"loser":[1,0],"weight":0.9}],"predict":[[0,0],[1,0]]}),
        );
        let scores = evaluate_native(r).unwrap().scores;
        assert_eq!(scores, vec![Some(0.5), Some(0.5)]);
    }
}
