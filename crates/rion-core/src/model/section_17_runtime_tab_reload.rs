#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleReloadFenceRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub input_epoch: u64,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleReloadPreparationRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub input_epoch: u64,
    #[ts(type = "number")]
    pub surface_generation: u64,
    pub document_instance_id: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedTabRoleReloadPreparationReceiptRecord {
    pub reload_operation_id: String,
    pub tab_id: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    pub status: SystemRuntimeOperationStatus,
    pub roles: Vec<EmbeddedRoleReloadPreparationRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleReloadNativeReceiptRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub input_epoch: u64,
    #[ts(type = "number")]
    pub surface_generation: u64,
    pub before_document_instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_document_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub navigation_sequence: Option<u64>,
    #[ts(type = "\"notSubmitted\" | \"submitted\" | \"unknown\"")]
    pub submission_state: String,
    pub status: SystemRuntimeOperationStatus,
    pub native_input_resumed: bool,
    pub restart_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedTabRoleReloadNativeReceiptRecord {
    pub reload_operation_id: String,
    pub tab_id: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    pub status: SystemRuntimeOperationStatus,
    pub roles: Vec<EmbeddedRoleReloadNativeReceiptRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedTabRoleReloadSupersedeReceiptRecord {
    pub reload_operation_id: String,
    pub tab_id: String,
    pub status: SystemRuntimeOperationStatus,
    pub roles: Vec<EmbeddedRoleReloadSupersedeReceiptRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleReloadSupersedeReceiptRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub input_epoch: u64,
    #[ts(type = "\"notSubmitted\" | \"submitted\" | \"unknown\"")]
    pub submission_state: String,
    pub status: SystemRuntimeOperationStatus,
    pub native_input_resumed: bool,
    pub restart_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRoleReloadReceiptRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub input_epoch: u64,
    #[ts(type = "number")]
    pub surface_generation: u64,
    pub before_document_instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_document_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub navigation_sequence: Option<u64>,
    #[ts(type = "\"notSubmitted\" | \"submitted\" | \"unknown\"")]
    pub submission_state: String,
    pub status: SystemRuntimeOperationStatus,
    pub native_input_resumed: bool,
    pub core_input_resumed: bool,
    pub restart_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserTabReloadReceiptRecord {
    pub receipt: SystemRuntimeOperationSummaryRecord,
    pub roles: Vec<BrowserRoleReloadReceiptRecord>,
}
