use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn run(input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hologram-xgboost-eval"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn json_stdout_contains_centered_pair_scores() {
    let output = run(
        r#"{"schema_version":1,"dimensions":1,"pointwise":[],"pairs":[{"winner":[1],"loser":[0],"weight":1}],"predict":[[1],[0]]}"#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["xgboost_version"], "3.1.1");
    assert!(response["scores"][0].as_f64().unwrap() > 0.5);
    assert!(response["scores"][1].as_f64().unwrap() < 0.5);
    for field in ["train_ms", "predict_ms"] {
        assert!(response[field].as_f64().unwrap() >= 0.0);
    }
}

#[test]
fn malformed_input_exits_with_stderr_only() {
    for input in [
        "not JSON",
        r#"{"schema_version":1,"dimensions":1,"pointwise":[],"pairs":[],"predict":[[0,1]]}"#,
    ] {
        let output = run(input);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}
