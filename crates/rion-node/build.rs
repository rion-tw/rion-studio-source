fn main() {
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_ENDPOINT");
    napi_build::setup();
}
