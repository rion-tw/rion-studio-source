#[derive(Clone, Copy)]
enum RetainedReloadReceipt {
    AllRetained,
    FirstRetained,
    MissingProof,
}

/// Rewrites the native commit receipt as Electron reports a reload whose
/// navigation stopped before any main-frame commit (204/205, download, stop,
/// or beforeunload cancellation).
fn retained_reload_commit_result(
    result: CoreEffectResult,
    mode: RetainedReloadReceipt,
) -> CoreEffectResult {
    let mut receipt = serde_json::from_str::<
        crate::model::EmbeddedTabRoleReloadNativeReceiptRecord,
    >(result.value_json.as_deref().unwrap())
    .unwrap();
    for (index, role) in receipt.roles.iter_mut().enumerate() {
        if matches!(mode, RetainedReloadReceipt::FirstRetained) && index > 0 {
            continue;
        }
        role.after_document_instance_id = (!matches!(mode, RetainedReloadReceipt::MissingProof))
            .then(|| role.before_document_instance_id.clone());
        role.navigation_sequence = None;
        role.status = crate::model::SystemRuntimeOperationStatus::Failed;
        role.failure_code = Some("ELECTRON_ROLE_RELOAD_DOCUMENT_RETAINED".to_owned());
    }
    receipt.status = if matches!(mode, RetainedReloadReceipt::FirstRetained) {
        crate::model::SystemRuntimeOperationStatus::Degraded
    } else {
        crate::model::SystemRuntimeOperationStatus::Failed
    };
    receipt.failure_code = Some("ELECTRON_ROLE_RELOAD_NOT_APPLIED".to_owned());
    CoreEffectResult {
        value_json: Some(serde_json::to_string(&receipt).unwrap()),
        ..result
    }
}

fn run_retained_reload(
    platform: &str,
    mode: RetainedReloadReceipt,
) -> (
    Arc<AppCore>,
    ControlledReloadSeed,
    crate::model::BrowserTabReloadReceiptRecord,
    Vec<CoreEffectAction>,
) {
    let (_directory, core) = core_for_runtime_contract(platform, 23);
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration(platform, true),
    })
    .unwrap();
    let suffix = format!("{platform}-retained-{}", mode as u8);
    let seed = seed_controlled_role_reload(&core, &suffix);
    let command = controlled_reload_command(&format!("controlled-reload-{suffix}"), &seed);
    let mut responder = ControlledReloadResponder::success();
    if matches!(mode, RetainedReloadReceipt::MissingProof) {
        // Electron's cleanup keeps a submitted Role's native fence.
        responder.cleanup_mode = ControlledReloadCleanupMode::Unreleased;
    }
    let (result, actions, _) = drive_async_command_with(Arc::clone(&core), command, |effect| {
        let commit = matches!(effect.action, CoreEffectAction::EmbeddedCommitTabRoleReload { .. });
        let result = responder.respond(effect);
        if commit {
            retained_reload_commit_result(result, mode)
        } else {
            result
        }
    });
    let receipt = serde_json::from_value(result.unwrap()).unwrap();
    (core, seed, receipt, actions)
}

#[test]
fn controlled_role_reload_resumes_input_on_a_document_its_navigation_retained() {
    for platform in ["darwin", "win32"] {
        let (core, seed, receipt, actions) =
            run_retained_reload(platform, RetainedReloadReceipt::AllRetained);
        assert_eq!(actions.len(), 2, "{platform}: no native cleanup is needed");
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Failed,
            "{platform}: {receipt:?}"
        );
        assert!(receipt.roles.iter().all(|role| {
            role.status == crate::model::SystemRuntimeOperationStatus::Failed
                && role.submission_state == "submitted"
                && role.after_document_instance_id.as_ref()
                    == Some(&role.before_document_instance_id)
                && role.native_input_resumed
                && role.core_input_resumed
                && !role.restart_required
        }), "{platform}: {receipt:?}");
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_degrades_when_only_one_document_was_retained() {
    for platform in ["darwin", "win32"] {
        let (core, seed, receipt, _) =
            run_retained_reload(platform, RetainedReloadReceipt::FirstRetained);
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Degraded,
            "{platform}: {receipt:?}"
        );
        assert_eq!(
            receipt.roles.iter().map(|role| role.status).collect::<Vec<_>>(),
            [
                crate::model::SystemRuntimeOperationStatus::Failed,
                crate::model::SystemRuntimeOperationStatus::Applied
            ]
        );
        assert!(receipt
            .roles
            .iter()
            .all(|role| role.core_input_resumed && !role.restart_required));
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
        core.shutdown();
    }
}

#[test]
fn controlled_role_reload_requires_a_restart_without_exact_retained_document_proof() {
    for platform in ["darwin", "win32"] {
        let (core, seed, receipt, actions) =
            run_retained_reload(platform, RetainedReloadReceipt::MissingProof);
        assert!(matches!(
            actions.as_slice(),
            [
                CoreEffectAction::EmbeddedPrepareTabRoleReload { .. },
                CoreEffectAction::EmbeddedCommitTabRoleReload { .. },
                CoreEffectAction::EmbeddedSupersedeTabRoleReload { .. }
            ]
        ));
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Indeterminate,
            "{platform}: {receipt:?}"
        );
        assert_eq!(
            receipt.receipt.failure_code.as_deref(),
            Some("RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_INVALID")
        );
        assert!(receipt
            .roles
            .iter()
            .all(|role| !role.core_input_resumed && role.restart_required));
        let diagnostics = core.macro_input_diagnostics().unwrap();
        assert!(seed.role_ids.iter().all(|role_id| diagnostics
            .roles
            .iter()
            .any(|role| &role.role_id == role_id && role.restart_required)));
        core.shutdown();
    }
}
