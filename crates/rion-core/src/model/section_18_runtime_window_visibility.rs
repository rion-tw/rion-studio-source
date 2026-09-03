#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowVisibilityNativeObservationRecord {
    #[ts(type = "\"macos\" | \"windows\"")]
    pub platform: String,
    #[ts(
        type = "\"blur\" | \"closed\" | \"failed\" | \"focus\" | \"hide\" | \"initial\" | \"minimize\" | \"restore\" | \"show\""
    )]
    pub source: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    pub logical_window_id: String,
    #[ts(type = "number")]
    pub native_host_id: u64,
    #[ts(type = "number")]
    pub native_generation: u64,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
    pub foreground: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub appkit_identity: Option<AppKitRuntimeHostIdentityRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowVisibilityNativeReceiptRecord {
    pub effect_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "\"applied\" | \"superseded\"")]
    pub status: String,
    pub windows: Vec<RuntimeWindowVisibilityNativeObservationRecord>,
}
