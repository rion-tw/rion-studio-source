#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableDataRecord {
    #[ts(type = "\"Rion Studio\"")]
    pub app: String,
    #[ts(type = "13")]
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub games: Vec<PortableGameRecord>,
    pub roles: Vec<PortableRoleRecord>,
    pub launch_workspaces: Vec<PortableLaunchWorkspaceRecord>,
    #[serde(default)]
    pub game_windows: Vec<PortableGameWindowRecord>,
    pub macros: Vec<PortableMacroRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportOperationSummaryRecord {
    pub create: u32,
    pub update: u32,
    pub unchanged: u32,
    pub skip: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportOperationsRecord {
    pub games: PortableImportOperationSummaryRecord,
    pub roles: PortableImportOperationSummaryRecord,
    pub launch_workspaces: PortableImportOperationSummaryRecord,
    pub game_windows: PortableImportOperationSummaryRecord,
    pub macros: PortableImportOperationSummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportWarningRecord {
    #[ts(
        type = "\"GAME_NAME_RENAMED\" | \"BUILTIN_GAME_DEFAULTS_REPLACED\" | \"ROLE_GAME_RECOVERED\" | \"ROLE_NAME_RENAMED\" | \"ROLE_LOCAL_STORAGE_SOURCE_MISSING\" | \"ROLE_LOCAL_STORAGE_BINDING_INVALID\" | \"WORKSPACE_NAME_RENAMED\" | \"WORKSPACE_ROLE_MISSING\" | \"GAME_WINDOW_NAME_RENAMED\" | \"GAME_WINDOW_TAB_DEPENDENCY_MISSING\" | \"GAME_WINDOW_TAB_ROLE_CONFLICT\" | \"MACRO_NAME_RENAMED\" | \"MACRO_ROLE_MISSING\" | \"MACRO_SHORTCUT_CLEARED_CONFLICT\" | \"MACRO_SHORTCUT_CLEARED_RESERVED\" | \"MACRO_SKIPPED_NO_ROLES\" | \"MACRO_SKIPPED_MISSING_DEPENDENCY\""
    )]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replacement_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableMacroConflictCandidateRecord {
    pub id: String,
    pub name: String,
    pub role_names: Vec<String>,
    pub step_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableMacroConflictRecord {
    pub id: String,
    pub macro_id: String,
    pub name: String,
    pub role_names: Vec<String>,
    pub candidates: Vec<PortableMacroConflictCandidateRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportPreviewRecord {
    pub import_id: String,
    pub file_path: String,
    pub exported_at: String,
    pub app_version: String,
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub game_window_count: u32,
    pub macro_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
    pub operations: PortableImportOperationsRecord,
    pub conflicts: Vec<PortableMacroConflictRecord>,
    pub warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportResultRecord {
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub game_window_count: u32,
    pub macro_count: u32,
    pub preferences_included: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
    pub selection: PortableDataSelectionRecord,
    pub operations: PortableImportOperationsRecord,
    pub warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableExportResultRecord {
    pub file_path: String,
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub game_window_count: u32,
    pub macro_count: u32,
    pub preferences_included: bool,
    pub selection: PortableDataSelectionRecord,
}

/// Renderer-facing game creation contract. The similarly named `*InputRecord`
/// types below are private command payloads and may contain presence flags used
/// to preserve `undefined` versus `null` across the typed desktop bridge.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameCreateRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
    #[serde(default)]
    pub local_storage_sync_keys: Vec<String>,
    #[serde(default)]
    pub local_storage_sync_selectors: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_sync_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_sync_selectors: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleCreateRequest {
    pub game_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_dominant_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_source_role_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_dominant_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub local_storage_source_role_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RolePathsRecord {
    pub browser_user_data_dir: String,
    pub system_browser_data_dir: String,
    pub webview2_user_data_dir: String,
    pub webkit_data_store_key: String,
    pub webkit_data_store_identifier: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceSlotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rect: Option<StateNormalizedRectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceCreateRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotRequest>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotRequest>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroCreateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    pub steps: Vec<MacroStepDefinition>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steps: Option<Vec<MacroStepDefinition>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameCreateInputRecord {
    pub name: String,
    pub default_launch_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub local_storage_sync_keys: Vec<String>,
    #[serde(default)]
    pub local_storage_sync_selectors: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_image_data_url: Option<String>,
    #[serde(default)]
    pub set_icon_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub set_cover_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_sync_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_sync_selectors: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleCreateInputRecord {
    pub game_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_dominant_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_source_role_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub set_cover_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_dominant_color: Option<String>,
    #[serde(default)]
    pub set_cover_image_dominant_color: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_storage_source_role_id: Option<String>,
    #[serde(default)]
    pub set_local_storage_source_role_id: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleGameAssignmentRecord {
    pub role_id: String,
    pub game_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceSlotInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rect: Option<StateNormalizedRectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceCreateInputRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotInputRecord>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotInputRecord>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayInfoRecord {
    #[ts(type = "number")]
    pub id: i64,
    pub label: String,
    pub bounds: StatePixelBoundsRecord,
    pub work_area: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub is_internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroStepInputRecord {
    Key {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        code: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        action: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
    Click {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        anchor: Option<String>,
        #[serde(rename = "xPercent")]
        #[ts(rename = "xPercent")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        x_percent: Option<f64>,
        #[serde(rename = "yPercent")]
        #[ts(rename = "yPercent")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        y_percent: Option<f64>,
        #[serde(rename = "xPx")]
        #[ts(rename = "xPx")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        x_px: Option<f64>,
        #[serde(rename = "yPx")]
        #[ts(rename = "yPx")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        y_px: Option<f64>,
    },
    Delay {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        ms: u32,
    },
    Macro {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        #[serde(rename = "macroId")]
        #[ts(rename = "macroId")]
        macro_id: String,
        #[serde(rename = "callMode")]
        #[ts(rename = "callMode")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        call_mode: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroCreateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    pub steps: Vec<MacroStepInputRecord>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default)]
    pub set_trigger: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steps: Option<Vec<MacroStepInputRecord>>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum StateCollection {
    Games,
    Roles,
    LaunchWorkspaces,
    GameWindows,
    Macros,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BulkDeleteSkippedItemRecord {
    pub id: String,
    #[ts(type = "\"protected\" | \"in_use\" | \"not_found\" | \"busy\" | \"failed\"")]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub related_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BulkDeleteResultRecord {
    pub deleted_ids: Vec<String>,
    pub skipped: Vec<BulkDeleteSkippedItemRecord>,
}
