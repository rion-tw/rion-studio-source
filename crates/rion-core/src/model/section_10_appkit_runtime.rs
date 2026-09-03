#[derive(Debug, Clone, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeHostIdentityRecord {
    pub logical_window_id: String,
    pub launch_generation: String,
    pub native_generation: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeHostObservationRecord {
    pub identity: AppKitRuntimeHostIdentityRecord,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub content_bounds: LayoutBounds,
    pub normal_bounds: StatePixelBoundsRecord,
    pub saved_work_area: StatePixelBoundsRecord,
    pub target_display: DisplayTargetRecord,
    #[ts(type = "\"normal\" | \"maximized\" | \"fullscreen\"")]
    pub presentation: String,
    pub focused: bool,
    pub minimized: bool,
    pub visible: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum AppKitRuntimeEventActionRecord {
    Activate {
        tab_id: String,
    },
    Stop {
        tab_id: String,
        ordered_tab_ids: Vec<String>,
    },
    Reorder {
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        before_tab_id: Option<String>,
    },
    Move {
        session_id: String,
        tab_id: String,
        source_window_id: String,
        target_window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        before_tab_id: Option<String>,
        ordered_tab_ids: Vec<String>,
        #[ts(type = "\"hover\" | \"drop\"")]
        phase: String,
    },
    SetTabHidden {
        tab_id: String,
        hidden: bool,
    },
    SetWindowVisibility {
        visible: bool,
    },
    CloseWindow,
    WindowState {
        #[ts(type = "number")]
        placement_sequence: u64,
    },
    Layout {
        #[ts(type = "number")]
        layout_sequence: u64,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeEventRecord {
    pub event_id: String,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    pub hosts: Vec<AppKitRuntimeHostObservationRecord>,
    pub action: AppKitRuntimeEventActionRecord,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeTabProjectionRecord {
    pub tab_id: String,
    pub name: String,
    pub phase: RuntimeTabActivationPhaseRecord,
    #[serde(rename = "tabType")]
    #[ts(rename = "tabType", type = "\"role\" | \"workspace\" | \"popup\"")]
    pub tab_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_template: Option<String>,
    pub audio_muted: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeRoleLayoutRecord {
    pub role_id: String,
    pub tab_id: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    pub bounds: LayoutBounds,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeWebSurfaceLayoutRecord {
    pub surface_id: String,
    pub slot_id: String,
    pub tab_id: String,
    pub attempt_generation: String,
    pub bounds: LayoutBounds,
    pub visible: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeWorkspaceDividerLayoutRecord {
    pub tab_id: String,
    pub attempt_generation: String,
    pub divider_index: u32,
    #[ts(type = "\"horizontal\" | \"vertical\"")]
    pub axis: String,
    pub bounds: LayoutBounds,
    pub visible: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeWindowProjectionRecord {
    pub identity: AppKitRuntimeHostIdentityRecord,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    pub logical_tab_ids: Vec<String>,
    pub hidden_tab_ids: Vec<String>,
    pub tabs: Vec<AppKitRuntimeTabProjectionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    pub roles: Vec<AppKitRuntimeRoleLayoutRecord>,
    pub web_surfaces: Vec<AppKitRuntimeWebSurfaceLayoutRecord>,
    pub workspace_dividers: Vec<AppKitRuntimeWorkspaceDividerLayoutRecord>,
    pub window_visible: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeProjectionEffectRecord {
    pub event_id: String,
    pub windows: Vec<AppKitRuntimeWindowProjectionRecord>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct AppKitRuntimeEventReceiptRecord {
    pub event_id: String,
    #[ts(type = "number")]
    pub adapter_sequence: u64,
    pub status: SystemRuntimeOperationStatus,
    pub topology_committed: bool,
    pub native_applied: bool,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}
