fn popup_test_target(window_id: &str) -> EmbeddedLaunchTargetRecord {
    EmbeddedLaunchTargetRecord {
        window_id: window_id.to_owned(),
        persisted_name: Some("Popup Parent".to_owned()),
        display_id: 7,
        scale_factor: 2.0,
        work_area: StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        },
        bounds: StatePixelBoundsRecord {
            x: 80,
            y: 60,
            width: 960,
            height: 640,
        },
        presentation: "normal".to_owned(),
    }
}

fn seed_popup_role_parent(
    core: &AppCore,
    platform: &str,
) -> crate::model::ChromiumPopupParentFenceRecord {
    let role_id = create_role(core, &first_game_id(core), 91);
    let tab_id = uuid::Uuid::new_v4().to_string();
    let attempt_generation = uuid::Uuid::new_v4().to_string();
    let window_id = format!("popup-parent-{platform}");
    core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
        tab_id: Some(tab_id.clone()),
        source_id: role_id.clone(),
        name: "Popup parent".to_owned(),
        tab_type: "role".to_owned(),
        workspace_id: None,
        audio_muted: false,
        attempt_generation: Some(attempt_generation.clone()),
        window_id: window_id.clone(),
        role_slots: test_role_slots(&[&role_id]),
        web_surfaces: Vec::new(),
    })
    .unwrap();
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
    core.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
        crate::RuntimeTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
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
                    role_ids: vec![role_id.clone()],
                    role_slots: Vec::new(),
                    workspace_slots: Vec::new(),
                    source_id: role_id.clone(),
                    tab_type: "role".to_owned(),
                    title: "Popup parent".to_owned(),
                    workspace_template: None,
                }],
                ui_sequence: 1,
                window_generation: 1,
                window_id: window_id.clone(),
            }],
        },
    ))
    .unwrap();
    let target = popup_test_target(&window_id);
    core.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
        crate::RuntimeWindowContextInitializeInput {
            operation_id: uuid::Uuid::new_v4().to_string(),
            persisted_name: target.persisted_name.clone(),
            placement: crate::model::GameWindowPlacementRecord {
                normal_bounds: target.bounds.clone(),
                saved_work_area: target.work_area.clone(),
                presentation: target.presentation.clone(),
            },
            target_display: crate::model::DisplayTargetRecord {
                id: target.display_id,
                fingerprint: Some(crate::model::DisplayFingerprintRecord {
                    label: "Popup Test Display".to_owned(),
                    bounds: target.work_area.clone(),
                    resolution: crate::model::StateResolutionRecord {
                        width: 2880,
                        height: 1800,
                    },
                    scale_factor: target.scale_factor,
                    is_primary: true,
                    is_internal: false,
                }),
            },
            window_generation: 1,
            window_id: window_id.clone(),
        },
    ))
    .unwrap();
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let revision = snapshot.windows[&window_id].revision;
    let owner_generation = snapshot
        .browser_runtime
        .roles
        .iter()
        .find(|role| role.role_id == role_id)
        .unwrap()
        .owner
        .generation;
    crate::model::ChromiumPopupParentFenceRecord {
        owner_kind: crate::model::ChromiumPopupOwnerKind::Role,
        owner_id: role_id,
        slot_id: None,
        owner_native_generation: 3,
        role_owner_generation: Some(owner_generation),
        parent_window_id: window_id,
        parent_window_generation: 1,
        parent_topology_revision: revision,
        parent_tab_id: tab_id,
        parent_attempt_generation: attempt_generation.clone(),
        parent_native_host_id: 41,
        parent_appkit_identity: (platform == "darwin").then(|| {
            crate::model::AppKitRuntimeHostIdentityRecord {
                logical_window_id: format!("popup-parent-{platform}"),
                // The AppKit host may have been created by a different initial
                // tab than the currently active popup opener.
                launch_generation: "initial-host-tab-attempt".to_owned(),
                native_generation: 2,
            }
        }),
    }
}

fn popup_open_request(
    parent: crate::model::ChromiumPopupParentFenceRecord,
) -> crate::model::ChromiumPopupOpenRequestRecord {
    crate::model::ChromiumPopupOpenRequestRecord {
        request_id: uuid::Uuid::new_v4().to_string(),
        parent_target: popup_test_target(&parent.parent_window_id),
        parent,
        target_url: "https://popup.example.test/path".to_owned(),
        disposition: crate::model::ChromiumPopupDisposition::NewWindow,
        opener_policy: crate::model::ChromiumPopupOpenerPolicy::IsolatedNoopener,
        frame_name: Some("_blank".to_owned()),
        referrer_url: Some("https://parent.example.test/".to_owned()),
        referrer_policy: Some("strict-origin-when-cross-origin".to_owned()),
        raw_features: "noopener,noreferrer".to_owned(),
        has_post_body: false,
    }
}

fn popup_event(
    admission: &crate::model::ChromiumPopupAdmissionRecord,
    revision: u64,
    action: crate::model::ChromiumPopupLifecycleActionRecord,
) -> crate::model::ChromiumPopupLifecycleEventRecord {
    crate::model::ChromiumPopupLifecycleEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        popup_id: admission.popup_id.clone(),
        expected_revision: revision,
        parent: admission.parent.clone(),
        action,
    }
}

#[test]
fn chromium_popup_admission_is_capability_and_parent_fenced_on_both_platforms() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        let mut registration = chromium_registration(platform, true);
        registration.capabilities.popup = crate::model::EngineCapabilityStatus::Disabled;
        core.invoke(CoreCommand::BrowserRuntimeRegister { registration })
            .unwrap();
        let parent = seed_popup_role_parent(&core, platform);
        let request = popup_open_request(parent.clone());
        let unavailable = core
            .invoke(CoreCommand::BrowserPopupOpenAdmit {
                request: request.clone(),
            })
            .unwrap_err();
        assert_eq!(unavailable.code(), "CHROMIUM_POPUP_CAPABILITY_UNAVAILABLE");

        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let admission: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit {
                request: request.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(admission.creation_url, "about:blank");
        assert_eq!(admission.target_url, request.target_url);
        assert_eq!(admission.lifecycle_revision, 1);
        assert!(admission.target.window_id.starts_with("popup-"));
        let replay: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit {
                request: request.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replay.popup_id, admission.popup_id);

        let mut mismatched = request.clone();
        mismatched.target_url = "https://different.example.test/".to_owned();
        assert_eq!(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit {
                request: mismatched,
            })
            .unwrap_err()
            .code(),
            "CHROMIUM_POPUP_REQUEST_REPLAY_MISMATCH"
        );
        let mut post = popup_open_request(parent.clone());
        post.has_post_body = true;
        assert_eq!(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit { request: post })
                .unwrap_err()
                .code(),
            "CHROMIUM_POPUP_PARENT_FENCE_INVALID"
        );
        let mut external = popup_open_request(parent);
        external.target_url = "mailto:blocked@example.test".to_owned();
        assert_eq!(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit { request: external })
                .unwrap_err()
                .code(),
            "CHROMIUM_POPUP_URL_INVALID"
        );
        core.shutdown();
    }
}

#[test]
fn chromium_popup_parent_target_mismatches_report_the_exact_fenced_field() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let base_request = popup_open_request(seed_popup_role_parent(&core, "win32"));
    type PopupTargetMutation = fn(&mut crate::model::EmbeddedLaunchTargetRecord);
    let cases: [(&str, PopupTargetMutation); 7] = [
        ("windowId", |target| target.window_id.push_str("-stale")),
        ("persistedName", |target| {
            target.persisted_name = Some("Superseded Popup Parent".to_owned());
        }),
        ("displayId", |target| target.display_id += 1),
        ("scaleFactor", |target| target.scale_factor += 0.25),
        ("workArea", |target| target.work_area.x += 1),
        ("bounds", |target| target.bounds.y += 1),
        ("presentation", |target| {
            target.presentation = "fullscreen".to_owned();
        }),
    ];

    for (field, mutate) in cases {
        let mut request = base_request.clone();
        request.request_id = uuid::Uuid::new_v4().to_string();
        mutate(&mut request.parent_target);
        let error = core
            .invoke(CoreCommand::BrowserPopupOpenAdmit { request })
            .unwrap_err();
        let message = error.to_string();
        assert_eq!(error.code(), "CHROMIUM_POPUP_PARENT_SUPERSEDED");
        assert!(
            message.contains(&format!("`{field}`")),
            "expected field-specific popup fence diagnostic for {field}, received: {message}",
        );
        assert!(message.contains("Core expected"), "{message}");
        assert!(message.contains("request supplied"), "{message}");
    }
    core.shutdown();
}

#[test]
fn chromium_popup_lifecycle_orders_native_page_close_and_terminal_receipts() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let request = popup_open_request(seed_popup_role_parent(&core, platform));
        let admission: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupOpenAdmit { request })
                .unwrap(),
        )
        .unwrap();
        let host = crate::model::ChromiumPopupNativeHostReceiptRecord {
            platform: if platform == "darwin" { "macos" } else { "windows" }.to_owned(),
            native_host_id: 71,
            logical_window_id: admission.target.window_id.clone(),
            window_generation: 1,
            topology_revision: 1,
            appkit_identity: (platform == "darwin").then(|| {
                crate::model::AppKitRuntimeHostIdentityRecord {
                    logical_window_id: admission.target.window_id.clone(),
                    launch_generation: admission.open_operation_id.clone(),
                    native_generation: 1,
                }
            }),
        };
        let native_event = popup_event(
            &admission,
            1,
            crate::model::ChromiumPopupLifecycleActionRecord::NativeReady { host },
        );
        let native: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
                event: native_event.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(native.lifecycle_revision, 2);
        assert!(!native.operation_terminal);
        let replay: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
                event: native_event,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replay, native);

        let stale = popup_event(
            &admission,
            1,
            crate::model::ChromiumPopupLifecycleActionRecord::PageReady {
                final_url: admission.target_url.clone(),
            },
        );
        let stale: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit { event: stale })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(stale.status, crate::model::SystemRuntimeOperationStatus::Superseded);

        let ready = popup_event(
            &admission,
            2,
            crate::model::ChromiumPopupLifecycleActionRecord::PageReady {
                final_url: admission.target_url.clone(),
            },
        );
        let ready: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit { event: ready })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ready.phase, crate::model::ChromiumPopupLifecyclePhase::Ready);
        assert!(ready.operation_terminal);
        assert!(!ready.lifecycle_terminal);

        let close = popup_event(
            &admission,
            3,
            crate::model::ChromiumPopupLifecycleActionRecord::CloseRequested {
                reason: crate::model::ChromiumPopupCloseReason::User,
            },
        );
        let close: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit { event: close })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(close.phase, crate::model::ChromiumPopupLifecyclePhase::Closing);
        assert!(close.close_native);
        assert!(!close.operation_terminal);

        let closed = popup_event(
            &admission,
            4,
            crate::model::ChromiumPopupLifecycleActionRecord::NativeClosed,
        );
        let closed: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit { event: closed })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(closed.phase, crate::model::ChromiumPopupLifecyclePhase::Closed);
        assert!(closed.operation_terminal);
        assert!(closed.lifecycle_terminal);
        assert_eq!(closed.operation_id, close.operation_id);
        core.shutdown();
    }
}

#[test]
fn macos_popup_native_ready_requires_exact_appkit_identity() {
    let (_directory, core) = core_for_runtime_contract("darwin", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("darwin", true),
    })
    .unwrap();
    let admission: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupOpenAdmit {
            request: popup_open_request(seed_popup_role_parent(&core, "darwin")),
        })
        .unwrap(),
    )
    .unwrap();
    let missing = popup_event(
        &admission,
        1,
        crate::model::ChromiumPopupLifecycleActionRecord::NativeReady {
            host: crate::model::ChromiumPopupNativeHostReceiptRecord {
                platform: "macos".to_owned(),
                native_host_id: 1,
                logical_window_id: admission.target.window_id.clone(),
                window_generation: 1,
                topology_revision: 1,
                appkit_identity: None,
            },
        },
    );
    assert_eq!(
        core.invoke(CoreCommand::BrowserPopupLifecycleCommit { event: missing })
            .unwrap_err()
            .code(),
        "CHROMIUM_POPUP_APPKIT_RECEIPT_REQUIRED"
    );
    core.shutdown();
}

#[test]
fn unfinished_popup_open_terminalizes_on_cancel_or_native_teardown() {
    let (_directory, core) = core_for_runtime_contract("win32", 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration("win32", true),
    })
    .unwrap();
    let parent = seed_popup_role_parent(&core, "win32");

    let admitted: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupOpenAdmit {
            request: popup_open_request(parent.clone()),
        })
        .unwrap(),
    )
    .unwrap();
    let cancelled: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
            event: popup_event(
                &admitted,
                1,
                crate::model::ChromiumPopupLifecycleActionRecord::CloseRequested {
                    reason: crate::model::ChromiumPopupCloseReason::ParentRetired,
                },
            ),
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(cancelled.operation_id, admitted.open_operation_id);
    assert_eq!(
        cancelled.phase,
        crate::model::ChromiumPopupLifecyclePhase::Cancelled
    );
    assert!(cancelled.operation_terminal);
    assert!(cancelled.lifecycle_terminal);
    assert!(!cancelled.close_native);

    let native_open: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupOpenAdmit {
            request: popup_open_request(parent.clone()),
        })
        .unwrap(),
    )
    .unwrap();
    let native_ready: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
            event: popup_event(
                &native_open,
                1,
                crate::model::ChromiumPopupLifecycleActionRecord::NativeReady {
                    host: crate::model::ChromiumPopupNativeHostReceiptRecord {
                        platform: "windows".to_owned(),
                        native_host_id: 72,
                        logical_window_id: native_open.target.window_id.clone(),
                        window_generation: 1,
                        topology_revision: 1,
                        appkit_identity: None,
                    },
                },
            ),
        })
        .unwrap(),
    )
    .unwrap();
    let load_failed: crate::model::ChromiumPopupLifecycleReceiptRecord =
        serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
                event: popup_event(
                    &native_open,
                    native_ready.lifecycle_revision,
                    crate::model::ChromiumPopupLifecycleActionRecord::Failed {
                        failure_code: "CHROMIUM_POPUP_LOAD_FAILED".to_owned(),
                        native_state_unknown: false,
                    },
                ),
            })
            .unwrap(),
        )
        .unwrap();
    assert_eq!(load_failed.operation_id, native_open.open_operation_id);
    assert!(!load_failed.operation_terminal);
    assert!(load_failed.close_native);
    let destroyed: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
            event: popup_event(
                &native_open,
                load_failed.lifecycle_revision,
                crate::model::ChromiumPopupLifecycleActionRecord::NativeClosed,
            ),
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(destroyed.operation_id, native_open.open_operation_id);
    assert_eq!(
        destroyed.phase,
        crate::model::ChromiumPopupLifecyclePhase::Failed
    );
    assert!(destroyed.operation_terminal);
    assert!(destroyed.lifecycle_terminal);

    let native_cancel: crate::model::ChromiumPopupAdmissionRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupOpenAdmit {
            request: popup_open_request(parent),
        })
        .unwrap(),
    )
    .unwrap();
    let native_ready: crate::model::ChromiumPopupLifecycleReceiptRecord = serde_json::from_value(
        core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
            event: popup_event(
                &native_cancel,
                1,
                crate::model::ChromiumPopupLifecycleActionRecord::NativeReady {
                    host: crate::model::ChromiumPopupNativeHostReceiptRecord {
                        platform: "windows".to_owned(),
                        native_host_id: 73,
                        logical_window_id: native_cancel.target.window_id.clone(),
                        window_generation: 1,
                        topology_revision: 1,
                        appkit_identity: None,
                    },
                },
            ),
        })
        .unwrap(),
    )
    .unwrap();
    let close_before_ready: crate::model::ChromiumPopupLifecycleReceiptRecord =
        serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
                event: popup_event(
                    &native_cancel,
                    native_ready.lifecycle_revision,
                    crate::model::ChromiumPopupLifecycleActionRecord::CloseRequested {
                        reason: crate::model::ChromiumPopupCloseReason::ApplicationShutdown,
                    },
                ),
            })
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        close_before_ready.operation_id,
        native_cancel.open_operation_id
    );
    assert!(!close_before_ready.operation_terminal);
    let cancelled_after_native_close: crate::model::ChromiumPopupLifecycleReceiptRecord =
        serde_json::from_value(
            core.invoke(CoreCommand::BrowserPopupLifecycleCommit {
                event: popup_event(
                    &native_cancel,
                    close_before_ready.lifecycle_revision,
                    crate::model::ChromiumPopupLifecycleActionRecord::NativeClosed,
                ),
            })
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        cancelled_after_native_close.operation_id,
        native_cancel.open_operation_id
    );
    assert_eq!(
        cancelled_after_native_close.phase,
        crate::model::ChromiumPopupLifecyclePhase::Cancelled
    );
    assert!(cancelled_after_native_close.operation_terminal);
    assert!(cancelled_after_native_close.lifecycle_terminal);
    core.shutdown();
}
