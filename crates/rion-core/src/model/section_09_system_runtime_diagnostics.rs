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
    pub deadline_at: String,
    #[ts(type = "\"macos\" | \"windows\" | \"other\"")]
    pub platform: String,
    #[ts(type = "\"surfaceLifecycle\" | \"navigation\" | \"input\" | \"presentation\" | \"geometry\" | \"popup\" | \"security\" | \"session\" | \"audio\" | \"zoom\" | \"metadata\" | \"performance\" | \"capability\" | \"shutdown\" | \"displayTopology\" | \"windowLifecycle\" | \"focus\" | \"recovery\" | \"power\" | \"drag\" | \"projection\"")]
    pub subsystem: String,
    #[ts(type = "\"applied\" | \"superseded\" | \"cancelled\" | \"degraded\" | \"failed\" | \"indeterminate\"")]
    pub status: String,
    pub stage: String,
    #[ts(type = "\"stateCommit\" | \"nativeSubmission\" | \"nativeAcknowledgement\" | \"nativeDestroyed\" | \"pageFinished\" | \"inputReady\" | \"policyDecision\" | \"runtimeProbe\" | \"topologyCommitted\" | \"focusObserved\" | \"dragCommitted\" | \"lifecycleTransition\"")]
    pub completion_scope: String,
    pub operation_id: String,
    pub trigger: String,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    #[ts(type = "number")]
    pub timeout_ms: u64,
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
    #[ts(type = "number")]
    pub topology_revision: u64,
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
