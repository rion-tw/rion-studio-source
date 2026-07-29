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

#[cfg(any(windows, test))]
fn classify_windows_runtime_version(runtime_version: Option<String>) -> RawSystemWebViewProbe {
    let runtime_version =
        runtime_version.and_then(|version| (!version.trim().is_empty()).then_some(version));
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

#[cfg(windows)]
fn probe_windows() -> RawSystemWebViewProbe {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString, take_pwstr,
    };
    use windows_webview2::core::{PCWSTR, PWSTR};

    let mut version = PWSTR::null();
    // SAFETY: A null browser folder requests the installed Evergreen runtime. The
    // returned string is CoTaskMem-owned and take_pwstr releases it below.
    let query =
        unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) };
    let value = (!version.is_null()).then(|| take_pwstr(version));
    classify_windows_runtime_version(query.is_ok().then_some(value).flatten())
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
    fn classifies_windows_webview2_version_query_results() {
        let available = classify_probe(
            Platform::Windows,
            classify_windows_runtime_version(Some("fixture".to_owned())),
        );
        assert!(available.available);
        assert_eq!(available.runtime_version.as_deref(), Some("fixture"));
        assert!(available.reason_codes.is_empty());

        for runtime_version in [None, Some(String::new()), Some("  ".to_owned())] {
            let unavailable = classify_probe(
                Platform::Windows,
                classify_windows_runtime_version(runtime_version),
            );
            assert!(!unavailable.available);
            assert_eq!(unavailable.runtime_version, None);
            assert!(
                unavailable
                    .reason_codes
                    .contains(&"webview2-runtime-unavailable".to_owned())
            );
        }
    }
}
