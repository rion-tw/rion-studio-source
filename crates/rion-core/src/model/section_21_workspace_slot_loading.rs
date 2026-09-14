// Runtime-only slot load receipts. Rust owns state; shells report exact native events.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceSlotLoadRecord {
    pub tab_id: String,
    pub slot_id: String,
    pub surface_id: String,
    pub window_id: String,
    pub attempt_generation: String,
    pub load_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub surface_generation: u64,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = r#""loading" | "ready" | "failed""#)]
    pub phase: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub loading_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_label: Option<String>,
}
