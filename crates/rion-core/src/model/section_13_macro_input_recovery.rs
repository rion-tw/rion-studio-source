#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputRecoveryTicketRecord {
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub pending_macro_restart_count: u32,
    pub recovery_id: String,
    pub role_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputRecoveryCompletionReceiptRecord {
    pub deferred_count: u32,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub recovery_id: String,
    pub restarted_count: u32,
    pub role_id: String,
    pub skipped_count: u32,
    pub terminal: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputRecoveryFailureReceiptRecord {
    pub failed: bool,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub recovery_id: String,
    pub restart_required: bool,
    pub role_id: String,
}
