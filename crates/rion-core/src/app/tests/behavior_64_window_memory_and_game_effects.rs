fn window_memory_zoom_command(
    operation_id: &str,
    window: &crate::RuntimeLiveWindowRecord,
    action: &str,
    zoom_factor: Option<f64>,
) -> CoreCommand {
    CoreCommand::BrowserRuntimeWindowZoom {
        operation_id: operation_id.to_owned(),
        window_id: window.window_id.clone(),
        window_generation: window.window_generation,
        topology_revision: window.revision,
        action: action.to_owned(),
        zoom_factor,
    }
}

#[test]
fn restore_zoom_applies_an_absolute_factor_and_remembers_the_launch_source() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let window = seed_runtime_window_zoom(&core, platform);
        for (action, zoom) in [("restore", None), ("restore", Some(9.0)), ("in", Some(1.2))] {
            let error = core
                .invoke(window_memory_zoom_command("invalid-restore", &window, action, zoom))
                .unwrap_err();
            assert_eq!(error.code(), "RUNTIME_WINDOW_ZOOM_ACTION_INVALID", "{platform} {action}");
        }
        let (result, _) = drive_command_with(
            Arc::clone(&core),
            window_memory_zoom_command("memory-restore", &window, "restore", Some(1.25)),
            runtime_window_zoom_effect_result,
        );
        let receipt: crate::model::RuntimeWindowZoomReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.status, "applied", "{platform}: {receipt:?}");
        assert_eq!(receipt.next_zoom_factor, 1.25, "{platform}");
        // The transient window's launch source remembers the committed zoom.
        let memory = core.window_memory().unwrap();
        let entry = memory
            .sources
            .iter()
            .find(|entry| entry.key == "role:zoom-role")
            .expect("source memory");
        assert_eq!(entry.window_zoom_factor, 1.25, "{platform}");
        assert_eq!(
            core.read_typed_snapshot().unwrap().window_memory.unwrap().sources[0].key,
            "role:zoom-role",
            "{platform}"
        );
        core.shutdown();
    }
}

#[test]
fn main_window_memory_is_validated_and_exposed_in_the_state_snapshot() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    let record = crate::model::MainWindowMemoryRecord {
        bounds: crate::model::StatePixelBoundsRecord { x: -40, y: 30, width: 1265, height: 793 },
        maximized: true,
    };
    core.invoke(CoreCommand::MainWindowMemoryReplace { record: record.clone() }).unwrap();
    let snapshot = core.read_typed_snapshot().unwrap();
    assert_eq!(snapshot.window_memory.unwrap().main_window, Some(record));
    let invalid = core
        .invoke(CoreCommand::MainWindowMemoryReplace {
            record: crate::model::MainWindowMemoryRecord {
                bounds: crate::model::StatePixelBoundsRecord { x: 0, y: 0, width: 10, height: 10 },
                maximized: false,
            },
        })
        .unwrap_err();
    assert_eq!(invalid.code(), "CORE_INPUT_INVALID");
    let memory: crate::model::WindowMemoryRecord =
        serde_json::from_value(core.invoke(CoreCommand::WindowMemoryGet).unwrap()).unwrap();
    assert!(memory.main_window.unwrap().maximized);
    core.shutdown();
}

#[test]
fn window_memory_normalization_drops_invalid_and_duplicate_sources_and_caps_its_size() {
    let entry = |key: &str, zoom: f64| crate::model::SourceWindowMemoryRecord {
        key: key.to_owned(),
        target_display: None,
        placement: None,
        window_zoom_factor: zoom,
        updated_at: String::new(),
    };
    let mut sources = vec![
        entry("role:a", 1.1),
        entry("role:a", 1.2),
        entry("tab:a", 1.0),
        entry("workspace:", 1.0),
        entry("window:w", f64::NAN),
        entry("window:w", 7.0),
    ];
    sources.extend((0..100).map(|index| entry(&format!("role:r{index}"), 1.0)));
    let memory = normalize_window_memory(crate::model::WindowMemoryRecord {
        main_window: Some(crate::model::MainWindowMemoryRecord {
            bounds: crate::model::StatePixelBoundsRecord { x: 0, y: 0, width: 50, height: 50 },
            maximized: false,
        }),
        sources,
    });
    assert!(memory.main_window.is_none());
    assert_eq!(memory.sources.len(), WINDOW_MEMORY_SOURCE_LIMIT);
    assert_eq!(memory.sources[0].key, "role:a");
    assert_eq!(memory.sources[0].window_zoom_factor, 1.1);
    assert!(memory.sources.iter().all(|source| source.key != "window:w"));
}

#[test]
fn game_effect_settings_patch_validate_and_default_for_older_records() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    let defaults: GameBrowserSettingsRecord =
        serde_json::from_value(core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap()).unwrap();
    assert_eq!(defaults.effects, crate::model::GameEffectSettingsRecord::default());
    assert!(!defaults.effects.enabled);
    let effects = crate::model::GameEffectSettingsRecord {
        enabled: true,
        level: "heavy".to_owned(),
        dim_bright_skills: false,
        hide_hit_effects: true,
    };
    let patched: GameBrowserSettingsRecord = serde_json::from_value(
        core.invoke(CoreCommand::GameBrowserSettingsPatch {
            patch: GameBrowserSettingsPatchRecord {
                effects: Some(effects.clone()),
                ..Default::default()
            },
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(patched.effects, effects);
    assert_eq!(patched.workspace, defaults.workspace);
    let mut invalid = patched.clone();
    invalid.effects.level = "blinding".to_owned();
    assert_eq!(
        validate_game_browser_settings(&invalid).unwrap_err().code(),
        "CORE_INPUT_INVALID"
    );
    assert_eq!(normalize_game_browser_settings(invalid).effects.level, "medium");
    // Records written before effects existed deserialize to the disabled default.
    let mut legacy = serde_json::to_value(&defaults).unwrap();
    legacy.as_object_mut().unwrap().remove("effects");
    let legacy: GameBrowserSettingsRecord = serde_json::from_value(legacy).unwrap();
    assert_eq!(legacy.effects, crate::model::GameEffectSettingsRecord::default());
    core.shutdown();
}
