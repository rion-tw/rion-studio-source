fn launch_chromium_audio_test_tab(
    core: Arc<AppCore>,
) -> (
    crate::model::BrowserRuntimeTabRecord,
    Vec<crate::model::EmbeddedTabAudioMuteRoleEffectRecord>,
) {
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let (launched, actions) = drive_command(
        Arc::clone(&core),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "windowId": "audio-window-1",
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    launched.unwrap();
    let created_tab = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab),
            _ => None,
        })
        .expect("launch must create an exact Chromium tab");
    assert!(!created_tab.audio_muted);

    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.source_id == role_id)
        .cloned()
        .unwrap();
    let roles = browser_tab_audio_role_fences(&snapshot, &tab.id);
    assert_eq!(roles.len(), 1);
    (tab, roles)
}

fn failed_audio_effect(
    effect: CoreEffectRequest,
    code: &str,
) -> CoreEffectResult {
    CoreEffectResult {
        effect_id: effect.effect_id,
        operation_id: effect.operation_id,
        ok: false,
        value_json: None,
        error: Some(CoreErrorPayload {
            code: code.to_owned(),
            message: "The native audio fixture rejected the effect.".to_owned(),
        }),
    }
}

#[test]
fn chromium_tab_audio_is_core_owned_exact_and_event_bound() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    let (tab, expected_roles) = launch_chromium_audio_test_tab(Arc::clone(&core));
    let expected_attempt = tab.attempt_generation.clone().unwrap();
    let expected_tab_id = tab.id.clone();
    let expected_window_id = tab.window_id.clone();

    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::BrowserTabAudioMute {
            tab_id: tab.id.clone(),
            muted: true,
        },
        |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedSetTabAudioMuted { .. }) {
                assert_eq!(
                    effect.completion_policy,
                    crate::model::OperationCompletionPolicy::EventBound
                );
                assert_eq!(effect.deadline_ms, None);
                assert!(effect.parent_operation_id.is_some());
            }
            effect_result(effect, None)
        },
    );
    let summary = result.unwrap();
    assert_eq!(summary["status"], "applied");
    assert_eq!(summary["completionPolicy"], "eventBound");
    assert_eq!(summary["completionScope"], "nativeAcknowledgement");
    assert_eq!(summary["subsystem"], "audio");
    assert_eq!(summary["deadlineAt"], Value::Null);
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetTabAudioMuted {
            tab_id,
            window_id,
            attempt_generation,
            roles,
            web_surfaces,
            previous_muted: false,
            muted: true,
        } if tab_id == &expected_tab_id
            && window_id == &expected_window_id
            && attempt_generation == &expected_attempt
            && roles == &expected_roles
            && web_surfaces.is_empty()
    )));
    let snapshot = core
        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
        .unwrap()
        .snapshot;
    assert!(snapshot.tabs.iter().find(|tab| tab.id == expected_tab_id).unwrap().audio_muted);
    core.shutdown();
}

#[test]
fn chromium_tab_audio_compensates_failure_and_marks_unknown_native_rollback() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    let (tab, _) = launch_chromium_audio_test_tab(Arc::clone(&core));
    let (applied, _, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserTabAudioMute {
            tab_id: tab.id.clone(),
            muted: true,
        },
        None,
    );
    assert_eq!(applied.unwrap()["status"], "applied");

    for (failure_code, expected_status) in [
        ("NATIVE_AUDIO_APPLY_FAILED", "failed"),
        ("BROWSER_RUNTIME_AUDIO_ROLLBACK_FAILED", "indeterminate"),
    ] {
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::BrowserTabAudioMute {
                tab_id: tab.id.clone(),
                muted: false,
            },
            |effect| failed_audio_effect(effect, failure_code),
        );
        let summary = result.unwrap();
        assert_eq!(summary["status"], expected_status);
        assert_eq!(summary["failureCode"], failure_code);
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.tabs.iter().find(|item| item.id == tab.id).unwrap().audio_muted);
    }
    core.shutdown();
}

#[test]
fn web_only_chromium_tab_audio_uses_exact_non_managed_surface_fences() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let workspace_id = create_web_only_workspace(&core, "Audio Web Only");
    let (launch, actions) = drive_command(
        Arc::clone(&core),
        web_workspace_launch(&workspace_id, "audio-web-window"),
        None,
    );
    assert_eq!(launch.unwrap(), json!([]));
    let tab_id = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .unwrap();
    let tab = core
        .browser_runtime_snapshot()
        .unwrap()
        .tabs
        .into_iter()
        .find(|tab| tab.id == tab_id)
        .unwrap();
    assert!(tab.slots.is_empty());
    assert_eq!(tab.web_surfaces.len(), 1);

    let (muted, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserTabAudioMute {
            tab_id: tab.id.clone(),
            muted: true,
        },
        None,
    );
    assert_eq!(muted.unwrap()["status"], "applied");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetTabAudioMuted {
            tab_id,
            roles,
            web_surfaces,
            muted: true,
            ..
        } if tab_id == &tab.id && roles.is_empty() && web_surfaces == &tab.web_surfaces
    )));
    assert!(core.browser_runtime_snapshot().unwrap().roles.is_empty());
    assert!(core
        .browser_runtime_snapshot()
        .unwrap()
        .tabs
        .iter()
        .find(|item| item.id == tab.id)
        .unwrap()
        .audio_muted);
    core.shutdown();
}

#[test]
fn mixed_chromium_tab_audio_fences_managed_roles_and_web_surfaces_separately() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let workspace_id = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "Audio Mixed",
                "template": "two_columns",
                "slots": [
                    {
                        "id": "managed-audio",
                        "roleId": role_id,
                        "rect": workspace_rect(0, 2)
                    },
                    {
                        "id": "web-audio",
                        "web": {"name": "Audio Web", "startUrl": "https://audio.example.test"},
                        "rect": workspace_rect(1, 2)
                    }
                ]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (launch, launch_actions) = drive_command(
        Arc::clone(&core),
        web_workspace_launch(&workspace_id, "audio-mixed-window"),
        None,
    );
    assert_eq!(launch.unwrap().as_array().unwrap().len(), 1);
    let tab_id = launch_actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .unwrap();
    let snapshot = core.browser_runtime_snapshot().unwrap();
    let tab = snapshot.tabs.iter().find(|tab| tab.id == tab_id).unwrap();
    let expected_roles = browser_tab_audio_role_fences(&snapshot, &tab_id);
    assert_eq!(expected_roles.len(), 1);
    assert_eq!(tab.web_surfaces.len(), 1);

    let (muted, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserTabAudioMute {
            tab_id: tab_id.clone(),
            muted: true,
        },
        None,
    );
    assert_eq!(muted.unwrap()["status"], "applied");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::EmbeddedSetTabAudioMuted {
            roles,
            web_surfaces,
            ..
        } if roles == &expected_roles
            && web_surfaces == &tab.web_surfaces
            && web_surfaces[0].slot_id == "web-audio"
    )));
    assert_eq!(core.browser_statuses().unwrap().len(), 1);
    assert_eq!(core.browser_statuses().unwrap()[0].role_id, role_id);
    core.shutdown();
}
