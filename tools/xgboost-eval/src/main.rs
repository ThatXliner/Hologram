use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    io::{self, Read},
    ptr,
    time::Instant,
};

type Result<T> = std::result::Result<T, String>;
type Handle = *mut c_void;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointwise {
    features: Vec<f64>,
    target: f64,
    weight: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    winner: Vec<f64>,
    loser: Vec<f64>,
    weight: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u32,
    dimensions: usize,
    pointwise: Vec<Pointwise>,
    pairs: Vec<Pair>,
    predict: Vec<Vec<f64>>,
}
#[derive(Serialize)]
struct Response {
    schema_version: u32,
    xgboost_version: String,
    scores: Vec<Option<f64>>,
    base_margin: f64,
    training_rows: usize,
    train_ms: f64,
    predict_ms: f64,
}

extern "C" {
    fn XGBoostVersion(major: *mut c_int, minor: *mut c_int, patch: *mut c_int);
    fn XGBGetLastError() -> *const c_char;
    fn XGDMatrixCreateFromMat(
        data: *const f32,
        nrow: u64,
        ncol: u64,
        missing: f32,
        out: *mut Handle,
    ) -> c_int;
    fn XGDMatrixFree(handle: Handle) -> c_int;
    fn XGBoosterCreate(dmats: *const Handle, len: u64, out: *mut Handle) -> c_int;
    fn XGBoosterFree(handle: Handle) -> c_int;
    fn XGBoosterSetParam(handle: Handle, name: *const c_char, value: *const c_char) -> c_int;
    fn XGBoosterBoostOneIter(
        handle: Handle,
        train: Handle,
        grad: *mut f32,
        hess: *mut f32,
        len: u64,
    ) -> c_int;
    fn XGBoosterPredict(
        handle: Handle,
        data: Handle,
        mask: c_int,
        limit: u32,
        training: c_int,
        len: *mut u64,
        result: *mut *const f32,
    ) -> c_int;
}

fn checked(code: c_int) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(XGBGetLastError()) }
            .to_string_lossy()
            .into_owned())
    }
}
struct Matrix(Handle);
impl Matrix {
    fn new(rows: &[Vec<f64>], dimensions: usize) -> Result<Self> {
        let values: Vec<f32> = rows.iter().flatten().map(|v| *v as f32).collect();
        let mut handle = ptr::null_mut();
        checked(unsafe {
            XGDMatrixCreateFromMat(
                values.as_ptr(),
                rows.len() as u64,
                dimensions as u64,
                f32::NAN,
                &mut handle,
            )
        })?;
        Ok(Self(handle))
    }
}
impl Drop for Matrix {
    fn drop(&mut self) {
        unsafe {
            XGDMatrixFree(self.0);
        }
    }
}
struct Booster(Handle);
impl Booster {
    fn new(train: &Matrix, base: f64) -> Result<Self> {
        let mut handle = ptr::null_mut();
        checked(unsafe { XGBoosterCreate(&train.0, 1, &mut handle) })?;
        let model = Self(handle);
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
            checked(unsafe { XGBoosterSetParam(model.0, name.as_ptr(), value.as_ptr()) })?;
        }
        Ok(model)
    }
    fn predict(&self, matrix: &Matrix, expected: usize, training: bool) -> Result<Vec<f64>> {
        let mut len = 0;
        let mut result = ptr::null();
        checked(unsafe {
            XGBoosterPredict(
                self.0,
                matrix.0,
                1,
                0,
                training as c_int,
                &mut len,
                &mut result,
            )
        })?;
        if len as usize != expected {
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
impl Drop for Booster {
    fn drop(&mut self) {
        unsafe {
            XGBoosterFree(self.0);
        }
    }
}

impl Request {
    fn validate(&self) -> Result<()> {
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
fn version() -> String {
    let (mut major, mut minor, mut patch) = (0, 0, 0);
    unsafe {
        XGBoostVersion(&mut major, &mut minor, &mut patch);
    }
    format!("{major}.{minor}.{patch}")
}
fn evaluate(request: Request) -> Result<Response> {
    request.validate()?;
    let xgboost_version = version();
    if xgboost_version != "3.1.1" {
        return Err(format!("expected XGBoost 3.1.1, found {xgboost_version}"));
    }
    let base_margin = request.base_margin();
    let training_rows = request.pointwise.len() + request.pairs.len() * 2;
    let mut response = Response {
        schema_version: 1,
        xgboost_version,
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
    let train = Matrix::new(&rows, request.dimensions)?;
    let booster = Booster::new(&train, base_margin)?;
    for _ in 0..48 {
        let margins = booster.predict(&train, training_rows, true)?;
        let (mut grad, mut hess) = request.gradients(&margins);
        checked(unsafe {
            XGBoosterBoostOneIter(
                booster.0,
                train.0,
                grad.as_mut_ptr(),
                hess.as_mut_ptr(),
                training_rows as u64,
            )
        })?;
    }
    response.train_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    if !request.predict.is_empty() {
        let predict = Matrix::new(&request.predict, request.dimensions)?;
        response.scores = booster
            .predict(&predict, request.predict.len(), false)?
            .iter()
            .map(|raw| Some(sigmoid(raw - base_margin)))
            .collect();
    }
    response.predict_ms = start.elapsed().as_secs_f64() * 1000.0;
    Ok(response)
}
fn run() -> Result<()> {
    let mut input = String::new();
    io::stdin()
        .take(64 * 1024 * 1024 + 1)
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > 64 * 1024 * 1024 {
        return Err("JSON request exceeds 64 MiB".into());
    }
    let request = serde_json::from_str(&input).map_err(|e| format!("invalid request JSON: {e}"))?;
    let response = evaluate(request)?;
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(value: serde_json::Value) -> Request {
        serde_json::from_value(value).unwrap()
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
        assert_eq!(evaluate(empty()).unwrap().scores, vec![None]);
    }
    #[test]
    fn pair_only_ranks_winner_and_preserves_unrelated_dimension() {
        let r = request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[],"pairs":[{"winner":[1,0],"loser":[0,0],"weight":1}],"predict":[[1,0],[0,0],[1,42]]}),
        );
        let result = evaluate(r).unwrap();
        assert_eq!(result.base_margin, 0.0);
        assert!(result.scores[0].unwrap() > result.scores[1].unwrap());
        assert_eq!(result.scores[0], result.scores[2]);
    }
    #[test]
    fn one_sided_identical_feedback_is_centered() {
        let r = request(
            serde_json::json!({"schema_version":1,"dimensions":2,"pointwise":[{"features":[1,0],"target":0.97,"weight":1}],"pairs":[],"predict":[[0,0],[1,0],[2,42]]}),
        );
        for score in evaluate(r).unwrap().scores {
            assert!((score.unwrap() - 0.5).abs() < 1e-6);
        }
    }
}
