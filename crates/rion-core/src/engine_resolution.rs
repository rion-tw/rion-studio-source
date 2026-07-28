use crate::model::{
    BrowserEngineResolutionRecord, BrowserHostKind, ResolvedBrowserEngine, SystemWebViewIssueReason,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserEngineResolutionInput {
    pub platform: rion_platform::Platform,
    pub system_available: bool,
    pub system_failure_reason: Option<SystemWebViewIssueReason>,
}

pub(crate) fn resolve_browser_engine(
    input: BrowserEngineResolutionInput,
) -> BrowserEngineResolutionRecord {
    BrowserEngineResolutionRecord {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn input(platform: rion_platform::Platform) -> BrowserEngineResolutionInput {
        BrowserEngineResolutionInput {
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
    fn unavailable_system_reports_a_capability_failure_without_changing_engines() {
        let mut fallback = input(rion_platform::Platform::Windows);
        fallback.system_available = false;
        fallback.system_failure_reason = Some(SystemWebViewIssueReason::RuntimeCreationFailed);
        let resolution = resolve_browser_engine(fallback);
        assert_eq!(resolution.resolved_engine, ResolvedBrowserEngine::Webview2);
        assert_eq!(
            resolution.issue_reason,
            Some(SystemWebViewIssueReason::RuntimeCreationFailed)
        );
    }
}
