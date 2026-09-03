#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserWorkspaceDividerPointerPhase {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserWorkspaceDividerPlatform {
    Macos,
    Windows,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserWorkspaceDividerHostIdentityRecord {
    Appkit {
        identity: AppKitRuntimeHostIdentityRecord,
    },
    Windows {
        native_host_id: u32,
        #[ts(type = "number")]
        host_generation: u64,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserWorkspaceDividerPointerRecord {
    pub event_id: String,
    pub gesture_id: String,
    #[ts(type = "number")]
    pub pointer_sequence: u64,
    pub phase: BrowserWorkspaceDividerPointerPhase,
    pub platform: BrowserWorkspaceDividerPlatform,
    pub host_identity: BrowserWorkspaceDividerHostIdentityRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub appkit_host: Option<AppKitRuntimeHostObservationRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub appkit_adapter_sequence: Option<u64>,
    pub window_id: String,
    pub tab_id: String,
    pub attempt_generation: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub divider_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub requested_position: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserWorkspaceDividerPointerReceiptRecord {
    pub event_id: String,
    pub gesture_id: String,
    #[ts(type = "number")]
    pub pointer_sequence: u64,
    pub phase: BrowserWorkspaceDividerPointerPhase,
    pub status: SystemRuntimeOperationStatus,
    pub changed: bool,
    pub durable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<f64>,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub workspace_slots: Vec<StateWorkspaceSlotRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRuntimeWorkspaceTabProjectionRecord {
    pub tab_id: String,
    pub workspace_slots: Vec<StateWorkspaceSlotRecord>,
}
