use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
    #[serde(default)]
    pub build_commit: Option<String>,
    #[serde(default)]
    pub packaged: bool,
    #[serde(default)]
    pub runtime_contract_version: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ResolvedBrowserEngine {
    Webview2,
    Wkwebview,
    Chromium,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserHostKind {
    SystemNative,
    AppkitChromium,
    BundledChromium,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum EngineCapabilityStatus {
    Supported,
    Degraded,
    Unsupported,
    Disabled,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum SystemWebViewIssueReason {
    WebkitSpiUnavailable,
    MacroInputUnavailable,
    RuntimeCreationFailed,
    RuntimeCrashed,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserRuntimeFailureReason {
    TrustedInputUnavailable,
    MacroInputUnavailable,
    SessionMigrationRequired,
    RuntimeCreationFailed,
    RuntimeCrashed,
}

impl From<SystemWebViewIssueReason> for BrowserRuntimeFailureReason {
    fn from(reason: SystemWebViewIssueReason) -> Self {
        match reason {
            SystemWebViewIssueReason::WebkitSpiUnavailable => Self::TrustedInputUnavailable,
            SystemWebViewIssueReason::MacroInputUnavailable => Self::MacroInputUnavailable,
            SystemWebViewIssueReason::RuntimeCreationFailed => Self::RuntimeCreationFailed,
            SystemWebViewIssueReason::RuntimeCrashed => Self::RuntimeCrashed,
        }
    }
}

impl From<BrowserRuntimeFailureReason> for SystemWebViewIssueReason {
    fn from(reason: BrowserRuntimeFailureReason) -> Self {
        match reason {
            BrowserRuntimeFailureReason::TrustedInputUnavailable => Self::WebkitSpiUnavailable,
            BrowserRuntimeFailureReason::MacroInputUnavailable => Self::MacroInputUnavailable,
            // Contract v22 has no session-migration launch state. This arm is
            // unreachable for a valid v22 registration/status projection and
            // remains fail-closed if a caller crosses that contract boundary.
            BrowserRuntimeFailureReason::SessionMigrationRequired => Self::RuntimeCreationFailed,
            BrowserRuntimeFailureReason::RuntimeCreationFailed => Self::RuntimeCreationFailed,
            BrowserRuntimeFailureReason::RuntimeCrashed => Self::RuntimeCrashed,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EngineCapabilitySnapshotRecord {
    pub navigation: EngineCapabilityStatus,
    pub persistent_session: EngineCapabilityStatus,
    pub trusted_input: EngineCapabilityStatus,
    pub background_input: EngineCapabilityStatus,
    pub frame_evaluation: EngineCapabilityStatus,
    pub popup: EngineCapabilityStatus,
    pub audio_mute: EngineCapabilityStatus,
    pub custom_fonts: EngineCapabilityStatus,
    pub downloads: EngineCapabilityStatus,
    pub file_upload: EngineCapabilityStatus,
    pub permissions: EngineCapabilityStatus,
    pub dialogs: EngineCapabilityStatus,
    pub certificate_handling: EngineCapabilityStatus,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserEngineResolutionRecord {
    pub resolved_engine: ResolvedBrowserEngine,
    pub host_kind: BrowserHostKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue_reason: Option<BrowserRuntimeFailureReason>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemWebViewProbeRecord {
    pub platform: String,
    pub engine: ResolvedBrowserEngine,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_version: Option<String>,
    pub public_api_available: bool,
    pub macro_input_available: bool,
    pub audio_mute_available: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemWebViewRuntimeRegistrationRecord {
    pub platform: String,
    pub engine: ResolvedBrowserEngine,
    pub adapter_version: String,
    pub available: bool,
    pub capability_snapshot: EngineCapabilitySnapshotRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_reason: Option<SystemWebViewIssueReason>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeRegistrationRecord {
    pub contract_version: u32,
    #[ts(type = "\"macos\" | \"windows\"")]
    pub platform: String,
    pub engine: ResolvedBrowserEngine,
    pub adapter_version: String,
    pub available: bool,
    pub capabilities: EngineCapabilitySnapshotRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_reason: Option<BrowserRuntimeFailureReason>,
}

#[cfg(test)]
mod browser_runtime_failure_reason_tests {
    use super::*;

    #[test]
    fn legacy_system_webview_reasons_map_explicitly_to_generic_runtime_reasons() {
        for (legacy, generic, serialized) in [
            (
                SystemWebViewIssueReason::WebkitSpiUnavailable,
                BrowserRuntimeFailureReason::TrustedInputUnavailable,
                "trusted-input-unavailable",
            ),
            (
                SystemWebViewIssueReason::MacroInputUnavailable,
                BrowserRuntimeFailureReason::MacroInputUnavailable,
                "macro-input-unavailable",
            ),
            (
                SystemWebViewIssueReason::RuntimeCreationFailed,
                BrowserRuntimeFailureReason::RuntimeCreationFailed,
                "runtime-creation-failed",
            ),
            (
                SystemWebViewIssueReason::RuntimeCrashed,
                BrowserRuntimeFailureReason::RuntimeCrashed,
                "runtime-crashed",
            ),
        ] {
            assert_eq!(BrowserRuntimeFailureReason::from(legacy), generic);
            assert_eq!(SystemWebViewIssueReason::from(generic), legacy);
            assert_eq!(serde_json::to_value(generic).unwrap(), serialized);
        }
        assert_eq!(
            serde_json::to_value(BrowserRuntimeFailureReason::SessionMigrationRequired).unwrap(),
            "session-migration-required"
        );
        assert_eq!(
            SystemWebViewIssueReason::from(
                BrowserRuntimeFailureReason::SessionMigrationRequired
            ),
            SystemWebViewIssueReason::RuntimeCreationFailed
        );
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileEntryRecord {
    pub id: String,
    pub directory_name: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub existing_role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub existing_role_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportPreviewRecord {
    pub import_id: String,
    pub source_label: String,
    pub source_in_use: bool,
    pub profiles: Vec<ChromeProfileEntryRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromeProfileImportResolutionRecord {
    Create {
        profile_id: String,
    },
    Copy {
        profile_id: String,
    },
    Replace {
        profile_id: String,
        target_role_id: String,
    },
}

impl ChromeProfileImportResolutionRecord {
    pub fn profile_id(&self) -> &str {
        match self {
            Self::Create { profile_id }
            | Self::Copy { profile_id }
            | Self::Replace { profile_id, .. } => profile_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookieRecord {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageEntryRecord {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTransferPayloadRecord {
    pub cookies: Vec<SessionCookieRecord>,
    pub local_storage: Vec<LocalStorageEntryRecord>,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromeProfileImportAuthStateRecord {
    Authenticated,
    NotAuthenticated,
    Indeterminate,
    NotApplicable,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportUnsupportedCountsRecord {
    pub partitioned_cookie_count: u32,
    pub app_bound_cookie_count: u32,
    pub decrypt_failure_count: u32,
    pub storage_read_failure_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportItemResultRecord {
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    pub role_name: String,
    #[ts(
        type = "\"imported\" | \"needsLogin\" | \"alreadyAuthenticated\" | \"failed\" | \"cancelled\""
    )]
    pub status: String,
    pub auth_state: ChromeProfileImportAuthStateRecord,
    pub cookie_count: u32,
    pub local_storage_count: u32,
    pub unsupported: ChromeProfileImportUnsupportedCountsRecord,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportResultRecord {
    pub import_id: String,
    pub items: Vec<ChromeProfileImportItemResultRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportProgressRecord {
    pub import_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_id: Option<String>,
    pub phase: String,
    pub completed: u32,
    pub total: u32,
}
