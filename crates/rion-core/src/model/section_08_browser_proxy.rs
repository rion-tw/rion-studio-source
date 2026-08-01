#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserProxyEndpointRecord {
    #[ts(type = "\"http\" | \"socks5\"")]
    pub protocol: String,
    pub host: String,
    pub port: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserProxySettingsRecord {
    #[ts(type = "\"system\" | \"custom\"")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom: Option<BrowserProxyEndpointRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserProxyDiagnosticsRecord {
    #[ts(type = "\"system\" | \"custom\"")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"http\" | \"socks5\"")]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<u32>,
    #[ts(type = "\"bypassed\" | \"pending\" | \"succeeded\" | \"failed\"")]
    pub preflight_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub preflight_duration_ms: Option<u64>,
    #[ts(type = "\"notApplied\" | \"pending\" | \"applied\" | \"failed\"")]
    pub platform_apply_status: String,
    #[ts(type = "number")]
    pub fingerprint_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_error_code: Option<String>,
}
