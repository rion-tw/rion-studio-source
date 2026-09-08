use serde::{Deserialize, Serialize};

use crate::Platform;

/// Compatibility response for persisted v22 contracts; no native engine is probed.
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

pub fn probe_system_webview(platform: Platform) -> SystemWebViewProbe {
    SystemWebViewProbe {
        platform,
        engine: match platform {
            Platform::Macos => "wkwebview",
            Platform::Windows => "webview2",
        }
        .to_owned(),
        available: false,
        runtime_version: None,
        public_api_available: false,
        macro_input_available: false,
        audio_mute_available: false,
        reason_codes: vec!["system-webview-runtime-retired".to_owned()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_engines_are_unavailable_on_both_explicit_platforms() {
        for platform in [Platform::Macos, Platform::Windows] {
            let probe = probe_system_webview(platform);
            assert!(!probe.available);
            assert!(!probe.public_api_available);
            assert!(!probe.macro_input_available);
            assert!(!probe.audio_mute_available);
            assert_eq!(probe.runtime_version, None);
            assert_eq!(probe.reason_codes, ["system-webview-runtime-retired"]);
        }
    }
}
