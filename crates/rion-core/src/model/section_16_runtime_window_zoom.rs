#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowZoomNativeReceiptRecord {
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub previous_zoom_factor: f64,
    pub next_zoom_factor: f64,
    #[ts(type = "number")]
    pub role_surface_count: u64,
    #[ts(type = "number")]
    pub global_web_surface_count: u64,
    #[ts(type = "number")]
    pub popup_surface_count: u64,
    #[ts(type = "\"applied\"")]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowZoomReceiptRecord {
    pub operation_id: String,
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub source_topology_revision: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[ts(type = "\"in\" | \"out\" | \"reset\"")]
    pub action: String,
    pub previous_zoom_factor: f64,
    pub next_zoom_factor: f64,
    #[ts(type = "\"applied\" | \"superseded\" | \"failed\" | \"indeterminate\"")]
    pub status: String,
    #[ts(type = "number")]
    pub role_surface_count: u64,
    #[ts(type = "number")]
    pub global_web_surface_count: u64,
    #[ts(type = "number")]
    pub popup_surface_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}
