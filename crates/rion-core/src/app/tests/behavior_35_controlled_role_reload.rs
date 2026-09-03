#[derive(Clone)]
struct ControlledReloadSeed {
    role_ids: Vec<String>,
    tab_id: String,
    window_generation: u64,
    window_id: String,
    topology_revision: u64,
}

#[derive(Clone, Copy)]
enum ControlledReloadPrepareMode {
    Applied,
    Failed,
    Partial,
    WrapperInvalid,
}

#[derive(Clone, Copy)]
enum ControlledReloadCommitMode {
    Applied,
    Unknown,
    WrapperInvalid,
    Rejected,
}

#[derive(Clone, Copy)]
enum ControlledReloadCleanupMode {
    Released,
    Unreleased,
    Malformed,
}

struct ControlledReloadResponder {
    cleanup_mode: ControlledReloadCleanupMode,
    commit_mode: ControlledReloadCommitMode,
    fences: Vec<crate::model::EmbeddedRoleReloadFenceRecord>,
    prepare_mode: ControlledReloadPrepareMode,
}

fn seed_controlled_role_reload(core: &AppCore, suffix: &str) -> ControlledReloadSeed {
    let tab_id = uuid::Uuid::new_v4().to_string();
    let window_id = format!("controlled-reload-window-{suffix}");
    let role_ids = vec![
        format!("controlled-reload-role-a-{suffix}"),
        format!("controlled-reload-role-b-{suffix}"),
    ];
    let role_id_refs = role_ids.iter().map(String::as_str).collect::<Vec<_>>();
    core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
        tab_id: Some(tab_id.clone()),
        source_id: role_ids[0].clone(),
        name: "Controlled reload".to_owned(),
        tab_type: "role".to_owned(),
        workspace_id: None,
        audio_muted: false,
        attempt_generation: Some(format!("controlled-reload-attempt-{suffix}")),
        window_id: window_id.clone(),
        role_slots: test_role_slots(&role_id_refs),
        web_surfaces: Vec::new(),
    })
    .unwrap();
    for role_id in &role_ids {
        for state in ["launching", "running"] {
            core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                tab_id: tab_id.clone(),
                slot_id: None,
                state: state.to_owned(),
                launched_at: (state == "running").then(|| chrono::Utc::now().to_rfc3339()),
            })
            .unwrap();
        }
    }
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: format!("controlled-reload-seed-{suffix}"),
            source: "command".to_owned(),
            primary_window_id: window_id.clone(),
            windows: vec![crate::RuntimeWindowTopologyCommit {
                active_tab_id: Some(tab_id.clone()),
                hidden_tab_ids: std::collections::HashSet::new(),
                tabs: vec![crate::RuntimeLiveTabRecord {
                    audio_muted: false,
                    closable: true,
                    icon_data_url: None,
                    id: tab_id.clone(),
                    persistable: true,
                    role_ids: role_ids.clone(),
                    role_slots: Vec::new(),
                    workspace_slots: Vec::new(),
                    source_id: role_ids[0].clone(),
                    tab_type: "role".to_owned(),
                    title: "Controlled reload".to_owned(),
                    workspace_template: None,
                }],
                ui_sequence: 1,
                window_generation: 3,
                window_id: window_id.clone(),
            }],
        },
    ))
    .unwrap();
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get(&window_id).unwrap();
    ControlledReloadSeed {
        role_ids,
        tab_id,
        window_generation: window.window_generation,
        window_id,
        topology_revision: window.revision,
    }
}

fn controlled_reload_command(operation_id: &str, seed: &ControlledReloadSeed) -> CoreCommand {
    CoreCommand::BrowserRuntimeTabReload {
        operation_id: operation_id.to_owned(),
        tab_id: seed.tab_id.clone(),
        window_id: seed.window_id.clone(),
        window_generation: seed.window_generation,
        topology_revision: seed.topology_revision,
        lifecycle_epoch: 1,
    }
}

fn controlled_reload_effect_result(
    effect: CoreEffectRequest,
    value_json: Option<String>,
    error: Option<crate::error::CoreErrorPayload>,
) -> CoreEffectResult {
    CoreEffectResult {
        effect_id: effect.effect_id,
        operation_id: effect.operation_id,
        ok: true,
        value_json,
        error,
    }
}

impl ControlledReloadResponder {
    fn success() -> Self {
        Self {
            cleanup_mode: ControlledReloadCleanupMode::Released,
            commit_mode: ControlledReloadCommitMode::Applied,
            fences: Vec::new(),
            prepare_mode: ControlledReloadPrepareMode::Applied,
        }
    }

    fn respond(&mut self, effect: CoreEffectRequest) -> CoreEffectResult {
        assert_eq!(
            effect.completion_policy,
            crate::model::OperationCompletionPolicy::EventBound
        );
        assert!(effect.deadline_ms.is_none());
        match effect.action.clone() {
            CoreEffectAction::EmbeddedPrepareTabRoleReload {
                reload_operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
                lifecycle_epoch,
                roles,
            } => {
                self.fences = roles.clone();
                let mut prepared = roles
                    .iter()
                    .enumerate()
                    .map(
                        |(index, role)| crate::model::EmbeddedRoleReloadPreparationRecord {
                            role_id: role.role_id.clone(),
                            owner_generation: role.owner_generation,
                            input_epoch: role.input_epoch,
                            surface_generation: index as u64 + 1,
                            document_instance_id: format!("document-before-{index}"),
                        },
                    )
                    .collect::<Vec<_>>();
                let status = match self.prepare_mode {
                    ControlledReloadPrepareMode::Applied
                    | ControlledReloadPrepareMode::Partial
                    | ControlledReloadPrepareMode::WrapperInvalid => {
                        crate::model::SystemRuntimeOperationStatus::Applied
                    }
                    ControlledReloadPrepareMode::Failed => {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    }
                };
                if matches!(self.prepare_mode, ControlledReloadPrepareMode::Partial) {
                    prepared.pop();
                }
                let value_json = serde_json::to_string(
                    &crate::model::EmbeddedTabRoleReloadPreparationReceiptRecord {
                        reload_operation_id,
                        tab_id,
                        window_id,
                        window_generation,
                        topology_revision,
                        lifecycle_epoch,
                        status,
                        roles: prepared,
                        failure_code: (status
                            != crate::model::SystemRuntimeOperationStatus::Applied)
                            .then(|| "NATIVE_PREPARE_FAILED".to_owned()),
                    },
                )
                .unwrap();
                let wrapper_error = matches!(
                    self.prepare_mode,
                    ControlledReloadPrepareMode::WrapperInvalid
                )
                .then(|| crate::error::CoreErrorPayload {
                    code: "IMPOSSIBLE_SUCCESS_ERROR".to_owned(),
                    message: "success carried an error".to_owned(),
                });
                controlled_reload_effect_result(effect, Some(value_json), wrapper_error)
            }
            CoreEffectAction::EmbeddedCommitTabRoleReload {
                reload_operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
                lifecycle_epoch,
                roles,
                managed_shortcut_retirements,
            } => {
                assert_eq!(managed_shortcut_retirements.len(), roles.len());
                assert!(managed_shortcut_retirements.iter().zip(&roles).all(
                    |(retirement, role)| retirement.role_id == role.role_id
                        && retirement.surface_generation == role.surface_generation
                        && retirement.document_instance_id == role.document_instance_id
                        && retirement.terminal
                ));
                if matches!(self.commit_mode, ControlledReloadCommitMode::Rejected) {
                    return CoreEffectResult {
                        effect_id: effect.effect_id,
                        operation_id: effect.operation_id,
                        ok: false,
                        value_json: None,
                        error: Some(crate::error::CoreErrorPayload {
                            code: "NATIVE_COMMIT_REJECTED".to_owned(),
                            message: "native commit rejected".to_owned(),
                        }),
                    };
                }
                let applied = matches!(
                    self.commit_mode,
                    ControlledReloadCommitMode::Applied
                        | ControlledReloadCommitMode::WrapperInvalid
                );
                let status = if applied {
                    crate::model::SystemRuntimeOperationStatus::Applied
                } else {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                };
                let native_roles = roles
                    .iter()
                    .enumerate()
                    .map(
                        |(index, role)| crate::model::EmbeddedRoleReloadNativeReceiptRecord {
                            role_id: role.role_id.clone(),
                            owner_generation: role.owner_generation,
                            input_epoch: role.input_epoch,
                            surface_generation: role.surface_generation,
                            before_document_instance_id: role.document_instance_id.clone(),
                            after_document_instance_id: applied
                                .then(|| format!("document-after-{index}")),
                            navigation_sequence: applied.then_some(index as u64 + 1),
                            submission_state: if applied {
                                "submitted".to_owned()
                            } else {
                                "unknown".to_owned()
                            },
                            status,
                            native_input_resumed: applied,
                            restart_required: !applied,
                            failure_code: (!applied)
                                .then(|| "NATIVE_NAVIGATION_UNKNOWN".to_owned()),
                        },
                    )
                    .collect();
                controlled_reload_effect_result(
                    effect,
                    Some(
                        serde_json::to_string(
                            &crate::model::EmbeddedTabRoleReloadNativeReceiptRecord {
                                reload_operation_id,
                                tab_id,
                                window_id,
                                window_generation,
                                topology_revision,
                                lifecycle_epoch,
                                status,
                                roles: native_roles,
                                failure_code: (!applied)
                                    .then(|| "NATIVE_NAVIGATION_UNKNOWN".to_owned()),
                            },
                        )
                        .unwrap(),
                    ),
                    matches!(self.commit_mode, ControlledReloadCommitMode::WrapperInvalid).then(
                        || crate::error::CoreErrorPayload {
                            code: "IMPOSSIBLE_NATIVE_SUCCESS_ERROR".to_owned(),
                            message: "native success carried an error".to_owned(),
                        },
                    ),
                )
            }
            CoreEffectAction::EmbeddedSupersedeTabRoleReload {
                reload_operation_id,
                tab_id,
                role_ids,
                ..
            } => {
                if matches!(self.cleanup_mode, ControlledReloadCleanupMode::Malformed) {
                    return controlled_reload_effect_result(effect, Some("{}".to_owned()), None);
                }
                let released = matches!(self.cleanup_mode, ControlledReloadCleanupMode::Released);
                let status = if released {
                    crate::model::SystemRuntimeOperationStatus::Applied
                } else {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                };
                let mut roles = self
                    .fences
                    .iter()
                    .filter(|role| role_ids.contains(&role.role_id))
                    .map(
                        |role| crate::model::EmbeddedRoleReloadSupersedeReceiptRecord {
                            role_id: role.role_id.clone(),
                            owner_generation: role.owner_generation,
                            input_epoch: role.input_epoch,
                            submission_state: if released {
                                "notSubmitted".to_owned()
                            } else {
                                "unknown".to_owned()
                            },
                            status,
                            native_input_resumed: released,
                            restart_required: !released,
                            failure_code: (!released).then(|| "NATIVE_CLEANUP_UNKNOWN".to_owned()),
                        },
                    )
                    .collect::<Vec<_>>();
                roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
                controlled_reload_effect_result(
                    effect,
                    Some(
                        serde_json::to_string(
                            &crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord {
                                reload_operation_id,
                                tab_id,
                                status,
                                roles,
                                failure_code: (!released)
                                    .then(|| "NATIVE_CLEANUP_UNKNOWN".to_owned()),
                            },
                        )
                        .unwrap(),
                    ),
                    None,
                )
            }
            action => panic!("unexpected controlled reload effect: {action:?}"),
        }
    }
}

fn assert_controlled_reload_roles_resumed(core: &AppCore, role_ids: &[String]) {
    let diagnostics = core.macro_input_diagnostics().unwrap();
    for role_id in role_ids {
        let role = diagnostics
            .roles
            .iter()
            .find(|role| &role.role_id == role_id)
            .unwrap();
        assert!(!role.quiesced, "{role:?}");
        assert!(!role.restart_required, "{role:?}");
    }
}

#[test]
fn controlled_role_reload_is_event_bound_applied_and_replayable_on_both_hosts() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, platform);
        let operation_id = format!("controlled-reload-success-{platform}");
        let command = controlled_reload_command(&operation_id, &seed);
        let mut responder = ControlledReloadResponder::success();
        let (result, actions, _) =
            drive_async_command_with(Arc::clone(&core), command.clone(), |effect| {
                responder.respond(effect)
            });
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied,
            "{platform}: {receipt:?}"
        );
        assert_eq!(
            receipt.receipt.completion_policy,
            crate::model::OperationCompletionPolicy::EventBound
        );
        assert!(receipt.receipt.deadline_at.is_none());
        assert!(receipt.receipt.timeout_ms.is_none());
        assert!(receipt.roles.iter().all(|role| {
            role.status == crate::model::SystemRuntimeOperationStatus::Applied
                && role.submission_state == "submitted"
                && role.native_input_resumed
                && role.core_input_resumed
                && !role.restart_required
        }));
        assert!(matches!(
            actions.as_slice(),
            [
                CoreEffectAction::EmbeddedPrepareTabRoleReload { .. },
                CoreEffectAction::EmbeddedCommitTabRoleReload { .. }
            ]
        ));
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);

        core.replace_browser_runtime_registration(chromium_registration(platform, false))
            .unwrap();
        let (replay, replay_actions, _) =
            drive_async_command_with(Arc::clone(&core), command.clone(), |_| {
                panic!("terminal replay emitted a native effect")
            });
        let replay: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(replay.unwrap()).unwrap();
        assert_eq!(replay, receipt);
        assert!(replay_actions.is_empty());

        let reused = CoreCommand::BrowserRuntimeTabReload {
            operation_id,
            tab_id: seed.tab_id.clone(),
            window_id: seed.window_id.clone(),
            window_generation: seed.window_generation,
            topology_revision: seed.topology_revision,
            lifecycle_epoch: 2,
        };
        let reused = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(core.invoke_async(reused))
            .unwrap_err();
        assert_eq!(reused.code(), "RUNTIME_TAB_RELOAD_OPERATION_ID_REUSED");
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_is_explicitly_unsupported_by_stable_v22() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 22);
        let seed = seed_controlled_role_reload(&core, &format!("v22-{platform}"));
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            controlled_reload_command(&format!("controlled-reload-v22-{platform}"), &seed),
            |_| panic!("stable v22 dispatched a Chromium reload effect"),
        );
        assert_eq!(result.unwrap_err().code(), "RUNTIME_TAB_RELOAD_UNAVAILABLE");
        assert!(actions.is_empty());
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_prepare_failures_cleanup_the_exact_full_role_set() {
    for (index, prepare_mode) in [
        ControlledReloadPrepareMode::Partial,
        ControlledReloadPrepareMode::Failed,
        ControlledReloadPrepareMode::WrapperInvalid,
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, core) = core_for_runtime_contract("win32", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("prepare-{index}"));
        let mut responder = ControlledReloadResponder {
            prepare_mode,
            ..ControlledReloadResponder::success()
        };
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            controlled_reload_command(&format!("controlled-reload-prepare-{index}"), &seed),
            |effect| responder.respond(effect),
        );
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(receipt.roles.len(), seed.role_ids.len());
        assert_ne!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied
        );
        assert!(receipt.roles.iter().all(|role| {
            role.submission_state == "notSubmitted"
                && role.native_input_resumed
                && role.core_input_resumed
                && !role.restart_required
        }));
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedSupersedeTabRoleReload {
                reason,
                role_ids,
                ..
            } if reason == "coreCleanup" && role_ids.len() == seed.role_ids.len()
        )));
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_faults_terminalize_and_unknown_commit_never_becomes_success() {
    for (index, fault) in [
        "fenceSecond",
        "admit",
        "drain",
        "snapshotAfterDrain",
        "snapshotFinal",
        "resume",
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("fault-{index}"));
        *core.controlled_role_reload_fault_stage.lock().unwrap() = Some(fault.to_owned());
        let mut responder = ControlledReloadResponder::success();
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            controlled_reload_command(&format!("controlled-reload-fault-{index}"), &seed),
            |effect| responder.respond(effect),
        );
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_ne!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied,
            "{fault}: {receipt:?}"
        );
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedSupersedeTabRoleReload { .. }
            )) || matches!(fault, "fenceSecond" | "admit" | "snapshotFinal" | "resume")
        );
        if matches!(fault, "fenceSecond" | "admit") {
            assert!(actions.is_empty(), "{fault}: {actions:?}");
            for role in &receipt.roles {
                if role.input_epoch == 0 {
                    assert!(!role.core_input_resumed, "{fault}: {role:?}");
                    continue;
                }
                assert!(
                    role.core_input_resumed
                        || (role.status
                            == crate::model::SystemRuntimeOperationStatus::Indeterminate
                            && role.restart_required),
                    "{fault}: {role:?}"
                );
            }
        }
        if fault == "snapshotFinal" {
            assert!(
                receipt
                    .roles
                    .iter()
                    .all(|role| !role.core_input_resumed && role.restart_required)
            );
        }
        assert!(
            core.controlled_role_reloads
                .lookup(
                    &format!("controlled-reload-fault-{index}"),
                    &controlled_role_reload_fingerprint(
                        &seed.tab_id,
                        &seed.window_id,
                        seed.window_generation,
                        seed.topology_revision,
                        1,
                    ),
                )
                .is_ok_and(|lookup| matches!(lookup, ControlledRoleReloadLookup::Terminal(_)))
        );
        core.shutdown();
    }

    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "unknown");
    let mut responder = ControlledReloadResponder {
        commit_mode: ControlledReloadCommitMode::Unknown,
        ..ControlledReloadResponder::success()
    };
    let (result, _, _) = drive_async_command_with(
        Arc::clone(&core),
        controlled_reload_command("controlled-reload-unknown", &seed),
        |effect| responder.respond(effect),
    );
    let receipt: crate::model::BrowserTabReloadReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    assert!(receipt.roles.iter().all(|role| {
        role.submission_state == "unknown" && !role.core_input_resumed && role.restart_required
    }));
    core.shutdown();
}

#[test]
fn controlled_role_reload_unacknowledged_cleanup_keeps_core_fenced() {
    for (index, cleanup_mode) in [
        ControlledReloadCleanupMode::Unreleased,
        ControlledReloadCleanupMode::Malformed,
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, core) = core_for_runtime_contract("win32", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("cleanup-{index}"));
        if index == 0 {
            *core.controlled_role_reload_fault_stage.lock().unwrap() = Some("restart".to_owned());
        }
        let mut responder = ControlledReloadResponder {
            cleanup_mode,
            prepare_mode: ControlledReloadPrepareMode::Failed,
            ..ControlledReloadResponder::success()
        };
        let (result, _, _) = drive_async_command_with(
            Arc::clone(&core),
            controlled_reload_command(&format!("controlled-reload-cleanup-{index}"), &seed),
            |effect| responder.respond(effect),
        );
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Indeterminate,
            "{receipt:?}"
        );
        assert!(
            receipt
                .roles
                .iter()
                .all(|role| { !role.core_input_resumed && role.restart_required })
        );
        let diagnostics = core.macro_input_diagnostics().unwrap();
        assert!(
            diagnostics
                .roles
                .iter()
                .any(|role| { seed.role_ids.contains(&role.role_id) && role.quiesced })
        );
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_rejects_ambiguous_and_rejected_native_results() {
    for (index, commit_mode) in [
        ControlledReloadCommitMode::WrapperInvalid,
        ControlledReloadCommitMode::Rejected,
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, core) = core_for_runtime_contract("win32", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("native-invalid-{index}"));
        let mut responder = ControlledReloadResponder {
            commit_mode,
            ..ControlledReloadResponder::success()
        };
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            controlled_reload_command(&format!("controlled-reload-native-invalid-{index}"), &seed),
            |effect| responder.respond(effect),
        );
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_ne!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied,
            "{receipt:?}"
        );
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedSupersedeTabRoleReload { .. }
        )));
        assert!(receipt.roles.iter().all(|role| {
            role.submission_state == "notSubmitted"
                && role.native_input_resumed
                && role.core_input_resumed
                && !role.restart_required
        }));
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_precommit_supersede_resume_is_reason_aware() {
    for (index, (reason, should_resume)) in [
        ("tabMove", true),
        ("tabHide", true),
        ("replacementReload", false),
        ("tabStop", false),
        ("windowClose", false),
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, core) = core_for_runtime_contract("darwin", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("reason-{index}"));
        let (prepared_sender, prepared_receiver) = bounded::<()>(1);
        let (release_sender, release_receiver) = bounded::<()>(1);
        *core
            .controlled_role_reload_after_prepare_hook
            .lock()
            .unwrap() = Some(Arc::new(move || {
            prepared_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
        }));
        let driver_core = Arc::clone(&core);
        let command =
            controlled_reload_command(&format!("controlled-reload-reason-{index}"), &seed);
        let driver = thread::spawn(move || {
            let mut responder = ControlledReloadResponder::success();
            drive_async_command_with(driver_core, command, |effect| responder.respond(effect))
        });
        prepared_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        let reload_admission = core
            .supersede_controlled_role_reloads(&seed.role_ids, reason)
            .unwrap();
        drop(reload_admission);
        release_sender.send(()).unwrap();
        let (result, actions, _) = driver.join().unwrap();
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Superseded,
            "{reason}: {receipt:?}"
        );
        assert!(receipt.roles.iter().all(|role| {
            role.native_input_resumed
                && role.core_input_resumed == should_resume
                && !role.restart_required
        }));
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedSupersedeTabRoleReload { reason, .. }
                if reason == "coreCleanup"
        )));
        let diagnostics = core.macro_input_diagnostics().unwrap();
        for role_id in &seed.role_ids {
            let role = diagnostics
                .roles
                .iter()
                .find(|role| &role.role_id == role_id)
                .unwrap();
            assert_eq!(!role.quiesced, should_resume, "{reason}: {role:?}");
        }
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_commit_cancellation_is_nonblocking_and_uses_exact_cleanup_ack() {
    for inject_restart_failure in [false, true] {
        let (_directory, core) = core_for_runtime_contract("win32", 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("win32", true),
        })
        .unwrap();
        let suffix = if inject_restart_failure {
            "restart-failure"
        } else {
            "not-submitted"
        };
        let seed = seed_controlled_role_reload(&core, suffix);
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let command =
            controlled_reload_command(&format!("controlled-reload-commit-cancel-{suffix}"), &seed);
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.invoke_async(command))
        });
        let mut responder = ControlledReloadResponder::success();
        let mut saw_commit = false;
        while !saw_commit {
            let events = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                for effect in effects {
                    match effect.action.clone() {
                        CoreEffectAction::EmbeddedPrepareTabRoleReload { .. } => {
                            let result = responder.respond(effect);
                            core.dispatch_core_effect_results(vec![result]).unwrap();
                        }
                        CoreEffectAction::EmbeddedCommitTabRoleReload { .. } => {
                            assert_eq!(
                                effect.completion_policy,
                                crate::model::OperationCompletionPolicy::EventBound
                            );
                            saw_commit = true;
                        }
                        action => panic!("unexpected effect before commit: {action:?}"),
                    }
                }
            }
        }
        if inject_restart_failure {
            *core.controlled_role_reload_fault_stage.lock().unwrap() = Some("restart".to_owned());
        }
        let mutation = core.supersede_controlled_role_reloads(&seed.role_ids, "tabMove");
        if inject_restart_failure {
            assert_eq!(
                mutation.unwrap_err().code(),
                "CORE_INTERNAL_FAILED",
                "restart ownership failure must reject the move admission"
            );
        } else {
            drop(mutation.unwrap());
        }
        let mut saw_cleanup = false;
        while !saw_cleanup {
            let events = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
            for event in events {
                match event {
                    CoreEvent::CoreEffectCancellations { cancellations } => {
                        let results = cancellations
                            .into_iter()
                            .map(|cancellation| CoreEffectResult {
                                effect_id: cancellation.effect_id,
                                operation_id: cancellation.operation_id,
                                ok: false,
                                value_json: None,
                                error: Some(crate::CoreErrorPayload {
                                    code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED".to_owned(),
                                    message: "the exact Chromium continuation was cancelled"
                                        .to_owned(),
                                }),
                            })
                            .collect();
                        core.dispatch_core_effect_results(results).unwrap();
                    }
                    CoreEvent::CoreEffects { effects } => {
                        for effect in effects {
                            if matches!(
                                &effect.action,
                                CoreEffectAction::EmbeddedSupersedeTabRoleReload { .. }
                            ) {
                                let result = responder.respond(effect);
                                core.dispatch_core_effect_results(vec![result]).unwrap();
                                saw_cleanup = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(invocation.join().unwrap().unwrap()).unwrap();
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Superseded,
            "{receipt:?}"
        );
        assert!(receipt.roles.iter().all(|role| {
            role.submission_state == "notSubmitted"
                && role.native_input_resumed
                && role.core_input_resumed
                && !role.restart_required
        }));
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_final_apply_and_supersede_are_atomic() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "supersede-wins");
    let (before_final_sender, before_final_receiver) = bounded::<()>(1);
    let (release_sender, release_receiver) = bounded::<()>(1);
    *core
        .controlled_role_reload_before_final_admission_hook
        .lock()
        .unwrap() = Some(Arc::new(move || {
        before_final_sender.send(()).unwrap();
        release_receiver.recv().unwrap();
    }));
    let driver_core = Arc::clone(&core);
    let command = controlled_reload_command("controlled-reload-supersede-wins", &seed);
    let driver = thread::spawn(move || {
        let mut responder = ControlledReloadResponder::success();
        drive_async_command_with(driver_core, command, |effect| responder.respond(effect))
    });
    before_final_receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let admission = core
        .supersede_controlled_role_reloads(&seed.role_ids, "tabMove")
        .unwrap();
    drop(admission);
    release_sender.send(()).unwrap();
    let (result, _, _) = driver.join().unwrap();
    let superseded: crate::model::BrowserTabReloadReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        superseded.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Superseded,
        "{superseded:?}"
    );
    assert!(superseded.roles.iter().all(|role| {
        role.status == crate::model::SystemRuntimeOperationStatus::Superseded
            && !role.core_input_resumed
            && role.restart_required
            && role.failure_code.as_deref()
                == Some("RUNTIME_TAB_RELOAD_SUPERSEDED_AFTER_NATIVE_APPLY")
    }));
    core.shutdown();

    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "final-wins");
    let (final_admitted_sender, final_admitted_receiver) = bounded::<()>(1);
    let (release_sender, release_receiver) = bounded::<()>(1);
    *core
        .controlled_role_reload_after_final_admission_hook
        .lock()
        .unwrap() = Some(Arc::new(move || {
        final_admitted_sender.send(()).unwrap();
        release_receiver.recv().unwrap();
    }));
    let driver_core = Arc::clone(&core);
    let command = controlled_reload_command("controlled-reload-final-wins", &seed);
    let driver = thread::spawn(move || {
        let mut responder = ControlledReloadResponder::success();
        drive_async_command_with(driver_core, command, |effect| responder.respond(effect))
    });
    final_admitted_receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let mutation_core = Arc::clone(&core);
    let mutation_roles = seed.role_ids.clone();
    let mutation = thread::spawn(move || {
        let admission =
            mutation_core.supersede_controlled_role_reloads(&mutation_roles, "tabMove")?;
        drop(admission);
        CoreResult::<()>::Ok(())
    });
    release_sender.send(()).unwrap();
    let (result, _, _) = driver.join().unwrap();
    mutation.join().unwrap().unwrap();
    let applied: crate::model::BrowserTabReloadReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        applied.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied,
        "{applied:?}"
    );
    assert!(
        applied
            .roles
            .iter()
            .all(|role| role.core_input_resumed && !role.restart_required)
    );
    core.shutdown();
}

#[test]
fn controlled_role_reload_admission_cannot_overtake_a_topology_mutation() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "admission-race");
    let (mutation_admitted_sender, mutation_admitted_receiver) = bounded::<()>(1);
    let (release_sender, release_receiver) = bounded::<()>(1);
    *core
        .controlled_role_reload_mutation_admitted_hook
        .lock()
        .unwrap() = Some(Arc::new(move || {
        mutation_admitted_sender.send(()).unwrap();
        release_receiver.recv().unwrap();
    }));
    let mutation_core = Arc::clone(&core);
    let mutation_seed = seed.clone();
    let mutation = thread::spawn(move || -> CoreResult<()> {
        let admission =
            mutation_core.supersede_controlled_role_reloads(&mutation_seed.role_ids, "tabHide")?;
        let snapshot = mutation_core.browser_runtime.snapshot()?;
        let mut window = snapshot
            .windows
            .get(&mutation_seed.window_id)
            .cloned()
            .ok_or_else(|| CoreError::Internal("test window missing".to_owned()))?;
        window.hidden_tab_ids.insert(mutation_seed.tab_id.clone());
        mutation_core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: "controlled-reload-admission-hide".to_owned(),
                source: "command".to_owned(),
                primary_window_id: mutation_seed.window_id.clone(),
                windows: vec![runtime_ui_window_commit(window)],
            },
        ))?;
        drop(admission);
        Ok(())
    });
    mutation_admitted_receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let effects = core.subscribe().unwrap();
    let reload_core = Arc::clone(&core);
    let reload_command = controlled_reload_command("controlled-reload-admission-race", &seed);
    let (result_sender, result_receiver) = bounded(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(reload_core.invoke_async(reload_command));
        result_sender.send(result).unwrap();
    });
    release_sender.send(()).unwrap();
    mutation.join().unwrap().unwrap();
    let receipt: crate::model::BrowserTabReloadReceiptRecord = serde_json::from_value(
        result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Superseded,
        "{receipt:?}"
    );
    assert!(receipt.roles.is_empty());
    assert!(!effects.try_iter().flatten().any(|event| matches!(
        event,
        CoreEvent::CoreEffects { effects }
            if effects.iter().any(|effect| matches!(
                effect.action,
                CoreEffectAction::EmbeddedPrepareTabRoleReload { .. }
                    | CoreEffectAction::EmbeddedCommitTabRoleReload { .. }
            ))
    )));
    core.shutdown();
}

#[test]
fn controlled_role_reload_partial_retirement_carries_exact_evidence_and_quarantines_unknown_role() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "partial-retirement");
    *core.controlled_role_reload_fault_stage.lock().unwrap() =
        Some("retireSecondTimeout".to_owned());
    let mut responder = ControlledReloadResponder::success();
    let (result, actions, _) = drive_async_command_with(
        Arc::clone(&core),
        controlled_reload_command("controlled-reload-partial-retirement", &seed),
        |effect| responder.respond(effect),
    );
    let receipt: crate::model::BrowserTabReloadReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(
        receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate,
        "{receipt:?}"
    );
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, CoreEffectAction::EmbeddedCommitTabRoleReload { .. }))
    );
    let retirement_evidence = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedSupersedeTabRoleReload {
                managed_shortcut_retirements,
                ..
            } => Some(managed_shortcut_retirements),
            _ => None,
        })
        .expect("partial retirement must dispatch exact cleanup evidence");
    assert_eq!(retirement_evidence.len(), 1, "{retirement_evidence:?}");
    assert_eq!(retirement_evidence[0].role_id, seed.role_ids[0]);
    assert!(retirement_evidence[0].terminal);
    let first = receipt
        .roles
        .iter()
        .find(|role| role.role_id == seed.role_ids[0])
        .unwrap();
    assert!(
        first.core_input_resumed && !first.restart_required,
        "{first:?}"
    );
    let failed = receipt
        .roles
        .iter()
        .find(|role| role.role_id == seed.role_ids[1])
        .unwrap();
    assert_eq!(failed.failure_code.as_deref(), Some("MACRO_INPUT_TIMEOUT"));
    assert!(
        !failed.core_input_resumed && failed.restart_required,
        "{failed:?}"
    );
    let diagnostics = core.macro_input_diagnostics().unwrap();
    let failed_diagnostic = diagnostics
        .roles
        .iter()
        .find(|role| role.role_id == seed.role_ids[1])
        .unwrap();
    assert!(
        failed_diagnostic.quiesced && failed_diagnostic.restart_required,
        "{failed_diagnostic:?}"
    );
    core.shutdown();
}

#[test]
fn controlled_role_reload_serializes_same_role_before_fence_and_blocks_after_unknown_predecessor() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "serialized-unknown");
    let effects = core.subscribe().unwrap();
    let first_core = Arc::clone(&core);
    let first_seed = seed.clone();
    let (first_result_sender, first_result_receiver) = bounded(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(first_core.invoke_async(controlled_reload_command(
                "controlled-reload-serialized-first",
                &first_seed,
            )));
        first_result_sender.send(result).unwrap();
    });
    let mut first_responder = ControlledReloadResponder {
        commit_mode: ControlledReloadCommitMode::Unknown,
        ..ControlledReloadResponder::success()
    };
    let first_commit = loop {
        let events = effects.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut commit = None;
        for event in events {
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            for effect in effects {
                if matches!(
                    effect.action,
                    CoreEffectAction::EmbeddedCommitTabRoleReload { .. }
                ) {
                    commit = Some(effect);
                } else {
                    let result = first_responder.respond(effect);
                    core.dispatch_core_effect_results(vec![result]).unwrap();
                }
            }
        }
        if let Some(commit) = commit {
            break commit;
        }
    };
    let first_epochs = first_responder
        .fences
        .iter()
        .map(|role| (role.role_id.clone(), role.input_epoch))
        .collect::<std::collections::HashMap<_, _>>();

    let second_core = Arc::clone(&core);
    let second_seed = seed.clone();
    let (second_result_sender, second_result_receiver) = bounded(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(second_core.invoke_async(controlled_reload_command(
                "controlled-reload-serialized-second",
                &second_seed,
            )));
        second_result_sender.send(result).unwrap();
    });
    assert!(
        second_result_receiver
            .recv_timeout(Duration::from_millis(150))
            .is_err(),
        "the successor completed before the predecessor terminal event"
    );
    assert!(
        effects.recv_timeout(Duration::from_millis(150)).is_err(),
        "the successor emitted a Chromium effect before its predecessor terminalized"
    );

    let result = first_responder.respond(first_commit);
    core.dispatch_core_effect_results(vec![result]).unwrap();
    let first_receipt: crate::model::BrowserTabReloadReceiptRecord = serde_json::from_value(
        first_result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        first_receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate
    );
    let second_receipt: crate::model::BrowserTabReloadReceiptRecord = serde_json::from_value(
        second_result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        second_receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Indeterminate,
        "{second_receipt:?}"
    );
    assert_eq!(
        second_receipt.receipt.failure_code.as_deref(),
        Some("RUNTIME_TAB_RELOAD_PREDECESSOR_INDETERMINATE")
    );
    assert!(second_receipt.roles.iter().all(|role| {
        role.submission_state == "notSubmitted"
            && !role.native_input_resumed
            && !role.core_input_resumed
            && role.restart_required
            && first_epochs.get(&role.role_id) == Some(&role.input_epoch)
    }));
    assert!(
        effects.recv_timeout(Duration::from_millis(150)).is_err(),
        "the blocked successor emitted a Chromium effect"
    );
    let diagnostics = core.macro_input_diagnostics().unwrap();
    assert!(
        diagnostics
            .roles
            .iter()
            .filter(|role| { seed.role_ids.contains(&role.role_id) })
            .all(|role| {
                role.quiesced
                    && role.restart_required
                    && first_epochs.get(&role.role_id) == Some(&role.input_epoch)
            })
    );
    core.shutdown();
}

#[test]
fn controlled_role_reload_successor_fences_a_fresh_epoch_after_applied_predecessor() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let seed = seed_controlled_role_reload(&core, "serialized-applied");
    let effects = core.subscribe().unwrap();
    let first_core = Arc::clone(&core);
    let first_seed = seed.clone();
    let (first_result_sender, first_result_receiver) = bounded(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(first_core.invoke_async(controlled_reload_command(
                "controlled-reload-applied-first",
                &first_seed,
            )));
        first_result_sender.send(result).unwrap();
    });
    let mut first_responder = ControlledReloadResponder::success();
    let first_commit = loop {
        let events = effects.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut commit = None;
        for event in events {
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            for effect in effects {
                if matches!(
                    effect.action,
                    CoreEffectAction::EmbeddedCommitTabRoleReload { .. }
                ) {
                    commit = Some(effect);
                } else {
                    let result = first_responder.respond(effect);
                    core.dispatch_core_effect_results(vec![result]).unwrap();
                }
            }
        }
        if let Some(commit) = commit {
            break commit;
        }
    };
    let first_epochs = first_responder
        .fences
        .iter()
        .map(|role| (role.role_id.clone(), role.input_epoch))
        .collect::<std::collections::HashMap<_, _>>();

    let second_core = Arc::clone(&core);
    let second_seed = seed.clone();
    let (second_result_sender, second_result_receiver) = bounded(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(second_core.invoke_async(controlled_reload_command(
                "controlled-reload-applied-second",
                &second_seed,
            )));
        second_result_sender.send(result).unwrap();
    });
    assert!(
        effects.recv_timeout(Duration::from_millis(150)).is_err(),
        "the successor emitted an effect before the applied predecessor terminalized"
    );
    let result = first_responder.respond(first_commit);
    core.dispatch_core_effect_results(vec![result]).unwrap();
    let first_receipt: crate::model::BrowserTabReloadReceiptRecord = serde_json::from_value(
        first_result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        first_receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied
    );

    let mut second_responder = ControlledReloadResponder::success();
    let mut second_actions = Vec::new();
    while second_actions.len() < 2 {
        let events = effects.recv_timeout(Duration::from_secs(3)).unwrap();
        for event in events {
            let CoreEvent::CoreEffects { effects } = event else {
                continue;
            };
            for effect in effects {
                second_actions.push(effect.action.clone());
                let result = second_responder.respond(effect);
                core.dispatch_core_effect_results(vec![result]).unwrap();
            }
        }
    }
    let second_receipt: crate::model::BrowserTabReloadReceiptRecord = serde_json::from_value(
        second_result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        second_receipt.receipt.status,
        crate::model::SystemRuntimeOperationStatus::Applied,
        "{second_receipt:?}"
    );
    assert!(matches!(
        second_actions.as_slice(),
        [
            CoreEffectAction::EmbeddedPrepareTabRoleReload { .. },
            CoreEffectAction::EmbeddedCommitTabRoleReload { .. }
        ]
    ));
    assert!(second_responder.fences.iter().all(|role| {
        first_epochs
            .get(&role.role_id)
            .is_some_and(|first_epoch| role.input_epoch > *first_epoch)
    }));
    assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
    core.shutdown();
}
