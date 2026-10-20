#[test]
fn controlled_role_reload_clears_a_macro_input_recovery_it_interrupted() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_runtime_contract(platform, 23);
        core.invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
        let seed = seed_controlled_role_reload(&core, &format!("{platform}-recovery"));
        let role_id = seed.role_ids[0].clone();
        // A Macro input recovery is still cleaning the document being reloaded.
        core.macro_runtime
            .ensure_input_recovery("interrupted-recovery", &role_id)
            .unwrap();
        let command =
            controlled_reload_command(&format!("controlled-reload-recovery-{platform}"), &seed);
        let mut responder = ControlledReloadResponder::success();
        let failing_core = Arc::clone(&core);
        let failing_role = role_id.clone();
        let (result, _, _) = drive_async_command_with(Arc::clone(&core), command, |effect| {
            if matches!(effect.action, CoreEffectAction::EmbeddedCommitTabRoleReload { .. }) {
                // The superseded document fails the recovery while the reload commits.
                failing_core
                    .macro_runtime
                    .fail_input_recovery("interrupted-recovery", &failing_role, "document replaced")
                    .unwrap();
            }
            responder.respond(effect)
        });
        let receipt: crate::model::BrowserTabReloadReceiptRecord =
            serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(
            receipt.receipt.status,
            crate::model::SystemRuntimeOperationStatus::Applied,
            "{platform}: {receipt:?}"
        );
        assert!(receipt
            .roles
            .iter()
            .all(|role| role.core_input_resumed && !role.restart_required));
        assert_controlled_reload_roles_resumed(&core, &seed.role_ids);
        core.shutdown();
    }
}
