use crate::model::{
    BrowserEngineOverride, BrowserEngineResolutionRecord, BrowserHostKind, EmbeddedBrowserEngine,
    ResolvedBrowserEngine, SystemWebViewIssueReason, WorkspaceEnginePreferenceRecord,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserEngineResolutionInput {
    pub global_engine: EmbeddedBrowserEngine,
    pub game_engine: BrowserEngineOverride,
    pub workspace_engine: BrowserEngineOverride,
    pub role_engine_pin: Option<EmbeddedBrowserEngine>,
    pub platform: rion_platform::Platform,
    pub system_available: bool,
    pub system_failure_reason: Option<SystemWebViewIssueReason>,
}

pub(crate) fn resolve_browser_engine(
    input: BrowserEngineResolutionInput,
) -> BrowserEngineResolutionRecord {
    let preferred_engine = resolve_preference(
        input.global_engine,
        input.game_engine,
        input.workspace_engine,
    );
    let _ = input.role_engine_pin;
    BrowserEngineResolutionRecord {
        preferred_engine,
        resolved_engine: match input.platform {
            rion_platform::Platform::Windows => ResolvedBrowserEngine::Webview2,
            rion_platform::Platform::Macos => ResolvedBrowserEngine::Wkwebview,
        },
        host_kind: BrowserHostKind::SystemNative,
        issue_reason: if input.system_available {
            None
        } else {
            input
                .system_failure_reason
                .or(Some(SystemWebViewIssueReason::RuntimeCreationFailed))
        },
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(platform: rion_platform::Platform) -> BrowserEngineResolutionInput {
        BrowserEngineResolutionInput {
            global_engine: EmbeddedBrowserEngine::System,
            game_engine: BrowserEngineOverride::Inherit,
            workspace_engine: BrowserEngineOverride::Inherit,
            role_engine_pin: None,
            platform,
            system_available: true,
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
            assert_eq!(resolved.host_kind, BrowserHostKind::SystemNative);
        }
    }

    #[test]
    fn every_supported_preference_resolves_to_system() {
        let mut value = input(rion_platform::Platform::Windows);
        value.game_engine = BrowserEngineOverride::System;
        let resolved = resolve_browser_engine(value);
        assert_eq!(resolved.preferred_engine, EmbeddedBrowserEngine::System);
        assert_eq!(resolved.resolved_engine, ResolvedBrowserEngine::Webview2);
    }

    #[test]
    fn unavailable_system_reports_a_capability_failure_without_changing_engines() {
        let mut fallback = input(rion_platform::Platform::Windows);
        fallback.system_available = false;
        fallback.system_failure_reason = Some(SystemWebViewIssueReason::CachedCompatibilityFailure);
        let resolution = resolve_browser_engine(fallback);
        assert_eq!(resolution.resolved_engine, ResolvedBrowserEngine::Webview2);
        assert_eq!(
            resolution.issue_reason,
            Some(SystemWebViewIssueReason::CachedCompatibilityFailure)
        );
    }

    #[test]
    fn workspace_preferences_always_resolve_to_system() {
        let inherited = resolve_workspace_preference(
            EmbeddedBrowserEngine::System,
            BrowserEngineOverride::Inherit,
            [
                BrowserEngineOverride::Inherit,
                BrowserEngineOverride::System,
            ],
        );
        assert!(!inherited.requires_override);
        assert_eq!(
            inherited.preferred_engine,
            Some(EmbeddedBrowserEngine::System)
        );

        let overridden = resolve_workspace_preference(
            EmbeddedBrowserEngine::System,
            BrowserEngineOverride::System,
            [
                BrowserEngineOverride::Inherit,
                BrowserEngineOverride::System,
            ],
        );
        assert!(!overridden.requires_override);
        assert_eq!(
            overridden.preferred_engine,
            Some(EmbeddedBrowserEngine::System)
        );
    }
}
