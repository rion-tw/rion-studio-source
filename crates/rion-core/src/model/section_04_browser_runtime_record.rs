#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeWindowRecord {
    pub window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeTabRecord {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub window_id: String,
    #[serde(rename = "tabType")]
    #[ts(rename = "tabType", type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub slots: Vec<RuntimeRoleSlotRecord>,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRoleSlotInputRecord {
    pub slot_id: String,
    pub role_id: String,
    pub rect: StateNormalizedRectRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
}

impl<'de> Deserialize<'de> for RuntimeRoleSlotInputRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input {
            RoleId(String),
            Slot {
                #[serde(rename = "slotId")]
                slot_id: String,
                #[serde(rename = "roleId")]
                role_id: String,
                rect: StateNormalizedRectRecord,
                #[serde(rename = "browserZoomPercent")]
                #[serde(default)]
                browser_zoom_percent: Option<f64>,
            },
        }
        Ok(match Input::deserialize(deserializer)? {
            Input::RoleId(role_id) => Self {
                slot_id: format!("role:{role_id}"),
                role_id,
                rect: StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                browser_zoom_percent: Some(100.0),
            },
            Input::Slot {
                slot_id,
                role_id,
                rect,
                browser_zoom_percent,
            } => Self {
                slot_id,
                role_id,
                rect,
                browser_zoom_percent,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeRoleOwnerRecord {
    pub tab_id: String,
    pub slot_id: String,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRoleSlotRecord {
    pub slot_id: String,
    pub role_id: String,
    pub rect: StateNormalizedRectRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\" | \"blocked\" | \"available\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub owner: Option<BrowserRuntimeRoleOwnerRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeRoleRecord {
    pub role_id: String,
    #[ts(type = "\"embedded\"")]
    pub runtime: String,
    pub owner: BrowserRuntimeRoleOwnerRecord,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launched_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeWorkspaceRecord {
    pub workspace_id: String,
    pub name: String,
    #[ts(type = "\"embedded\"")]
    pub runtime: String,
    pub window_id: String,
    pub tab_id: String,
    pub role_ids: Vec<String>,
    #[ts(type = "\"launching\" | \"running\" | \"partial\" | \"stopping\"")]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeSnapshot {
    pub windows: Vec<BrowserRuntimeWindowRecord>,
    pub roles: Vec<BrowserRuntimeRoleRecord>,
    pub tabs: Vec<BrowserRuntimeTabRecord>,
    pub workspaces: Vec<BrowserRuntimeWorkspaceRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_tab_id: Option<String>,
    #[serde(default)]
    pub tab_created: bool,
    pub snapshot: BrowserRuntimeSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreAppSnapshotRecord {
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub state_revision: u64,
    #[ts(type = "number")]
    pub runtime_revision: u64,
    pub state: CoreStateSnapshotRecord,
    pub browser_runtime: BrowserRuntimeSnapshot,
    pub logical_windows: Vec<RuntimeWindowTabSnapshotRecord>,
    pub role_statuses: Vec<BrowserRoleStatusRecord>,
    pub macro_statuses: Vec<MacroRunStatus>,
}
