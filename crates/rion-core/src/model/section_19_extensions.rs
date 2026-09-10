#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExtensionSnapshotRecord {
    #[ts(type = "number")]
    pub revision: u64,
    pub installed: Vec<ExtensionPackageRecord>,
    pub roles: Vec<ExtensionRoleRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExtensionPackageRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "iconDataUrl")]
    pub icon_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "sizeBytes", type = "number")]
    pub size_bytes: Option<u64>,
    pub permissions: Vec<String>,
    pub sha256: String,
    pub directory: String,
    pub enabled_role_ids: Vec<String>,
    #[serde(default)]
    pub apply_to_all_roles: bool,
    pub removed: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExtensionRoleRecord {
    pub role_id: String,
    pub lease_id: String,
    pub extension_ids: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExtensionPreparedRecord {
    pub operation_id: String,
    pub package: ExtensionPackageRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ExtensionCommand {
    Snapshot,
    Prepare {
        id: String,
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    Install {
        operation_id: String,
        role_ids: Vec<String>,
        #[serde(default)]
        apply_to_all_roles: bool,
    },
    Configure {
        id: String,
        role_ids: Vec<String>,
        #[serde(default)]
        apply_to_all_roles: bool,
    },
    Remove {
        id: String,
    },
    Acquire {
        role_id: String,
    },
    Complete {
        role_id: String,
        lease_id: String,
        status: String,
    },
    Release {
        role_id: String,
        lease_id: String,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExtensionResultRecord {
    pub snapshot: ExtensionSnapshotRecord,
    pub prepared: Option<ExtensionPreparedRecord>,
    pub lease: Option<ExtensionRoleRecord>,
}
