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

    use super::{CoreCommand, CoreEvent, StateCollection};

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

}
