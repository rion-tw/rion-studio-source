#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsRuntimeWindowPlacementEventRecord {
    pub event_id: String,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    #[ts(type = "number")]
    pub native_host_id: u64,
    #[ts(type = "number")]
    pub native_generation: u64,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsRuntimeWindowPlacementReceiptRecord {
    pub event_id: String,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    #[ts(type = "number")]
    pub native_host_id: u64,
    #[ts(type = "number")]
    pub native_generation: u64,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub source_topology_revision: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[ts(type = "\"applied\" | \"superseded\" | \"degraded\" | \"failed\" | \"indeterminate\"")]
    pub status: String,
    #[ts(type = "\"applied\" | \"superseded\" | \"failed\" | \"notRequired\"")]
    pub persistence_status: String,
    pub core_projection_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}
