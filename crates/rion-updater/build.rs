fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    // Windows Installer Detection classifies any image whose file name contains
    // "updater" as a legacy installer and refuses to start it without elevation,
    // so this crate's test harness dies with os error 740 on a normal UAC
    // desktop while CI runners, which never prompt, run it. Declaring the
    // execution level the harness actually wants opts the image out of that
    // heuristic. The crate ships no executable of its own.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTUAC:level='asInvoker' uiAccess='false'");
}
