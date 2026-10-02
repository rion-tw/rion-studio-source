fn role_zoom_effect_result(effect: CoreEffectRequest) -> CoreEffectResult {
    let value = match &effect.action {
        CoreEffectAction::EmbeddedSetRuntimeRoleZoom { request, zoom_factor, .. } => {
            assert_eq!(effect.completion_policy, crate::model::OperationCompletionPolicy::EventBound);
            assert!(effect.deadline_ms.is_none());
            let mut receipt = json!({ "request": request, "zoomFactor": zoom_factor });
            // JSON.stringify emits integral JS numbers without a decimal suffix.
            if request.previous_zoom_factor == 1.0 { receipt["request"]["previousZoomFactor"] = json!(1); }
            if *zoom_factor == 1.0 { receipt["zoomFactor"] = json!(1); }
            Some(receipt.to_string())
        }
        _ => None,
    };
    let mut result = effect_result(effect, None);
    result.value_json = value;
    result
}

#[test]
fn runtime_role_zoom_is_exact_replayable_and_preserves_workspace_siblings() {
    for platform in ["win32", "darwin"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        }).unwrap();
        let game = first_game_id(&core);
        let first = create_role(&core, &game, 1);
        let second = create_role(&core, &game, 2);
        let workspace = core.invoke(command(json!({"type": "workspaceCreate", "input": {
            "name": "Independent zoom", "template": "two_columns", "slots": [
                {"roleId": first, "browserZoomPercent": 100, "rect": workspace_rect(0, 2)},
                {"roleId": second, "browserZoomPercent": 125, "rect": workspace_rect(1, 2)}
            ]
        }}))).unwrap();
        let (tab_id, _, _) = launch_divider_workspace(Arc::clone(&core), workspace["id"].as_str().unwrap(), "zoom-window");
        for (index, (action, previous, next)) in [
            ("in", 1.0, 1.05), ("out", 1.05, 1.0), ("reset", 1.0, 1.0)
        ].into_iter().enumerate() {
            let before = core.browser_runtime.snapshot().unwrap();
            let window = &before.windows["zoom-window"];
            let owner = before.browser_runtime.roles.iter().find(|role| role.role_id == first).unwrap();
            let request = crate::model::RuntimeRoleZoomRequestRecord {
                operation_id: format!("role-zoom-{index}"), window_id: "zoom-window".to_owned(),
                tab_id: tab_id.clone(), role_id: first.clone(), window_generation: window.window_generation,
                topology_revision: window.revision, owner_generation: owner.owner.generation,
                surface_generation: 1, previous_zoom_factor: previous, action: action.to_owned(),
            };
            let command = CoreCommand::BrowserRuntimeRoleZoom { request: request.clone() };
            let (result, actions) = drive_command_with(Arc::clone(&core), command.clone(), role_zoom_effect_result);
            let receipt = result.unwrap();
            assert_eq!(receipt["status"], "applied", "{platform}: {receipt}");
            assert_eq!(receipt["roleId"], first);
            assert!(actions.iter().any(|action| matches!(action,
                CoreEffectAction::EmbeddedSetRuntimeRoleZoom { request, zoom_factor, .. }
                if request.role_id == first && *zoom_factor == next)));
            assert!(!actions.iter().any(|action| matches!(action, CoreEffectAction::EmbeddedSetRuntimeWindowZoom { .. })));
            let after = core.browser_runtime.snapshot().unwrap();
            let committed = &after.windows["zoom-window"];
            assert_eq!(committed.window_zoom_factor, window.window_zoom_factor);
            let slots = &committed.tabs.iter().find(|tab| tab.id == tab_id).unwrap().role_slots;
            assert_eq!(slots.iter().find(|slot| slot.role_id == first).unwrap().browser_zoom_percent, Some(next * 100.0));
            assert_eq!(slots.iter().find(|slot| slot.role_id == second).unwrap().browser_zoom_percent, Some(125.0));
            let (replay, effects) = drive_command_with(Arc::clone(&core), command, role_zoom_effect_result);
            assert_eq!(replay.unwrap(), receipt);
            assert!(effects.is_empty());
            let stale = CoreCommand::BrowserRuntimeRoleZoom { request: crate::model::RuntimeRoleZoomRequestRecord {
                operation_id: format!("stale-{index}"), owner_generation: owner.owner.generation + 1, ..request
            }};
            let (rejected, effects) = drive_command_with(Arc::clone(&core), stale, role_zoom_effect_result);
            assert_eq!(rejected.unwrap()["status"], "superseded");
            assert!(effects.is_empty());
        }
        for (failure, status, effect_count) in [
            ("rejected", "failed", 1), ("unknown", "indeterminate", 1),
            ("wrong-role", "failed", 2), ("unknown-rollback", "indeterminate", 2),
        ] {
            let before = core.browser_runtime.snapshot().unwrap();
            let window = &before.windows["zoom-window"];
            let owner = before.browser_runtime.roles.iter().find(|role| role.role_id == first).unwrap();
            let request = crate::model::RuntimeRoleZoomRequestRecord {
                operation_id: format!("failure-{failure}"), window_id: "zoom-window".to_owned(),
                tab_id: tab_id.clone(), role_id: first.clone(), window_generation: window.window_generation,
                topology_revision: window.revision, owner_generation: owner.owner.generation,
                surface_generation: 1, previous_zoom_factor: 1.0, action: "in".to_owned(),
            };
            let command = CoreCommand::BrowserRuntimeRoleZoom { request };
            let mut native_calls = 0;
            let (result, actions) = drive_command_with(Arc::clone(&core), command.clone(), |effect| {
                if !matches!(effect.action, CoreEffectAction::EmbeddedSetRuntimeRoleZoom { .. }) {
                    return effect_result(effect, None);
                }
                native_calls += 1;
                if matches!(failure, "rejected" | "unknown") {
                    let mut result = effect_result(effect, Some("other"));
                    if failure == "unknown" {
                        result.error.as_mut().unwrap().code = "ELECTRON_RUNTIME_ROLE_ZOOM_COMPENSATION_UNKNOWN".to_owned();
                    }
                    return result;
                }
                let mut result = role_zoom_effect_result(effect);
                if native_calls == 1 || failure == "unknown-rollback" {
                    let mut receipt: Value = serde_json::from_str(result.value_json.as_ref().unwrap()).unwrap();
                    receipt["request"]["roleId"] = json!(second);
                    result.value_json = Some(receipt.to_string());
                }
                result
            });
            let receipt = result.unwrap();
            assert_eq!(receipt["status"], status, "{platform}/{failure}: {receipt}");
            assert_eq!(native_calls, effect_count);
            assert_eq!(actions.len(), effect_count);
            let after = core.browser_runtime.snapshot().unwrap();
            assert_eq!(after.windows["zoom-window"].revision, window.revision);
            let slots = &after.windows["zoom-window"].tabs.iter().find(|tab| tab.id == tab_id).unwrap().role_slots;
            assert_eq!(slots.iter().find(|slot| slot.role_id == first).unwrap().browser_zoom_percent, Some(100.0));
            assert_eq!(slots.iter().find(|slot| slot.role_id == second).unwrap().browser_zoom_percent, Some(125.0));
            let (replay, effects) = drive_command_with(Arc::clone(&core), command, role_zoom_effect_result);
            assert_eq!(replay.unwrap(), receipt);
            assert!(effects.is_empty());
        }
        core.shutdown();
    }
}
