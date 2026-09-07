use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum RoleSessionRecoveryCommand {
    Inspect {
        role_id: String,
    },
    Recover {
        role_id: String,
        attempt_id: String,
        #[ts(type = "number | null")]
        expected_journal_revision: Option<u64>,
        source_token: String,
    },
    Upgrade {
        role_id: String,
        attempt_id: String,
        #[ts(type = "number | null")]
        expected_journal_revision: Option<u64>,
    },
    Cancel {
        role_id: String,
        attempt_id: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionRecoveryCandidate {
    pub token: String,
    pub application: String,
    pub kind: String,
    pub supported: bool,
    pub blockers: Vec<String>,
    #[ts(type = "number | null")]
    pub cookie_count: Option<usize>,
    #[ts(type = "number")]
    pub local_storage_origin_count: usize,
    #[ts(type = "number | null")]
    pub local_storage_entry_count: Option<usize>,
    pub other_website_data_present: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionUpgradeResult {
    pub cookies: String,
    pub local_storage: String,
    #[ts(type = "number")]
    pub cookie_count: usize,
    #[ts(type = "number")]
    pub local_storage_origin_count: usize,
    #[ts(type = "number")]
    pub local_storage_entry_count: usize,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleSessionRecoveryRecord {
    pub role_id: String,
    pub attempt_id: Option<String>,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number | null")]
    pub journal_revision: Option<u64>,
    pub phase: String,
    pub blockers: Vec<String>,
    pub candidates: Vec<RoleSessionRecoveryCandidate>,
    pub source_integrity: String,
    pub target_equality: String,
    pub persistence: String,
    pub login: String,
    #[serde(default)]
    pub upgrade_result: Option<Box<RoleSessionUpgradeResult>>,
}
