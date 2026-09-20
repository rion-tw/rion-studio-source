#[test]
fn macro_input_recovery_commands_require_the_exact_recovery_and_epoch_fence() {
    let (_directory, core) = core();
    let ticket = core
        .ensure_macro_input_recovery("recovery-exact", "role-exact")
        .unwrap();

    let inspected = core
        .invoke(command(json!({
            "type": "macroInputRecoveryInspect",
            "recoveryId": ticket.recovery_id,
            "roleId": ticket.role_id,
            "expectedInputEpoch": ticket.input_epoch,
        })))
        .unwrap();
    assert_eq!(inspected["recoveryId"], json!("recovery-exact"));
    assert_eq!(inspected["roleId"], json!("role-exact"));
    assert_eq!(inspected["inputEpoch"], json!(ticket.input_epoch));

    for stale in [
        json!({
            "type": "macroInputRecoveryInspect",
            "recoveryId": "different-recovery",
            "roleId": "role-exact",
            "expectedInputEpoch": ticket.input_epoch,
        }),
        json!({
            "type": "macroInputRecoveryComplete",
            "recoveryId": "recovery-exact",
            "roleId": "role-exact",
            "expectedInputEpoch": ticket.input_epoch + 1,
        }),
        json!({
            "type": "macroInputRecoveryNeutralize",
            "recoveryId": "recovery-exact",
            "roleId": "role-exact",
            "expectedInputEpoch": ticket.input_epoch + 1,
            "surfaceGeneration": 7,
            "documentInstanceId": "document-exact",
        }),
        json!({
            "type": "macroInputRecoveryFail",
            "recoveryId": "recovery-exact",
            "roleId": "different-role",
            "expectedInputEpoch": ticket.input_epoch,
            "message": "must not mutate current recovery",
        }),
    ] {
        let error = core.invoke(command(stale)).unwrap_err();
        assert_eq!(error.code(), "MACRO_INPUT_RECOVERY_STALE");
    }

    let still_current = core
        .macro_input_recovery_for_role("role-exact")
        .unwrap()
        .expect("stale commands preserve the current ticket");
    assert_eq!(still_current, ticket);
}

#[test]
fn macro_input_recovery_neutralize_dispatches_one_exact_cleanup_action() {
    let (_directory, core) = core();
    let ticket = core
        .ensure_macro_input_recovery("recovery-neutralize", "role-neutralize")
        .unwrap();
    core.drain_macro_input("role-neutralize", ticket.input_epoch)
        .unwrap();

    let (receipt, actions) = drive_command(
        Arc::clone(&core),
        command(json!({
            "type": "macroInputRecoveryNeutralize",
            "recoveryId": ticket.recovery_id,
            "roleId": ticket.role_id,
            "expectedInputEpoch": ticket.input_epoch,
            "surfaceGeneration": 7,
            "documentInstanceId": "document-neutralize",
        })),
        None,
    );
    let receipt = receipt.unwrap();
    assert_eq!(actions.len(), 1);
    assert!(matches!(
        &actions[0],
        CoreEffectAction::BrowserAction { request }
            if request.role_id == "role-neutralize"
                && request.input_epoch == ticket.input_epoch
                && request.intent == "cleanup"
                && request.surface_generation == Some(7)
                && request.document_instance_id.as_deref() == Some("document-neutralize")
                && matches!(request.action, crate::model::BrowserAction::NeutralizeInput)
    ));
    assert_eq!(receipt["recoveryId"], json!("recovery-neutralize"));
    assert_eq!(receipt["roleId"], json!("role-neutralize"));
    assert_eq!(receipt["inputEpoch"], json!(ticket.input_epoch));
    assert_eq!(receipt["neutralized"], json!(true));
    assert_eq!(receipt["requestIds"].as_array().unwrap().len(), 1);
}

#[test]
fn macro_input_recovery_complete_and_fail_return_identity_bound_terminal_receipts() {
    let (_directory, core) = core();
    let completed_ticket = core
        .ensure_macro_input_recovery("recovery-complete", "role-complete")
        .unwrap();
    core.drain_macro_input("role-complete", completed_ticket.input_epoch)
        .unwrap();
    let completed = core
        .invoke(command(json!({
            "type": "macroInputRecoveryComplete",
            "recoveryId": completed_ticket.recovery_id,
            "roleId": completed_ticket.role_id,
            "expectedInputEpoch": completed_ticket.input_epoch,
        })))
        .unwrap();
    assert_eq!(completed["terminal"], json!(true));
    assert_eq!(completed["recoveryId"], json!("recovery-complete"));
    assert_eq!(completed["inputEpoch"], json!(completed_ticket.input_epoch));
    assert!(
        core.macro_input_recovery_for_role("role-complete")
            .unwrap()
            .is_none()
    );

    let failed_ticket = core
        .ensure_macro_input_recovery("recovery-fail", "role-fail")
        .unwrap();
    let failed = core
        .invoke(command(json!({
            "type": "macroInputRecoveryFail",
            "recoveryId": failed_ticket.recovery_id,
            "roleId": failed_ticket.role_id,
            "expectedInputEpoch": failed_ticket.input_epoch,
            "message": "document identity changed during recovery",
        })))
        .unwrap();
    assert_eq!(failed["failed"], json!(true));
    assert_eq!(failed["restartRequired"], json!(true));
    assert_eq!(failed["recoveryId"], json!("recovery-fail"));
    assert_eq!(failed["inputEpoch"], json!(failed_ticket.input_epoch));
}

#[test]
fn macro_input_recovery_terminal_commands_serialize_across_resume_and_ticket_removal() {
    use std::sync::{Barrier, mpsc};

    let (_directory, core) = core();
    let ticket = core
        .ensure_macro_input_recovery("recovery-race", "role-race")
        .unwrap();
    core.drain_macro_input("role-race", ticket.input_epoch)
        .unwrap();
    let after_resume = Arc::new(Barrier::new(2));
    let allow_completion = Arc::new(Barrier::new(2));
    *core.macro_input_recovery_after_resume_hook.lock().unwrap() = Some({
        let after_resume = Arc::clone(&after_resume);
        let allow_completion = Arc::clone(&allow_completion);
        Arc::new(move || {
            after_resume.wait();
            allow_completion.wait();
        })
    });

    let completing_core = Arc::clone(&core);
    let completing_ticket = ticket.clone();
    let completing = thread::spawn(move || {
        completing_core.complete_macro_input_recovery_exact(
            &completing_ticket.recovery_id,
            &completing_ticket.role_id,
            completing_ticket.input_epoch,
        )
    });
    after_resume.wait();

    let (attempted_sender, attempted_receiver) = mpsc::channel();
    let (failed_sender, failed_receiver) = mpsc::channel();
    let failing_core = Arc::clone(&core);
    let failing_ticket = ticket.clone();
    let failing = thread::spawn(move || {
        attempted_sender.send(()).unwrap();
        let result = failing_core.fail_macro_input_recovery_exact(
            &failing_ticket.recovery_id,
            &failing_ticket.role_id,
            failing_ticket.input_epoch,
            "concurrent failure",
        );
        failed_sender
            .send(
                result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| error.code().to_owned()),
            )
            .unwrap();
        result
    });
    attempted_receiver.recv().unwrap();
    assert!(failed_receiver.try_recv().is_err());

    allow_completion.wait();
    let completed = completing.join().unwrap().unwrap();
    assert!(completed.terminal);
    let failed = failing.join().unwrap().unwrap_err();
    assert_eq!(failed.code(), "MACRO_INPUT_RECOVERY_STALE");
    assert_eq!(
        failed_receiver.recv().unwrap(),
        Err("MACRO_INPUT_RECOVERY_STALE".to_owned())
    );
}

#[test]
fn failed_input_recovery_makes_ready_surface_automation_unavailable() {
    let (_directory, core) = core();
    install_test_system_runtime(&core, supported_system_capabilities());
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let (launch, _) = drive_command(
        Arc::clone(&core),
        command(json!({
            "type": "embeddedRoleLaunch", "roleId": role_id,
            "target": { "displayId": 1,
                "workArea": { "x": 0, "y": 0, "width": 1200, "height": 800 } }
        })),
        None,
    );
    assert!(launch.is_ok(), "{launch:?}");
    let (ready, _) = drive_command(
        Arc::clone(&core),
        CoreCommand::EmbeddedSystemSurfaceRecovered { role_id: role_id.clone() },
        None,
    );
    assert!(ready.is_ok());
    assert_eq!(core.browser_statuses().unwrap()[0].automation_state.as_deref(), Some("ready"));
    let ticket = core.ensure_macro_input_recovery("receipt-mismatch", &role_id).unwrap();
    core.fail_macro_input_recovery_exact(
        &ticket.recovery_id, &role_id, ticket.input_epoch, "Release was not confirmed",
    ).unwrap();
    let status = core.browser_statuses().unwrap().remove(0);
    assert_eq!(status.automation_state.as_deref(), Some("unavailable"));
    assert!(core.macro_input_diagnostics().unwrap().roles.iter()
        .any(|role| role.role_id == role_id && role.restart_required));
    core.shutdown();
}
