fn main() {
    // The ScreenCaptureKit crate (system-audio visualizer) links a Swift bridge,
    // so the binary references @rpath/libswiftCore.dylib etc. A dependency's
    // rustc-link-arg doesn't reach the final binary, so bake the Swift runtime
    // rpath in here. macOS 12+ ships these in the dyld shared cache under
    // /usr/lib/swift, so no Xcode is needed at runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}
