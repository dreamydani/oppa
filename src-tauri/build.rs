fn main() {
    tauri_build::build();
    // WHY /IGNORE:4098 (MSVC only): cc-compiled C deps (quickjs via
    // rquickjs-sys, which sets no static_crt) default to dynamic CRT
    // (/MD → MSVCRT) while rustc links static CRT (/MT → LIBCMT); the
    // prebuilt sherpa libs already ship -MT. No CRT objects cross the
    // boundary, so the mix is benign — silence it so real linker
    // diagnostics stay visible. Full purity would be workspace-wide
    // -crt-static plus VC-redist bundling in the installer.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/IGNORE:4098");
    }
}
