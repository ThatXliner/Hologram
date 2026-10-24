fn main() {
    println!("cargo:rerun-if-env-changed=XGBOOST_LIB_DIR");
    let path = std::env::var("XGBOOST_LIB_DIR")
        .expect("set XGBOOST_LIB_DIR to the XGBoost 3.1.1 library directory");
    println!("cargo:rustc-link-search=native={path}");
    println!("cargo:rustc-link-lib=dylib=xgboost");
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("unix") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{path}");
    }
}
