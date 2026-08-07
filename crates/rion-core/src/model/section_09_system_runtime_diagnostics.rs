#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemRuntimeFailureRecord {
    pub captured_at: String,
    #[ts(type = "\"effect\"")]
    pub subsystem: String,
    pub stage: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effect_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rollback_error_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemRuntimeOperationSummaryRecord {
    pub accepted_at: String,
    pub captured_at: String,
    pub completion_policy: OperationCompletionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deadline_at: Option<String>,
    #[ts(type = "\"macos\" | \"windows\" | \"other\"")]
    pub platform: String,
    pub subsystem: SystemRuntimeOperationSubsystem,
    pub status: SystemRuntimeOperationStatus,
    pub stage: String,
    pub completion_scope: SystemRuntimeOperationCompletionScope,
    pub operation_id: String,
    pub trigger: String,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub topology_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub window_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub lifecycle_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub surface_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rollback_error_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabMutationRequestRecord {
    pub operation_id: String,
    #[ts(type = "\"stop\"")]
    pub mutation_kind: String,
    pub tab_id: String,
    pub source_window_id: String,
    #[ts(type = "number")]
    pub source_window_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
}

/// An adapter-authenticated tab intent. Window identity, generation, and order
/// are deliberately absent: the native runtime derives them from the registered
/// AppKit/WebView adapter that emitted the intent.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabIntentRecord {
    pub intent_id: String,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    pub renderer_instance_id: String,
    #[ts(type = "\"stop\"")]
    pub intent_kind: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabIntentReceiptRecord {
    pub intent_id: String,
    pub status: SystemRuntimeOperationStatus,
    pub topology_committed: bool,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cleanup_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabMoveResultRecord {
    pub target_window_id: String,
    pub receipt: SystemRuntimeOperationSummaryRecord,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabChromeItemRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    #[ts(rename = "type", type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    pub hidden: bool,
    pub audible: bool,
    pub muted: bool,
    pub loading: bool,
    pub degraded: bool,
    pub closable: bool,
    pub source_id: String,
    pub phase: String,
    pub role_ids: Vec<String>,
    pub role_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\"")]
    pub workspace_template: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabChromeProjectionRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub renderer_instance_id: Option<String>,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "number")]
    pub projection_revision: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub tabs: Vec<RuntimeTabChromeItemRecord>,
    pub tab_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    #[ts(type = "number")]
    pub display_id: u64,
    pub displays: Vec<DisplayInfoRecord>,
    pub window_name: String,
    pub window_maximized: bool,
    pub fullscreen: bool,
    pub window_fullscreen: bool,
    pub toolbar_visible: bool,
    pub always_hide_tab_close_button: bool,
    pub always_show_toolbar_in_full_screen: bool,
    pub language: String,
    pub theme: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabChromeReadyRecord {
    pub renderer_instance_id: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabChromeAcknowledgementRecord {
    pub renderer_instance_id: String,
    #[ts(type = "number")]
    pub projection_revision: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub observed_tab_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub observed_active_tab_id: Option<String>,
    #[ts(type = "\"applied\" | \"superseded\" | \"failed\"")]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayTopologySnapshotRecord {
    #[ts(type = "number")]
    pub revision: u64,
    pub captured_at: String,
    pub cause: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub primary_display_id: Option<String>,
    pub displays: Vec<DisplayInfoRecord>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct NativeWindowStateRecord {
    #[ts(type = "number")]
    pub revision: u64,
    pub captured_at: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    pub visible: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub focused: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ApplicationLifecycleStatusRecord {
    #[ts(type = "number")]
    pub revision: u64,
    pub captured_at: String,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "\"active\" | \"suspending\" | \"suspended\" | \"resuming\" | \"degraded\"")]
    pub state: String,
    pub reason: String,
    #[ts(type = "\"macos\" | \"windows\" | \"other\"")]
    pub platform: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SurfaceRecoveryAttemptRecord {
    pub attempt_id: String,
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_operation_id: Option<String>,
    pub role_id: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub surface_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "\"fencing\" | \"isolating\" | \"rebuilding\" | \"navigating\" | \"inputReady\" | \"swapping\" | \"completed\" | \"blocked\"")]
    pub phase: String,
    #[ts(type = "\"active\" | \"applied\" | \"degraded\" | \"failed\" | \"indeterminate\" | \"restartRequired\"")]
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabDragSessionRecord {
    pub session_id: String,
    pub operation_id: String,
    pub source_window_id: String,
    pub source_tab_id: String,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "\"accepted\" | \"dragging\" | \"hovering\" | \"dropping\" | \"settling\" | \"cancelled\" | \"completed\" | \"failed\" | \"indeterminate\"")]
    pub phase: String,
    #[ts(type = "\"active\" | \"applied\" | \"cancelled\" | \"failed\" | \"indeterminate\"")]
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppUpdateInstallAttemptRecord {
    pub attempt_id: String,
    pub target_version: String,
    #[ts(type = "\"accepted\" | \"preparing\" | \"installing\" | \"draining\" | \"installerHandoff\" | \"restartPending\" | \"applied\" | \"failedBeforeDrain\" | \"failedAfterDrain\"")]
    pub phase: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppUpdateStatusRecord {
    pub current_version: String,
    #[ts(type = "\"automatic\" | \"manual\"")]
    pub install_mode: String,
    pub is_packaged: bool,
    pub auto_update_enabled: bool,
    #[ts(type = "\"unsupported\" | \"idle\" | \"checking\" | \"available\" | \"not_available\" | \"downloading\" | \"downloaded\" | \"preparing\" | \"installing\" | \"draining\" | \"restart_pending\" | \"install_failed\" | \"error\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub available_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub download_progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub download_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub release_page_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub installer_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub install_attempt: Option<AppUpdateInstallAttemptRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_retry_install: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EngineCapabilityEvidenceRecord {
    pub capability: String,
    pub status: EngineCapabilityStatus,
    pub contract_version: u32,
    pub probe_result: String,
    pub policy_mode: String,
    pub evidence_stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputRoleDiagnosticRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub stopping: bool,
    pub quiesced: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputDiagnosticsRecord {
    pub roles: Vec<MacroInputRoleDiagnosticRecord>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemRuntimeInputFenceRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub reason: String,
    pub state: String,
    #[ts(type = "number")]
    pub age_ms: u64,
    pub core_stopping: bool,
    pub core_quiesced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub native_input_enabled: Option<bool>,
    pub drained: bool,
    pub pending_page_finish_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub surface_generation: Option<u64>,
    pub recovery_scheduled: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemRuntimeInputFenceEventRecord {
    pub captured_at: String,
    pub role_id: String,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub event: String,
    pub reason: String,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub surface_generation: Option<u64>,
    pub drained: bool,
    pub pending_page_finish_count: u32,
    pub recovery_scheduled: bool,
}

fn default_system_runtime_shutdown_state() -> String {
    "accepting".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemRuntimeDiagnosticsRecord {
    pub contract_version: u32,
    #[ts(type = "\"macos\" | \"windows\" | \"other\"")]
    pub platform: String,
    #[serde(default = "default_system_runtime_shutdown_state")]
    #[ts(type = "\"accepting\" | \"draining\" | \"closed\" | \"indeterminate\"")]
    pub shutdown_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub application_lifecycle: Option<ApplicationLifecycleStatusRecord>,
    pub healthy: bool,
    pub snapshot_complete: bool,
    pub collection_error_codes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recovery_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_host_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launching_tab_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub degraded_tab_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub managed_surface_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retired_surface_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closing_surface_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quarantined_surface_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pending_close_tab_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quarantined_role_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recovering_role_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_input_fence_count: Option<u32>,
    #[serde(default)]
    pub active_input_fences: Vec<SystemRuntimeInputFenceRecord>,
    #[serde(default)]
    pub recent_input_fence_events: Vec<SystemRuntimeInputFenceEventRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retryable_failed_launch_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failed_launch_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_native_creation_count: Option<u32>,
    pub native_creation_limit: u32,
    pub recent_failures: Vec<SystemRuntimeFailureRecord>,
    #[serde(default)]
    pub recent_operations: Vec<SystemRuntimeOperationSummaryRecord>,
    #[serde(default)]
    pub capability_evidence: Vec<EngineCapabilityEvidenceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_lifecycle_operation_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_navigation_operation_count: Option<u32>,
}
#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum SystemRuntimeOperationSubsystem {
    SurfaceLifecycle,
    Navigation,
    Input,
    Presentation,
    TabActivation,
    TabMutation,
    Projection,
    Geometry,
    Popup,
    Security,
    Session,
    Audio,
    Zoom,
    Metadata,
    Performance,
    Capability,
    Shutdown,
    DisplayTopology,
    WindowLifecycle,
    Focus,
    Drag,
    Recovery,
    Power,
}

impl SystemRuntimeOperationSubsystem {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SurfaceLifecycle => "surfaceLifecycle",
            Self::Navigation => "navigation",
            Self::Input => "input",
            Self::Presentation => "presentation",
            Self::TabActivation => "tabActivation",
            Self::TabMutation => "tabMutation",
            Self::Projection => "projection",
            Self::Geometry => "geometry",
            Self::Popup => "popup",
            Self::Security => "security",
            Self::Session => "session",
            Self::Audio => "audio",
            Self::Zoom => "zoom",
            Self::Metadata => "metadata",
            Self::Performance => "performance",
            Self::Capability => "capability",
            Self::Shutdown => "shutdown",
            Self::DisplayTopology => "displayTopology",
            Self::WindowLifecycle => "windowLifecycle",
            Self::Focus => "focus",
            Self::Drag => "drag",
            Self::Recovery => "recovery",
            Self::Power => "power",
        }
    }

    pub const fn default_completion_scope(self) -> SystemRuntimeOperationCompletionScope {
        match self {
            Self::SurfaceLifecycle
            | Self::Presentation
            | Self::Geometry
            | Self::Security
            | Self::Audio
            | Self::Zoom
            | Self::Shutdown
            | Self::DisplayTopology
            | Self::WindowLifecycle
            | Self::Focus => SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
            Self::TabActivation => SystemRuntimeOperationCompletionScope::TopologyCommitted,
            Self::TabMutation => SystemRuntimeOperationCompletionScope::StateCommit,
            Self::Projection => SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
            Self::Drag => SystemRuntimeOperationCompletionScope::DragCommitted,
            Self::Recovery => SystemRuntimeOperationCompletionScope::InputReady,
            Self::Power => SystemRuntimeOperationCompletionScope::LifecycleTransition,
            Self::Navigation => SystemRuntimeOperationCompletionScope::PageFinished,
            Self::Input | Self::Metadata => {
                SystemRuntimeOperationCompletionScope::NativeSubmission
            }
            Self::Popup | Self::Session => SystemRuntimeOperationCompletionScope::StateCommit,
            Self::Performance | Self::Capability => {
                SystemRuntimeOperationCompletionScope::RuntimeProbe
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum SystemRuntimeOperationStatus {
    Applied,
    Superseded,
    Cancelled,
    Degraded,
    Failed,
    Indeterminate,
}

impl SystemRuntimeOperationStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
            Self::Indeterminate => "indeterminate",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum SystemRuntimeOperationCompletionScope {
    StateCommit,
    NativeSubmission,
    NativeAcknowledgement,
    NativeDestroyed,
    PageFinished,
    InputReady,
    PolicyDecision,
    RuntimeProbe,
    TopologyCommitted,
    DragCommitted,
    LifecycleTransition,
}

impl SystemRuntimeOperationCompletionScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StateCommit => "stateCommit",
            Self::NativeSubmission => "nativeSubmission",
            Self::NativeAcknowledgement => "nativeAcknowledgement",
            Self::NativeDestroyed => "nativeDestroyed",
            Self::PageFinished => "pageFinished",
            Self::InputReady => "inputReady",
            Self::PolicyDecision => "policyDecision",
            Self::RuntimeProbe => "runtimeProbe",
            Self::TopologyCommitted => "topologyCommitted",
            Self::DragCommitted => "dragCommitted",
            Self::LifecycleTransition => "lifecycleTransition",
        }
    }
}
