/// A privileged, event-bound tab gesture. Native adapters supply observations;
/// RuntimeKernel retains the session and resolves the current topology owner.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabDragEventRecord {
    pub session_id: String,
    pub tab_id: String,
    pub source_window_id: String,
    #[ts(type = "number")]
    pub source_window_generation: u64,
    #[ts(type = "number")]
    pub lifecycle_epoch: u64,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "\"start\" | \"sample\" | \"bindFloating\" | \"end\" | \"cancel\" | \"fail\"")]
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floating_window_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeTabDragReceiptRecord {
    pub session_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "\"applied\" | \"superseded\" | \"cancelled\" | \"indeterminate\"")]
    pub status: String,
    pub terminal: bool,
    pub single_tab: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floating_window_id: Option<String>,
}
