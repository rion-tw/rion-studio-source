use rion_core::{PerformanceTargetStatus, WebGlCommandBatchingStatus, WebGlExecutionPath};

#[cfg(any(target_os = "macos", test))]
const WEBKIT_26_5_BUILD: &str = "21624.2.5.11.4";
#[cfg(any(target_os = "macos", test))]
const WEBKIT_26_6_BUILD: &str = "21624.4.5.14.1";
#[cfg(any(target_os = "macos", test))]
const WEBKIT_26_6_2_BUILD: &str = "21624.5.1.11.3";
#[cfg(any(target_os = "macos", test))]
const WEBKIT_STP_249_BUILD: &str = "21626.1.1";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RoleWebGlConfiguration {
    pub(super) command_batching_status: WebGlCommandBatchingStatus,
    pub(super) execution_path: WebGlExecutionPath,
    pub(super) performance_target_status: PerformanceTargetStatus,
}

impl RoleWebGlConfiguration {
    #[cfg(not(target_os = "macos"))]
    pub(super) fn windows() -> Self {
        Self {
            command_batching_status: WebGlCommandBatchingStatus::NotApplicable,
            execution_path: WebGlExecutionPath::EngineManaged,
            performance_target_status: PerformanceTargetStatus::NotRun,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WebKitFeaturePreference {
    KeepDefault,
    Disable,
    Enable,
}

#[cfg(any(target_os = "macos", test))]
impl WebKitFeaturePreference {
    #[cfg(target_os = "macos")]
    pub(super) const fn native_value(self) -> i32 {
        match self {
            Self::KeepDefault => -1,
            Self::Disable => 0,
            Self::Enable => 1,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct MacWebGlPolicy {
    pub(super) canvas_rendering_preference: WebKitFeaturePreference,
    pub(super) configuration: RoleWebGlConfiguration,
    pub(super) dom_rendering_preference: WebKitFeaturePreference,
    pub(super) web_gl_preference: WebKitFeaturePreference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MacWebGlExperimentMode {
    SystemDefault,
    SystemGpuProcess,
    SystemDirect,
    StpGpuProcess,
    StpDirect,
    StpGpuProcessDomRendering,
    StpGpuProcessAllRendering,
}

impl MacWebGlExperimentMode {
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "system-default" => Some(Self::SystemDefault),
            "system-gpu-process" => Some(Self::SystemGpuProcess),
            "system-direct" => Some(Self::SystemDirect),
            "stp-gpu-process" => Some(Self::StpGpuProcess),
            "stp-direct" => Some(Self::StpDirect),
            "stp-gpu-process-dom-rendering" => Some(Self::StpGpuProcessDomRendering),
            "stp-gpu-process-all-rendering" => Some(Self::StpGpuProcessAllRendering),
            _ => None,
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) const fn uses_dom_rendering_override(self) -> bool {
        matches!(
            self,
            Self::StpGpuProcessDomRendering | Self::StpGpuProcessAllRendering
        )
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) const fn uses_canvas_rendering_override(self) -> bool {
        matches!(self, Self::StpGpuProcessAllRendering)
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) const fn uses_gpu_process(self) -> bool {
        matches!(
            self,
            Self::SystemGpuProcess
                | Self::StpGpuProcess
                | Self::StpGpuProcessDomRendering
                | Self::StpGpuProcessAllRendering
        )
    }
}

pub(super) fn active_mac_web_gl_experiment() -> Option<MacWebGlExperimentMode> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    #[cfg(debug_assertions)]
    {
        if std::env::var("RION_WEBKIT_EXPERIMENT_ISOLATED").as_deref() != Ok("1") {
            return None;
        }
        std::env::var("RION_WEBKIT_EXPERIMENT_MODE")
            .ok()
            .as_deref()
            .and_then(MacWebGlExperimentMode::parse)
    }
    #[cfg(not(debug_assertions))]
    None
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn mac_web_gl_policy(
    webkit_runtime_version: Option<&str>,
    experiment: Option<MacWebGlExperimentMode>,
) -> MacWebGlPolicy {
    let command_batching_status = webkit_command_batching_status(webkit_runtime_version);
    if let Some(experiment) = experiment {
        if experiment == MacWebGlExperimentMode::SystemDefault {
            return MacWebGlPolicy {
                canvas_rendering_preference: WebKitFeaturePreference::KeepDefault,
                configuration: RoleWebGlConfiguration {
                    command_batching_status,
                    execution_path: WebGlExecutionPath::EngineManaged,
                    performance_target_status: PerformanceTargetStatus::Indeterminate,
                },
                dom_rendering_preference: WebKitFeaturePreference::KeepDefault,
                web_gl_preference: WebKitFeaturePreference::KeepDefault,
            };
        }
        let uses_gpu_process = experiment.uses_gpu_process();
        return MacWebGlPolicy {
            canvas_rendering_preference: if experiment.uses_canvas_rendering_override() {
                WebKitFeaturePreference::Enable
            } else {
                WebKitFeaturePreference::KeepDefault
            },
            configuration: RoleWebGlConfiguration {
                command_batching_status,
                execution_path: if uses_gpu_process {
                    WebGlExecutionPath::GpuProcess
                } else {
                    WebGlExecutionPath::WebContentDirect
                },
                performance_target_status: PerformanceTargetStatus::Indeterminate,
            },
            dom_rendering_preference: if experiment.uses_dom_rendering_override() {
                WebKitFeaturePreference::Enable
            } else {
                WebKitFeaturePreference::KeepDefault
            },
            web_gl_preference: if uses_gpu_process {
                WebKitFeaturePreference::Enable
            } else {
                WebKitFeaturePreference::Disable
            },
        };
    }
    MacWebGlPolicy {
        canvas_rendering_preference: WebKitFeaturePreference::KeepDefault,
        configuration: RoleWebGlConfiguration {
            command_batching_status,
            execution_path: WebGlExecutionPath::EngineManaged,
            performance_target_status: PerformanceTargetStatus::NotRun,
        },
        dom_rendering_preference: WebKitFeaturePreference::KeepDefault,
        web_gl_preference: WebKitFeaturePreference::KeepDefault,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn webkit_command_batching_status(
    webkit_runtime_version: Option<&str>,
) -> WebGlCommandBatchingStatus {
    match webkit_runtime_version.map(str::trim) {
        Some(WEBKIT_26_5_BUILD) => WebGlCommandBatchingStatus::VerifiedAbsent,
        Some(WEBKIT_26_6_BUILD) => WebGlCommandBatchingStatus::VerifiedAbsent,
        Some(WEBKIT_26_6_2_BUILD) => WebGlCommandBatchingStatus::VerifiedAbsent,
        Some(WEBKIT_STP_249_BUILD) => WebGlCommandBatchingStatus::VerifiedAvailable,
        _ => WebGlCommandBatchingStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_catalog_uses_exact_verified_builds_without_numeric_guessing() {
        assert_eq!(
            webkit_command_batching_status(Some(WEBKIT_26_5_BUILD)),
            WebGlCommandBatchingStatus::VerifiedAbsent
        );
        assert_eq!(
            webkit_command_batching_status(Some("21624.4.5.14.1")),
            WebGlCommandBatchingStatus::VerifiedAbsent
        );
        assert_eq!(
            webkit_command_batching_status(Some("21624.4.5.14.2")),
            WebGlCommandBatchingStatus::Unknown
        );
        assert_eq!(
            webkit_command_batching_status(Some(WEBKIT_26_6_2_BUILD)),
            WebGlCommandBatchingStatus::VerifiedAbsent
        );
        assert_eq!(
            webkit_command_batching_status(Some("21624.5.1.11.4")),
            WebGlCommandBatchingStatus::Unknown
        );
        assert_eq!(
            webkit_command_batching_status(Some(WEBKIT_STP_249_BUILD)),
            WebGlCommandBatchingStatus::VerifiedAvailable
        );
        assert_eq!(
            webkit_command_batching_status(Some("21627.0.0")),
            WebGlCommandBatchingStatus::Unknown
        );
    }

    #[test]
    fn production_policy_always_keeps_webkit_process_preferences_at_default() {
        let policy = mac_web_gl_policy(Some("unknown"), None);
        assert_eq!(
            policy.web_gl_preference,
            WebKitFeaturePreference::KeepDefault
        );
        assert_eq!(
            policy.configuration.execution_path,
            WebGlExecutionPath::EngineManaged
        );
        let known = mac_web_gl_policy(Some(WEBKIT_26_6_BUILD), None);
        assert_eq!(
            known.web_gl_preference,
            WebKitFeaturePreference::KeepDefault
        );
        assert_eq!(
            known.configuration.execution_path,
            WebGlExecutionPath::EngineManaged
        );
        assert_eq!(
            known.dom_rendering_preference,
            WebKitFeaturePreference::KeepDefault
        );
        assert_eq!(
            known.canvas_rendering_preference,
            WebKitFeaturePreference::KeepDefault
        );
    }

    #[test]
    fn debug_experiments_remain_explicit() {
        assert_eq!(
            MacWebGlExperimentMode::parse("system-default"),
            Some(MacWebGlExperimentMode::SystemDefault)
        );
        let system_default = mac_web_gl_policy(
            Some(WEBKIT_26_6_2_BUILD),
            Some(MacWebGlExperimentMode::SystemDefault),
        );
        assert_eq!(
            system_default.web_gl_preference,
            WebKitFeaturePreference::KeepDefault
        );
        assert_eq!(
            system_default.configuration.execution_path,
            WebGlExecutionPath::EngineManaged
        );
        assert_eq!(
            system_default.configuration.performance_target_status,
            PerformanceTargetStatus::Indeterminate
        );

        let experiment = mac_web_gl_policy(
            Some(WEBKIT_STP_249_BUILD),
            Some(MacWebGlExperimentMode::StpGpuProcessAllRendering),
        );
        assert_eq!(
            experiment.web_gl_preference,
            WebKitFeaturePreference::Enable
        );
        assert_eq!(
            experiment.dom_rendering_preference,
            WebKitFeaturePreference::Enable
        );
        assert_eq!(
            experiment.canvas_rendering_preference,
            WebKitFeaturePreference::Enable
        );
        assert_eq!(
            experiment.configuration.execution_path,
            WebGlExecutionPath::GpuProcess
        );
        assert_eq!(
            experiment.configuration.performance_target_status,
            PerformanceTargetStatus::Indeterminate
        );
    }
}
