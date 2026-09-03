use crate::model::{
    BrowserEngineResolutionRecord, BrowserHostKind, BrowserRuntimeFailureReason,
    ResolvedBrowserEngine,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserEngineResolutionInput {
    pub engine: ResolvedBrowserEngine,
    pub host_kind: BrowserHostKind,
    pub runtime_available: bool,
    pub runtime_failure_reason: Option<BrowserRuntimeFailureReason>,
}

pub(crate) fn resolve_browser_engine(
    input: BrowserEngineResolutionInput,
) -> BrowserEngineResolutionRecord {
    BrowserEngineResolutionRecord {
        resolved_engine: input.engine,
        host_kind: input.host_kind,
        issue_reason: if input.runtime_available {
            None
        } else {
            input
                .runtime_failure_reason
                .or(Some(BrowserRuntimeFailureReason::RuntimeCreationFailed))
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_input(engine: ResolvedBrowserEngine) -> BrowserEngineResolutionInput {
        BrowserEngineResolutionInput {
            engine,
            host_kind: BrowserHostKind::SystemNative,
            runtime_available: true,
            runtime_failure_reason: None,
        }
    }

    #[test]
    fn resolution_retains_the_registered_engine_and_host() {
        for (engine, host_kind) in [
            (
                ResolvedBrowserEngine::Webview2,
                BrowserHostKind::SystemNative,
            ),
            (
                ResolvedBrowserEngine::Wkwebview,
                BrowserHostKind::SystemNative,
            ),
            (
                ResolvedBrowserEngine::Chromium,
                BrowserHostKind::AppkitChromium,
            ),
            (
                ResolvedBrowserEngine::Chromium,
                BrowserHostKind::BundledChromium,
            ),
        ] {
            let resolved = resolve_browser_engine(BrowserEngineResolutionInput {
                engine,
                host_kind,
                runtime_available: true,
                runtime_failure_reason: None,
            });
            assert_eq!(resolved.resolved_engine, engine);
            assert_eq!(resolved.host_kind, host_kind);
        }
    }

    #[test]
    fn unavailable_system_reports_a_capability_failure_without_changing_engines() {
        let mut fallback = system_input(ResolvedBrowserEngine::Webview2);
        fallback.runtime_available = false;
        fallback.runtime_failure_reason = Some(BrowserRuntimeFailureReason::RuntimeCreationFailed);
        let resolution = resolve_browser_engine(fallback);
        assert_eq!(resolution.resolved_engine, ResolvedBrowserEngine::Webview2);
        assert_eq!(
            resolution.issue_reason,
            Some(BrowserRuntimeFailureReason::RuntimeCreationFailed)
        );
    }
}
