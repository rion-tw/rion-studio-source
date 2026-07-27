use serde::{Deserialize, Serialize};

use crate::Platform;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemWebViewProbe {
    pub platform: Platform,
    pub engine: String,
    pub available: bool,
    pub runtime_version: Option<String>,
    pub public_api_available: bool,
    pub macro_input_available: bool,
    pub audio_mute_available: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Default, Eq, PartialEq)]
struct RawSystemWebViewProbe {
    runtime_version: Option<String>,
    public_api_available: bool,
    macro_input_available: bool,
    audio_mute_available: bool,
    reason_codes: Vec<String>,
}

pub fn probe_system_webview(platform: Platform) -> SystemWebViewProbe {
    match platform {
        Platform::Macos => classify_probe(platform, probe_macos()),
        Platform::Windows => classify_probe(platform, probe_windows()),
    }
}

fn classify_probe(platform: Platform, mut raw: RawSystemWebViewProbe) -> SystemWebViewProbe {
    if !raw.public_api_available {
        raw.reason_codes.push("public-api-unavailable".to_owned());
    }
    if !raw.macro_input_available {
        raw.reason_codes.push("macro-input-unavailable".to_owned());
    }
    if !raw.audio_mute_available {
        raw.reason_codes.push("audio-mute-unavailable".to_owned());
    }
    raw.reason_codes.sort();
    raw.reason_codes.dedup();
    SystemWebViewProbe {
        platform,
        engine: match platform {
            Platform::Macos => "wkwebview",
            Platform::Windows => "webview2",
        }
        .to_owned(),
        // Runtime creation can begin with public APIs present. The core separately
        // checks per-workspace native capability requirements before enabling System.
        available: raw.public_api_available,
        runtime_version: raw.runtime_version,
        public_api_available: raw.public_api_available,
        macro_input_available: raw.macro_input_available,
        audio_mute_available: raw.audio_mute_available,
        reason_codes: raw.reason_codes,
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_macro_input_available(runtime_version: Option<&str>, public_api_available: bool) -> bool {
    public_api_available
        && runtime_version
            .and_then(|version| version.split('.').next())
            .and_then(|major| major.parse::<u64>().ok())
            .is_some_and(|major| major >= 14)
}

#[cfg(target_os = "macos")]
fn probe_macos() -> RawSystemWebViewProbe {
    use std::{ffi::CString, os::raw::c_char};

    type ObjcClass = *mut core::ffi::c_void;
    type ObjcSelector = *mut core::ffi::c_void;

    #[link(name = "WebKit", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> ObjcClass;
        fn sel_registerName(name: *const c_char) -> ObjcSelector;
        fn class_getInstanceMethod(
            class: ObjcClass,
            selector: ObjcSelector,
        ) -> *mut core::ffi::c_void;
    }

    fn class(name: &str) -> ObjcClass {
        let name = CString::new(name).expect("static Objective-C class name");
        // SAFETY: The name is NUL terminated and the Objective-C runtime owns the
        // returned class pointer for the process lifetime.
        unsafe { objc_getClass(name.as_ptr()) }
    }

    fn has_instance_selector(class: ObjcClass, selector: &str) -> bool {
        if class.is_null() {
            return false;
        }
        let selector = CString::new(selector).expect("static Objective-C selector");
        // SAFETY: Both pointers come from the Objective-C runtime and are used for
        // read-only method lookup. No selector is invoked by this capability probe.
        unsafe {
            let selector = sel_registerName(selector.as_ptr());
            !class_getInstanceMethod(class, selector).is_null()
        }
    }

    let webview = class("WKWebView");
    let data_store = class("WKWebsiteDataStore");
    let runtime_version = sysinfo::System::os_version();
    let public_api_available = !webview.is_null() && !data_store.is_null();
    let audio_mute_available = has_instance_selector(webview, "_setPageMuted:");
    RawSystemWebViewProbe {
        macro_input_available: macos_macro_input_available(
            runtime_version.as_deref(),
            public_api_available,
        ),
        runtime_version,
        public_api_available,
        audio_mute_available,
        reason_codes: Vec::new(),
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_macos() -> RawSystemWebViewProbe {
    RawSystemWebViewProbe {
        reason_codes: vec!["host-platform-mismatch".to_owned()],
        ..RawSystemWebViewProbe::default()
    }
}

#[cfg(windows)]
fn probe_windows() -> RawSystemWebViewProbe {
    use std::{ffi::CString, os::windows::ffi::OsStrExt, ptr};

    type ModuleHandle = *mut core::ffi::c_void;
    type GetAvailableVersion = unsafe extern "system" fn(*const u16, *mut *mut u16) -> i32;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> ModuleHandle;
        fn GetProcAddress(module: ModuleHandle, name: *const u8) -> *mut core::ffi::c_void;
        fn FreeLibrary(module: ModuleHandle) -> i32;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(value: *const core::ffi::c_void);
    }

    let library_name = std::ffi::OsStr::new("WebView2Loader.dll")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: library_name is NUL terminated. The handle is released below.
    let module = unsafe { LoadLibraryW(library_name.as_ptr()) };
    if module.is_null() {
        return RawSystemWebViewProbe {
            reason_codes: vec!["webview2-loader-unavailable".to_owned()],
            ..RawSystemWebViewProbe::default()
        };
    }
    let symbol = CString::new("GetAvailableCoreWebView2BrowserVersionString")
        .expect("static WebView2 symbol");
    // SAFETY: module is a valid loaded library and symbol is NUL terminated.
    let procedure = unsafe { GetProcAddress(module, symbol.as_ptr().cast()) };
    if procedure.is_null() {
        // SAFETY: module came from LoadLibraryW.
        unsafe { FreeLibrary(module) };
        return RawSystemWebViewProbe {
            reason_codes: vec!["webview2-version-api-unavailable".to_owned()],
            ..RawSystemWebViewProbe::default()
        };
    }
    // SAFETY: The symbol name is defined by the WebView2 loader ABI.
    let get_version: GetAvailableVersion = unsafe { core::mem::transmute(procedure) };
    let mut version = ptr::null_mut();
    // SAFETY: A null browser folder requests the installed Evergreen runtime and
    // version points to an out parameter released with CoTaskMemFree.
    let result = unsafe { get_version(ptr::null(), &mut version) };
    let runtime_version = if result >= 0 && !version.is_null() {
        let mut length = 0;
        // SAFETY: Successful WebView2 calls return a NUL-terminated UTF-16 string.
        unsafe {
            while *version.add(length) != 0 {
                length += 1;
            }
        }
        // SAFETY: length was measured within the NUL-terminated allocation.
        let value =
            String::from_utf16_lossy(unsafe { core::slice::from_raw_parts(version, length) });
        // SAFETY: WebView2 documents this allocation as CoTaskMem-owned.
        unsafe { CoTaskMemFree(version.cast()) };
        Some(value)
    } else {
        None
    };
    // SAFETY: module came from LoadLibraryW and no function pointer escapes.
    unsafe { FreeLibrary(module) };
    let runtime_available = runtime_version.is_some();
    RawSystemWebViewProbe {
        public_api_available: runtime_available,
        macro_input_available: runtime_available,
        runtime_version,
        audio_mute_available: runtime_available,
        reason_codes: (!runtime_available)
            .then(|| "webview2-runtime-unavailable".to_owned())
            .into_iter()
            .collect(),
    }
}

#[cfg(not(windows))]
fn probe_windows() -> RawSystemWebViewProbe {
    RawSystemWebViewProbe {
        reason_codes: vec!["host-platform-mismatch".to_owned()],
        ..RawSystemWebViewProbe::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_macos_and_windows_without_inheriting_the_test_host_platform() {
        for (platform, engine) in [
            (Platform::Macos, "wkwebview"),
            (Platform::Windows, "webview2"),
        ] {
            let probe = classify_probe(
                platform,
                RawSystemWebViewProbe {
                    runtime_version: Some("fixture".to_owned()),
                    public_api_available: true,
                    macro_input_available: true,
                    audio_mute_available: true,
                    reason_codes: Vec::new(),
                },
            );
            assert_eq!(probe.platform, platform);
            assert_eq!(probe.engine, engine);
            assert!(probe.available);
            assert!(probe.reason_codes.is_empty());
        }
    }

    #[test]
    fn reports_public_api_macro_input_and_audio_gaps_independently() {
        let probe = classify_probe(
            Platform::Macos,
            RawSystemWebViewProbe {
                audio_mute_available: false,
                ..RawSystemWebViewProbe::default()
            },
        );
        assert!(!probe.available);
        assert!(
            probe
                .reason_codes
                .contains(&"public-api-unavailable".to_owned())
        );
        assert!(
            probe
                .reason_codes
                .contains(&"macro-input-unavailable".to_owned())
        );
        assert!(
            probe
                .reason_codes
                .contains(&"audio-mute-unavailable".to_owned())
        );
    }

    #[test]
    fn classifies_macos_macro_input_from_the_supported_os_floor_and_public_apis() {
        for (version, public_api_available, expected) in [
            (Some("13.6"), true, false),
            (Some("14.0"), true, true),
            (Some("15.4.1"), true, true),
            (Some("14.0"), false, false),
            (Some("invalid"), true, false),
            (None, true, false),
        ] {
            assert_eq!(
                macos_macro_input_available(version, public_api_available),
                expected,
                "version={version:?}, public_api_available={public_api_available}"
            );
        }
    }

    #[test]
    fn classifies_windows_webview2_available_missing_and_damaged_scenarios() {
        let available = classify_probe(
            Platform::Windows,
            RawSystemWebViewProbe {
                runtime_version: Some("fixture".to_owned()),
                public_api_available: true,
                macro_input_available: true,
                audio_mute_available: true,
                ..RawSystemWebViewProbe::default()
            },
        );
        assert!(available.available);

        for reason in [
            "webview2-loader-unavailable",
            "webview2-version-api-unavailable",
            "webview2-runtime-unavailable",
        ] {
            let unavailable = classify_probe(
                Platform::Windows,
                RawSystemWebViewProbe {
                    reason_codes: vec![reason.to_owned()],
                    ..RawSystemWebViewProbe::default()
                },
            );
            assert!(!unavailable.available);
            assert!(unavailable.reason_codes.contains(&reason.to_owned()));
        }
    }
}
