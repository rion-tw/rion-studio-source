#![allow(dead_code)] // Phase 1 ships the resolver before Phase 2 wires native runtime hosts.

use crate::model::{
    BrowserEngineOverride, BrowserEngineResolutionRecord, BrowserHostKind, BrowserSessionSource,
    EmbeddedBrowserEngine, EngineFallbackReason, ResolvedBrowserEngine,
    WorkspaceEnginePreferenceRecord,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserEngineResolutionInput<'a> {
    pub launch_mode: &'a str,
    pub global_engine: EmbeddedBrowserEngine,
    pub game_engine: BrowserEngineOverride,
    pub workspace_engine: BrowserEngineOverride,
    pub role_engine_pin: Option<EmbeddedBrowserEngine>,
    pub browser_session_source: Option<BrowserSessionSource>,
    pub platform: rion_platform::Platform,
    pub system_available: bool,
    pub electron_available: bool,
    pub system_failure_reason: Option<EngineFallbackReason>,
}

pub(crate) fn resolve_browser_engine(
    input: BrowserEngineResolutionInput<'_>,
) -> BrowserEngineResolutionRecord {
    let preferred_engine = resolve_preference(
        input.global_engine,
        input.game_engine,
        input.workspace_engine,
    );
    if input.launch_mode == "external" {
        return external(preferred_engine, None);
    }

    let forced_electron_reason =
        if input.browser_session_source == Some(BrowserSessionSource::ChromeProfile) {
            Some(EngineFallbackReason::ChromeProfileSession)
        } else if input.role_engine_pin == Some(EmbeddedBrowserEngine::Electron) {
            Some(EngineFallbackReason::LegacyRolePin)
        } else {
            None
        };
    let effective_preference = if forced_electron_reason.is_some() {
        EmbeddedBrowserEngine::Electron
    } else {
        input.role_engine_pin.unwrap_or(preferred_engine)
    };

    match effective_preference {
        EmbeddedBrowserEngine::System if input.system_available => BrowserEngineResolutionRecord {
            preferred_engine,
            resolved_engine: match input.platform {
                rion_platform::Platform::Windows => ResolvedBrowserEngine::Webview2,
                rion_platform::Platform::Macos => ResolvedBrowserEngine::Wkwebview,
            },
            host_kind: BrowserHostKind::System,
            fallback_reason: None,
        },
        EmbeddedBrowserEngine::System if input.electron_available => electron(
            preferred_engine,
            input
                .system_failure_reason
                .or(Some(EngineFallbackReason::RuntimeCreationFailed)),
        ),
        EmbeddedBrowserEngine::Electron if input.electron_available => {
            electron(preferred_engine, forced_electron_reason)
        }
        _ if input.launch_mode == "auto" => external(
            preferred_engine,
            forced_electron_reason.or(input
                .system_failure_reason
                .or(Some(EngineFallbackReason::RuntimeCreationFailed))),
        ),
        _ => electron(
            preferred_engine,
            forced_electron_reason.or(input
                .system_failure_reason
                .or(Some(EngineFallbackReason::RuntimeCreationFailed))),
        ),
    }
}

pub(crate) fn resolve_workspace_preference(
    global_engine: EmbeddedBrowserEngine,
    workspace_engine: BrowserEngineOverride,
    game_engines: impl IntoIterator<Item = BrowserEngineOverride>,
) -> WorkspaceEnginePreferenceRecord {
    if workspace_engine != BrowserEngineOverride::Inherit {
        return WorkspaceEnginePreferenceRecord {
            preferred_engine: Some(override_engine(workspace_engine).expect("non-inherit engine")),
            requires_override: false,
        };
    }

    let mut resolved = game_engines
        .into_iter()
        .map(|engine| resolve_preference(global_engine, engine, BrowserEngineOverride::Inherit));
    let first = resolved.next().unwrap_or(global_engine);
    if resolved.any(|engine| engine != first) {
        WorkspaceEnginePreferenceRecord {
            preferred_engine: None,
            requires_override: true,
        }
    } else {
        WorkspaceEnginePreferenceRecord {
            preferred_engine: Some(first),
            requires_override: false,
        }
    }
}

fn resolve_preference(
    global_engine: EmbeddedBrowserEngine,
    game_engine: BrowserEngineOverride,
    workspace_engine: BrowserEngineOverride,
) -> EmbeddedBrowserEngine {
    override_engine(workspace_engine)
        .or_else(|| override_engine(game_engine))
        .unwrap_or(global_engine)
}

fn override_engine(value: BrowserEngineOverride) -> Option<EmbeddedBrowserEngine> {
    match value {
        BrowserEngineOverride::Inherit => None,
        BrowserEngineOverride::System => Some(EmbeddedBrowserEngine::System),
        BrowserEngineOverride::Electron => Some(EmbeddedBrowserEngine::Electron),
    }
}

fn electron(
    preferred_engine: EmbeddedBrowserEngine,
    fallback_reason: Option<EngineFallbackReason>,
) -> BrowserEngineResolutionRecord {
    BrowserEngineResolutionRecord {
        preferred_engine,
        resolved_engine: ResolvedBrowserEngine::Electron,
        host_kind: BrowserHostKind::Electron,
        fallback_reason,
    }
}

fn external(
    preferred_engine: EmbeddedBrowserEngine,
    fallback_reason: Option<EngineFallbackReason>,
) -> BrowserEngineResolutionRecord {
    BrowserEngineResolutionRecord {
        preferred_engine,
        resolved_engine: ResolvedBrowserEngine::ExternalChrome,
        host_kind: BrowserHostKind::External,
        fallback_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(platform: rion_platform::Platform) -> BrowserEngineResolutionInput<'static> {
        BrowserEngineResolutionInput {
            launch_mode: "embedded",
            global_engine: EmbeddedBrowserEngine::System,
            game_engine: BrowserEngineOverride::Inherit,
            workspace_engine: BrowserEngineOverride::Inherit,
            role_engine_pin: None,
            browser_session_source: Some(BrowserSessionSource::Managed),
            platform,
            system_available: true,
            electron_available: true,
            system_failure_reason: None,
        }
    }

    #[test]
    fn system_preference_maps_to_the_platform_engine() {
        for (platform, expected) in [
            (
                rion_platform::Platform::Windows,
                ResolvedBrowserEngine::Webview2,
            ),
            (
                rion_platform::Platform::Macos,
                ResolvedBrowserEngine::Wkwebview,
            ),
        ] {
            let resolved = resolve_browser_engine(input(platform));
            assert_eq!(resolved.resolved_engine, expected);
            assert_eq!(resolved.host_kind, BrowserHostKind::System);
        }
    }

    #[test]
    fn workspace_then_game_then_global_controls_preference() {
        let mut value = input(rion_platform::Platform::Windows);
        value.global_engine = EmbeddedBrowserEngine::Electron;
        value.game_engine = BrowserEngineOverride::System;
        value.workspace_engine = BrowserEngineOverride::Electron;
        let resolved = resolve_browser_engine(value);
        assert_eq!(resolved.preferred_engine, EmbeddedBrowserEngine::Electron);
        assert_eq!(resolved.resolved_engine, ResolvedBrowserEngine::Electron);
    }

    #[test]
    fn legacy_and_chrome_profile_constraints_are_visible() {
        let mut legacy = input(rion_platform::Platform::Macos);
        legacy.role_engine_pin = Some(EmbeddedBrowserEngine::Electron);
        let legacy = resolve_browser_engine(legacy);
        assert_eq!(legacy.resolved_engine, ResolvedBrowserEngine::Electron);
        assert_eq!(
            legacy.fallback_reason,
            Some(EngineFallbackReason::LegacyRolePin)
        );

        let mut chrome = input(rion_platform::Platform::Macos);
        chrome.role_engine_pin = Some(EmbeddedBrowserEngine::Electron);
        chrome.browser_session_source = Some(BrowserSessionSource::ChromeProfile);
        let chrome = resolve_browser_engine(chrome);
        assert_eq!(
            chrome.fallback_reason,
            Some(EngineFallbackReason::ChromeProfileSession)
        );
    }

    #[test]
    fn unavailable_system_falls_back_to_electron_then_external_only_in_auto() {
        let mut fallback = input(rion_platform::Platform::Windows);
        fallback.system_available = false;
        fallback.system_failure_reason = Some(EngineFallbackReason::CachedCompatibilityFailure);
        let electron = resolve_browser_engine(fallback);
        assert_eq!(electron.resolved_engine, ResolvedBrowserEngine::Electron);
        assert_eq!(
            electron.fallback_reason,
            Some(EngineFallbackReason::CachedCompatibilityFailure)
        );

        fallback.electron_available = false;
        fallback.launch_mode = "auto";
        let external = resolve_browser_engine(fallback);
        assert_eq!(
            external.resolved_engine,
            ResolvedBrowserEngine::ExternalChrome
        );
    }

    #[test]
    fn mixed_game_preferences_require_a_persisted_workspace_override() {
        let mixed = resolve_workspace_preference(
            EmbeddedBrowserEngine::System,
            BrowserEngineOverride::Inherit,
            [
                BrowserEngineOverride::Inherit,
                BrowserEngineOverride::Electron,
            ],
        );
        assert!(mixed.requires_override);
        assert_eq!(mixed.preferred_engine, None);

        let overridden = resolve_workspace_preference(
            EmbeddedBrowserEngine::System,
            BrowserEngineOverride::Electron,
            [
                BrowserEngineOverride::Inherit,
                BrowserEngineOverride::System,
            ],
        );
        assert!(!overridden.requires_override);
        assert_eq!(
            overridden.preferred_engine,
            Some(EmbeddedBrowserEngine::Electron)
        );
    }
}
