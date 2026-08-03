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
    pub captured_at: String,
    #[ts(type = "\"macos\" | \"windows\" | \"other\"")]
    pub platform: String,
    #[ts(type = "\"surfaceLifecycle\" | \"navigation\" | \"input\" | \"presentation\" | \"geometry\" | \"popup\" | \"security\" | \"session\" | \"audio\" | \"zoom\" | \"metadata\" | \"performance\" | \"capability\" | \"shutdown\"")]
    pub subsystem: String,
    #[ts(type = "\"applied\" | \"superseded\" | \"degraded\" | \"failed\" | \"indeterminate\"")]
    pub status: String,
    pub stage: String,
    #[ts(type = "\"stateCommit\" | \"nativeSubmission\" | \"nativeAcknowledgement\" | \"pageFinished\" | \"inputReady\" | \"policyDecision\" | \"runtimeProbe\"")]
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
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rollback_error_count: Option<u32>,
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
