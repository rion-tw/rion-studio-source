#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ManagedShortcutPhaseReceiptRecord {
    pub code: String,
    pub document_instance_id: String,
    #[ts(type = "number")]
    pub expected_owner_generation: u64,
    pub macro_id: String,
    pub operation_id: String,
    #[ts(type = "\"replay\" | \"keyDown\" | \"keyUp\"")]
    pub phase: String,
    pub press_id: String,
    pub request_ids: Vec<String>,
    pub role_id: String,
    #[ts(type = "\"accepted\" | \"duplicate\" | \"superseded\"")]
    pub status: String,
    #[ts(type = "number")]
    pub surface_generation: u64,
    pub tab_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ManagedShortcutSurfaceRetirementReceiptRecord {
    pub cleanup_request_ids: Vec<String>,
    pub document_instance_id: String,
    pub retired_press_ids: Vec<String>,
    pub role_id: String,
    #[ts(type = "number")]
    pub surface_generation: u64,
    #[ts(type = "true")]
    pub terminal: bool,
}
