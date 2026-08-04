#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateGameRecord {
    pub id: String,
    #[ts(type = "\"builtin\" | \"custom\"")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"flyff-universe\" | \"feifei-infinite-universe\"")]
    pub builtin_key: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateRoleRecord {
    pub id: String,
    pub game_id: String,
    pub name: String,
    pub launch_url: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_dominant_color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateLaunchWorkspaceRecord {
    pub id: String,
    pub name: String,
    #[ts(
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: String,
    pub slots: Vec<StateWorkspaceSlotRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayTargetRecord {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fingerprint: Option<DisplayFingerprintRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayFingerprintRecord {
    pub label: String,
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub is_internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StatePixelBoundsRecord {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateResolutionRecord {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowPlacementRecord {
    pub normal_bounds: StatePixelBoundsRecord,
    pub saved_work_area: StatePixelBoundsRecord,
    #[ts(type = "\"normal\" | \"maximized\" | \"fullscreen\"")]
    pub presentation: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowRoleViewRecord {
    pub role_id: String,
    pub rect: StateNormalizedRectRecord,
    pub browser_zoom_percent: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowRoleSlotRecord {
    pub slot_id: String,
    pub role_id: String,
    pub rect: StateNormalizedRectRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowTabRecord {
    pub id: String,
    #[ts(type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    pub source_id: String,
    pub name: String,
    pub role_slots: Vec<GameWindowRoleSlotRecord>,
    pub hidden: bool,
    pub audio_muted: bool,
}

impl<'de> Deserialize<'de> for GameWindowTabRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            id: String,
            tab_type: String,
            source_id: String,
            name: String,
            #[serde(default)]
            role_slots: Vec<GameWindowRoleSlotRecord>,
            #[serde(default)]
            role_ids: Vec<String>,
            #[serde(default)]
            role_views: Vec<GameWindowRoleViewRecord>,
            hidden: bool,
            audio_muted: bool,
        }
        let input = Input::deserialize(deserializer)?;
        let role_count = input.role_ids.len().max(1);
        let role_slots = if input.role_slots.is_empty() {
            input
                .role_ids
                .iter()
                .enumerate()
                .map(|(index, role_id)| {
                    let view = input
                        .role_views
                        .iter()
                        .find(|view| view.role_id == *role_id);
                    GameWindowRoleSlotRecord {
                        slot_id: format!("legacy:{index}:{role_id}"),
                        role_id: role_id.clone(),
                        rect: view.map(|view| view.rect.clone()).unwrap_or_else(|| {
                            StateNormalizedRectRecord {
                                x: index as f64 / role_count as f64,
                                y: 0.0,
                                width: 1.0 / role_count as f64,
                                height: 1.0,
                            }
                        }),
                        browser_zoom_percent: view.map(|view| view.browser_zoom_percent),
                    }
                })
                .collect()
        } else {
            input.role_slots
        };
        Ok(Self {
            id: input.id,
            tab_type: input.tab_type,
            source_id: input.source_id,
            name: input.name,
            role_slots,
            hidden: input.hidden,
            audio_muted: input.audio_muted,
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateGameWindowRecord {
    pub id: String,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
    #[serde(default)]
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowCreateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowSaveRuntimeInputRecord {
    pub window_id: String,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowTabSnapshotRecord {
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub revision: u64,
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowRuntimeSnapshotCommitInputRecord {
    pub snapshot: RuntimeWindowTabSnapshotRecord,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowPersistenceReceiptRecord {
    pub window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "\"applied\" | \"superseded\"")]
    pub status: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<DisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placement: Option<GameWindowPlacementRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tabs: Option<Vec<GameWindowTabRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub active_tab_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowDisplayRemapRecord {
    pub window_id: String,
    pub input: GameWindowUpdateInputRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWorkspaceSlotRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub browser_zoom_percent: Option<f64>,
    pub rect: StateNormalizedRectRecord,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateNormalizedRectRecord {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateMacroRecord {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default)]
    pub shortcut_source_scope: MacroShortcutSourceScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWebGraphicsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub renderer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub vendor: Option<String>,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgl: String,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgl2: String,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgpu: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreStateSnapshotRecord {
    #[serde(default)]
    pub games: Vec<StateGameRecord>,
    #[serde(default)]
    pub roles: Vec<StateRoleRecord>,
    #[serde(default)]
    pub launch_workspaces: Vec<StateLaunchWorkspaceRecord>,
    #[serde(default)]
    pub game_windows: Vec<StateGameWindowRecord>,
    #[serde(default)]
    pub macros: Vec<StateMacroRecord>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_browser_settings: Option<GameBrowserSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub macro_settings: Option<MacroSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_window_preferences: Option<RuntimeWindowPreferencesRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_restore_session: Option<RuntimeRestoreSessionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legal_acceptance: Option<LegalAcceptanceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub log_level: Option<LogLevel>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreEvent {
    Ready {
        #[serde(rename = "schemaVersion")]
        #[ts(rename = "schemaVersion")]
        schema_version: u32,
    },
    StateChanged {
        #[ts(type = "number")]
        revision: u64,
        changed_collections: Vec<StateCollection>,
    },
    LogsChanged,
    LogEntriesCaptured {
        entries: Vec<LogEntry>,
    },
    BrowserActions {
        actions: Vec<BrowserActionRequest>,
    },
    CoreEffects {
        effects: Vec<CoreEffectRequest>,
    },
    BrowserStatuses {
        statuses: Vec<BrowserRoleStatusRecord>,
    },
    MacroStatuses {
        reliable: bool,
        statuses: Vec<MacroRunStatus>,
    },
    OverlayChanged {
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
    ChromeProfileImportProgress {
        progress: ChromeProfileImportProgressRecord,
    },
    Shutdown,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserRuntimeCommand {
    Snapshot,
    RegisterWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    RemoveWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    CreateTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "tabId")]
        tab_id: Option<String>,
        #[ts(rename = "sourceId")]
        source_id: String,
        name: String,
        #[ts(rename = "windowId")]
        window_id: String,
        #[serde(rename = "tabType")]
        #[ts(rename = "tabType", type = "\"role\" | \"workspace\"")]
        tab_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "workspaceId")]
        workspace_id: Option<String>,
        #[serde(rename = "roleSlots")]
        #[ts(rename = "roleSlots")]
        role_slots: Vec<RuntimeRoleSlotInputRecord>,
    },
    RemoveTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ActivateTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ShowWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    ActivateAdjacentTab {
        #[ts(rename = "windowId")]
        window_id: String,
        #[ts(type = "\"next\" | \"previous\"")]
        direction: String,
    },
    HideTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ReorderTab {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "beforeTabId")]
        before_tab_id: Option<String>,
    },
    CommitTabDragTopology {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "sourceWindowId")]
        source_window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "targetWindowId")]
        target_window_id: Option<String>,
        #[ts(rename = "sourceBeforeTabIds")]
        source_before_tab_ids: Vec<String>,
        #[ts(rename = "sourceAfterTabIds")]
        source_after_tab_ids: Vec<String>,
        #[ts(rename = "targetBeforeTabIds")]
        target_before_tab_ids: Vec<String>,
        #[ts(rename = "targetAfterTabIds")]
        target_after_tab_ids: Vec<String>,
    },
    MoveTab {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "windowId")]
        window_id: String,
    },
    MoveWindowTabs {
        #[ts(rename = "sourceWindowId")]
        source_window_id: String,
        #[ts(rename = "targetWindowId")]
        target_window_id: String,
    },
    RoleTransition {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "\"embedded\"")]
        runtime: String,
        #[ts(rename = "tabId")]
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "slotId")]
        slot_id: Option<String>,
        #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "launchedAt")]
        launched_at: Option<String>,
    },
    ReleaseRole {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "expectedTabId")]
        expected_tab_id: Option<String>,
    },
    ClaimRoleSlot {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "slotId")]
        slot_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "expectedOwnerGeneration", type = "number")]
        expected_owner_generation: Option<u64>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserOperationRequest {
    pub role_ids: Vec<String>,
    #[ts(type = "\"normal\" | \"recoverableMutation\" | \"destructiveMutation\"")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserOperationLease {
    pub id: String,
    pub role_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRoleInput {
    pub role_id: String,
    pub rect: LayoutRect,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutDividerInput {
    pub axis: String,
    pub before_role_ids: Vec<String>,
    pub after_role_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceLayoutInput {
    pub active: bool,
    pub hidden: bool,
    pub window_visible: bool,
    pub content_bounds: LayoutBounds,
    pub gap: u32,
    pub roles: Vec<LayoutRoleInput>,
    pub dividers: Vec<LayoutDividerInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRoleBounds {
    pub role_id: String,
    pub bounds: LayoutBounds,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutDividerBounds {
    pub index: u32,
    pub bounds: LayoutBounds,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceLayoutOutput {
    pub visible: bool,
    pub roles: Vec<LayoutRoleBounds>,
    pub dividers: Vec<LayoutDividerBounds>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDividerDescriptor {
    #[ts(type = "\"horizontal\" | \"vertical\"")]
    pub axis: String,
    pub before_role_ids: Vec<String>,
    pub after_role_ids: Vec<String>,
    pub default_position: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDividerResizeInput {
    pub roles: Vec<LayoutRoleInput>,
    pub dividers: Vec<WorkspaceDividerDescriptor>,
    pub divider_index: u32,
    pub requested_position: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_position: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDividerResizeOutput {
    pub changed: bool,
    pub position: f64,
    pub role_ids: Vec<String>,
    pub roles: Vec<LayoutRoleInput>,
}
