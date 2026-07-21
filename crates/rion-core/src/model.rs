use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CoreCommand {
    Health,
    StateSnapshot,
    StateReplace { key: String, value: Value },
    StateReplaceSnapshot { snapshot: Value },
    CdnReplaceRules { rules: Vec<CdnRule> },
    CdnRewriteUrl { url: String },
    ResourceResolve { input: ResourcePolicyInput },
    LogsAppend { entries: Vec<LogEntry> },
    LogsQuery { query: LogQuery },
    LogsClear,
    LogsStatus,
    LogsExport,
    LogsExportTo { path: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
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
    },
    LogsChanged,
    PressureChanged {
        snapshot: SystemPressureSnapshot,
    },
    BrowserActions {
        actions: Vec<BrowserActionRequest>,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CdnRule {
    pub id: String,
    pub regex_filter: String,
    pub regex_substitution: String,
    pub source_host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum PressureLevel {
    Normal,
    Constrained,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemPressureSnapshot {
    pub level: PressureLevel,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourcePolicyInput {
    pub policy_mode: String,
    pub workspace_hidden: bool,
    pub macro_active: bool,
    pub shares_process_with_macro: bool,
    pub pressure_level: PressureLevel,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourcePolicyDecision {
    pub cpu_throttle_rate: u8,
    pub resource_state: String,
    pub resource_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub event: String,
    pub message: String,
    pub session_id: String,
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(default)]
    pub levels: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub search: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub role_id: String,
    #[ts(type = "number")]
    pub deadline_ms: u64,
    pub action: BrowserAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserAction {
    Focus,
    Key {
        phase: String,
        key: String,
        code: Option<String>,
        modifiers: Vec<String>,
    },
    Click {
        x: f64,
        y: f64,
        button: String,
    },
    Evaluate {
        source: String,
    },
    Cookies {
        operation: String,
        #[serde(rename = "payloadJson")]
        #[ts(rename = "payloadJson")]
        payload_json: String,
    },
    Session {
        operation: String,
        #[serde(rename = "payloadJson")]
        #[ts(rename = "payloadJson")]
        payload_json: String,
    },
    Debugger {
        method: String,
        #[serde(rename = "paramsJson")]
        #[ts(rename = "paramsJson")]
        params_json: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionResult {
    pub request_id: String,
    pub ok: bool,
    pub value_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}
