#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlayStartSummaryRecord {
    pub skipped_count: u32,
    pub started_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlayViewModelRecord {
    #[serde(default)]
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"en\" | \"zh-TW\" | \"zh-CN\" | \"ja\"")]
    pub language: Option<String>,
    pub macro_badge_position: MacroBadgePositionRecord,
    pub macro_overlay: MacroOverlaySettingsRecord,
    pub macros: Vec<MacroDefinition>,
    pub shortcut_macro_ids: Vec<String>,
    pub shortcut_statuses: Vec<MacroRunStatus>,
    #[ts(type = "\"light\" | \"dark\"")]
    pub resolved_theme: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_summary: Option<MacroOverlayStartSummaryRecord>,
    pub statuses: Vec<MacroRunStatus>,
}

#[cfg(test)]
mod command_tests {
    use serde_json::json;

    use super::{BrowserPerformanceDiagnosticsRecord, CoreCommand, CoreEvent, StateCollection};

    #[test]
    fn enum_fields_use_the_generated_camel_case_contract() {
        let command = serde_json::from_value::<CoreCommand>(json!({
            "type": "macroStop",
            "macroId": "macro-1"
        }))
        .unwrap();
        assert!(matches!(command, CoreCommand::MacroStop { macro_id } if macro_id == "macro-1"));

        let event = serde_json::to_value(CoreEvent::OverlayChanged {
            role_ids: vec!["role-1".to_owned()],
        })
        .unwrap();
        assert_eq!(event["roleIds"], json!(["role-1"]));
        assert!(event.get("role_ids").is_none());

        let state_changed = serde_json::to_value(CoreEvent::StateChanged {
            revision: 4,
            changed_collections: vec![StateCollection::Roles, StateCollection::LaunchWorkspaces],
        })
        .unwrap();
        assert_eq!(
            state_changed["changedCollections"],
            json!(["roles", "launchWorkspaces"])
        );
    }

    #[test]
    fn diagnostics_export_requires_async_dispatch() {
        let command = serde_json::from_value::<CoreCommand>(json!({
            "type": "diagnosticsExport",
            "path": "diagnostics.zip",
            "snapshot": {
                "applicationName": "Rion Studio",
                "applicationVersion": "test",
                "packaged": true,
                "engine": "wkwebview",
                "engineVersion": "test",
                "shell": "tauri",
                "shellVersion": "test",
                "locale": "en",
                "systemVersion": "macos",
                "displays": [],
                "gpuFeatureStatusRawJson": "{}",
                "nativeRuntime": {
                    "contractVersion": 2,
                    "platform": "macos",
                    "healthy": true,
                    "snapshotComplete": true,
                    "collectionErrorCodes": [],
                    "nativeCreationLimit": 2,
                    "recentFailures": []
                }
            }
        }))
        .unwrap();

        assert!(command.requires_async_dispatch());
        assert!(matches!(
            command,
            CoreCommand::DiagnosticsExport { snapshot, .. }
                if snapshot.native_runtime.healthy
                    && snapshot.native_runtime.snapshot_complete
                    && snapshot.native_runtime.shutdown_state == "accepting"
        ));
    }

    #[test]
    fn browser_performance_diagnostics_power_fields_are_optional_and_camel_case() {
        let with_system_state = json!({
            "capturedAt": "2026-07-31T00:00:00Z",
            "platform": "macos",
            "status": "available",
            "windowFocused": true,
            "displayRefreshRateHz": 144.0,
            "systemLowPowerModeEnabled": true,
            "systemThermalState": "serious",
            "highRefreshRateRequested": true,
            "sampleDurationMs": 1500,
            "surfaces": []
        });
        let record =
            serde_json::from_value::<BrowserPerformanceDiagnosticsRecord>(with_system_state)
                .unwrap();
        assert_eq!(record.system_low_power_mode_enabled, Some(true));
        assert_eq!(record.system_thermal_state.as_deref(), Some("serious"));
        let serialized = serde_json::to_value(record).unwrap();
        assert_eq!(serialized["systemLowPowerModeEnabled"], json!(true));
        assert_eq!(serialized["systemThermalState"], json!("serious"));
        assert!(serialized.get("system_low_power_mode_enabled").is_none());

        let legacy = serde_json::from_value::<BrowserPerformanceDiagnosticsRecord>(json!({
            "capturedAt": "2026-07-31T00:00:00Z",
            "platform": "macos",
            "status": "noRunningRole",
            "windowFocused": false,
            "highRefreshRateRequested": false,
            "sampleDurationMs": 1500,
            "surfaces": []
        }))
        .unwrap();
        assert_eq!(legacy.system_low_power_mode_enabled, None);
        assert_eq!(legacy.system_thermal_state, None);
    }
}
