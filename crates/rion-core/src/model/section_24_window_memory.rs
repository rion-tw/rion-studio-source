/// Device-local window memory. It never enters portable data: displays and
/// window geometry describe this machine, not the user's game library.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowMemoryRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub main_window: Option<MainWindowMemoryRecord>,
    /// Newest first. Keys are `role:<id>`, `workspace:<id>` for transient
    /// Game Windows and `window:<id>` for a saved Game Window's zoom.
    #[serde(default)]
    pub sources: Vec<SourceWindowMemoryRecord>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MainWindowMemoryRecord {
    pub bounds: StatePixelBoundsRecord,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SourceWindowMemoryRecord {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<DisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placement: Option<GameWindowPlacementRecord>,
    #[serde(default = "default_window_memory_zoom_factor")]
    pub window_zoom_factor: f64,
    pub updated_at: String,
}

fn default_window_memory_zoom_factor() -> f64 {
    1.0
}
