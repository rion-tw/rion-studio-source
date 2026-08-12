#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameBrowserSettingsRecord {
    pub fonts: BrowserFontSettingsRecord,
    pub macro_badge_position: MacroBadgePositionRecord,
    #[serde(default)]
    pub macro_overlay: MacroOverlaySettingsRecord,
    #[serde(default)]
    pub performance: BrowserPerformanceSettingsRecord,
    pub workspace: WorkspaceAppearanceSettingsRecord,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameBrowserSettingsPatchRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub macro_badge_position: Option<MacroBadgePositionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub macro_overlay: Option<MacroOverlaySettingsPatchRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub performance: Option<BrowserPerformanceSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace: Option<WorkspaceAppearanceSettingsRecord>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserPerformanceSettingsRecord {
    pub macos_high_refresh_rate: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontSettingsRecord {
    #[ts(type = "\"default\" | \"custom\"")]
    pub mode: String,
    #[serde(default = "default_browser_font_smoothing_enabled")]
    pub font_smoothing_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preset_id: Option<String>,
    #[serde(default = "default_browser_font_cjk_variant")]
    #[ts(type = "\"auto\" | \"tc\" | \"sc\" | \"jp\"")]
    pub cjk_variant: String,
    #[serde(default)]
    #[ts(
        type = "Partial<Record<\"cjk\" | \"latin\" | \"numeric\" | \"monospace\" | \"math\", { source: \"system\", family: string } | { source: \"google\", catalogId: string, family?: string }>>"
    )]
    pub slots: std::collections::HashMap<String, BrowserFontSelectionRecord>,
}

fn default_browser_font_cjk_variant() -> String {
    "auto".to_owned()
}

fn default_browser_font_smoothing_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserFontSelectionRecord {
    System {
        family: String,
    },
    Google {
        catalog_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        family: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontCatalogEntryRecord {
    pub catalog_id: String,
    pub family: String,
    #[ts(type = "\"sans\" | \"serif\" | \"handwriting\" | \"display\" | \"monospace\" | \"math\"")]
    pub category: String,
    #[ts(type = "Array<\"latin\" | \"tc\" | \"sc\" | \"jp\" | \"math\">")]
    pub scripts: Vec<String>,
    pub weights: Vec<u16>,
    #[ts(type = "\"body\" | \"accent\" | \"technical\"")]
    pub usage: String,
    pub installed: bool,
    #[ts(type = "number")]
    pub cached_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontInstallResultRecord {
    pub catalog_id: String,
    pub installed: bool,
    #[ts(type = "number")]
    pub cached_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontRuntimeFaceRecord {
    pub catalog_id: String,
    pub family: String,
    pub style: String,
    pub weight: String,
    pub unicode_range: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontRuntimePayloadRecord {
    pub settings: BrowserFontSettingsRecord,
    pub faces: Vec<BrowserFontRuntimeFaceRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroBadgePositionRecord {
    #[ts(type = "\"left\" | \"center\" | \"right\"")]
    pub horizontal_align: String,
    pub horizontal_margin_px: u32,
    pub top_px: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlaySettingsRecord {
    pub show_tool_button: bool,
    pub show_running_badges: bool,
    pub show_click_markers: bool,
}

impl<'de> Deserialize<'de> for MacroOverlaySettingsRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let field = |key| value.get(key).and_then(serde_json::Value::as_bool).unwrap_or(true);
        Ok(Self {
            show_tool_button: field("showToolButton"),
            show_running_badges: field("showRunningBadges"),
            show_click_markers: field("showClickMarkers"),
        })
    }
}

impl Default for MacroOverlaySettingsRecord {
    fn default() -> Self {
        Self {
            show_tool_button: true,
            show_running_badges: true,
            show_click_markers: true,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlaySettingsPatchRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_tool_button: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_running_badges: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_click_markers: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceAppearanceSettingsRecord {
    #[ts(type = "\"material\" | \"black\"")]
    pub background: String,
    #[ts(type = "1 | 2 | 4 | 6 | 8 | 12 | 16")]
    pub gap: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroSettingsRecord {
    pub startup_delay_ms: u32,
    pub key_hold_ms: u32,
    pub post_input_delay_ms: u32,
    pub default_loop_delay_ms: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowPreferencesRecord {
    #[serde(default)]
    pub always_hide_tab_close_button: bool,
    pub always_show_toolbar_in_full_screen: bool,
    #[serde(default = "default_true")]
    pub restore_game_windows_on_startup: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreTabRecord {
    #[ts(type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    pub source_id: String,
    pub name: String,
    pub role_ids: Vec<String>,
    pub hidden: bool,
    pub audio_muted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreWindowRecord {
    pub id: String,
    pub target_display: DisplayTargetRecord,
    pub was_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_source_id: Option<String>,
    pub tabs: Vec<RuntimeRestoreTabRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreSessionRecord {
    pub schema_version: u8,
    #[serde(default)]
    pub session_generation: u32,
    pub updated_at: String,
    pub clean_exit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_focused_window_id: Option<String>,
    #[serde(default)]
    pub restore_in_progress_window_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub live_window_ids: Option<Vec<String>>,
    // Kept only as a one-version migration input. GameWindow records are the
    // authoritative source of restorable windows and tabs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<RuntimeRestoreWindowRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptanceRecord {
    pub accepted_at: String,
    pub accepted_fair_use_version: String,
    pub accepted_terms_version: String,
    pub acknowledged_privacy_version: String,
    pub schema_version: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalDocumentVersionsRecord {
    pub fair_use: String,
    pub privacy: String,
    pub terms: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptDocumentsInputRecord {
    pub fair_use_version: String,
    pub privacy_version: String,
    pub terms_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptanceStatusRecord {
    pub current_versions: LegalDocumentVersionsRecord,
    pub is_accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_fair_use_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_terms_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub acknowledged_privacy_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemFontFamilyRecord {
    pub family: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsGraphicsEventRecord {
    pub event_id: u32,
    pub provider: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsGraphicsEventCollectionRecord {
    pub available: bool,
    pub events: Vec<WindowsGraphicsEventRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum LogSource {
    Main,
    Preload,
    Renderer,
    Ipc,
    Browser,
    Macro,
    Persistence,
    Update,
}

impl LogSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Preload => "preload",
            Self::Renderer => "renderer",
            Self::Ipc => "ipc",
            Self::Browser => "browser",
            Self::Macro => "macro",
            Self::Persistence => "persistence",
            Self::Update => "update",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogErrorDetails {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cause: Option<Box<LogErrorDetails>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogCaptureRecord {
    pub level: LogLevel,
    pub source: LogSource,
    pub event: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "contextRawJson")]
    pub context_raw_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<LogErrorDetails>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub source: LogSource,
    pub event: String,
    pub message: String,
    pub session_id: String,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "Record<string, unknown>")]
    pub context: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    #[ts(optional)]
    pub error: Option<LogErrorDetails>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogQuery {
    #[serde(default)]
    #[ts(optional)]
    pub levels: Option<Vec<LogLevel>>,
    #[serde(default)]
    #[ts(optional)]
    pub sources: Option<Vec<LogSource>>,
    #[ts(optional)]
    pub from: Option<String>,
    #[ts(optional)]
    pub to: Option<String>,
    #[ts(optional)]
    pub search: Option<String>,
    #[ts(optional)]
    pub cursor: Option<String>,
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogPageRecord {
    pub entries: Vec<LogEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogStorageStatusRecord {
    pub current_level: LogLevel,
    #[ts(type = "number")]
    pub entry_count: u64,
    #[ts(type = "number")]
    pub file_count: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub oldest_timestamp: Option<String>,
    pub newest_timestamp: Option<String>,
    pub retention_days: u32,
    #[ts(type = "number")]
    pub max_bytes: u64,
    pub directory: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DiagnosticDisplayRecord {
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserPerformanceDiagnosticStatus {
    Available,
    NoRunningRole,
    NoVisibleGameWindow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum HighRefreshRateDiagnosticStatus {
    Applied,
    Disabled,
    Unavailable,
    Failed,
    Timeout,
    ScheduleFailed,
    NotApplicable,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserPerformanceSurfaceDiagnosticRecord {
    pub role_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<String>,
    #[ts(type = "\"visible\" | \"hidden\" | \"prerender\" | \"unknown\"")]
    pub document_visibility_state: String,
    pub document_has_focus: bool,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub device_pixel_ratio: f64,
    pub hardware_concurrency: u32,
    pub frame_count: u32,
    pub observed_duration_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub average_fps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub p50_frame_interval_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub p95_frame_interval_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub p99_frame_interval_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub longest_frame_interval_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slow_frame_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub missed_vsync_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub long_task_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub long_task_total_duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub longest_task_ms: Option<f64>,
    pub graphics: StateWebGraphicsRecord,
    pub high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserPerformanceDiagnosticsRecord {
    pub captured_at: String,
    #[ts(type = "\"macos\" | \"windows\"")]
    pub platform: String,
    pub status: BrowserPerformanceDiagnosticStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_id: Option<String>,
    pub window_focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_refresh_rate_hz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub system_low_power_mode_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"nominal\" | \"fair\" | \"serious\" | \"critical\" | \"unknown\""
    )]
    pub system_thermal_state: Option<String>,
    pub high_refresh_rate_requested: bool,
    pub sample_duration_ms: u32,
    pub surfaces: Vec<BrowserPerformanceSurfaceDiagnosticRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ApplicationDiagnosticsSnapshotRecord {
    pub application_name: String,
    pub application_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub build_commit: Option<String>,
    pub packaged: bool,
    pub engine: ResolvedBrowserEngine,
    pub engine_version: String,
    pub shell: String,
    pub shell_version: String,
    pub locale: String,
    pub system_version: String,
    pub displays: Vec<DiagnosticDisplayRecord>,
    pub gpu_feature_status_raw_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gpu_info_raw_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_performance: Option<BrowserPerformanceDiagnosticsRecord>,
    pub native_runtime: SystemRuntimeDiagnosticsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DiagnosticExportResultRecord {
    pub file_path: String,
    pub log_file_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum TelemetryMetric {
    IpcCommand,
    MacroScheduleToDispatch,
    TabActivation,
    WorkspaceLaunch,
    MainEventLoopDelay,
    RendererRaf,
    Cdp,
    CoreEventBatch,
    BrowserResult,
    ProcessLaunch,
    ScheduledWait,
    LayoutPass,
    RuntimePublish,
    MenuRefresh,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct TelemetrySampleRecord {
    pub metric: TelemetryMetric,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<f64>,
    #[serde(default = "default_telemetry_count")]
    pub count: u32,
}

fn default_telemetry_count() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LatencySummaryRecord {
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub sample_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CountedLatencySummaryRecord {
    #[ts(type = "number")]
    pub message_count: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub latency: LatencySummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PerformanceTelemetryRecord {
    #[ts(type = "number")]
    pub browser_result_count: u64,
    pub cdp: CountedLatencySummaryRecord,
    #[ts(type = "number")]
    pub core_event_batch_count: u64,
    pub ipc_command: LatencySummaryRecord,
    #[ts(type = "number")]
    pub layout_pass_count: u64,
    pub macro_schedule_to_dispatch: LatencySummaryRecord,
    pub main_event_loop_delay: LatencySummaryRecord,
    #[ts(type = "number")]
    pub menu_refresh_count: u64,
    pub core_effects: CoreEffectMetricsRecord,
    #[ts(type = "number")]
    pub process_launch_count: u64,
    pub renderer_raf: LatencySummaryRecord,
    #[ts(type = "number")]
    pub scheduled_wait_count: u64,
    pub started_at: String,
    pub tab_activation: LatencySummaryRecord,
    #[ts(type = "number")]
    pub runtime_publish_count: u64,
    pub workspace_launch: LatencySummaryRecord,
}
