#[test]
fn a_document_replacing_fence_clears_the_recovery_it_interrupted() {
    let runtime = MacroRuntime::new(Arc::new(|_batch: Vec<CoreEvent>| {}));
    // A recovery fails against the replaced document after the reload fence.
    runtime.ensure_input_recovery("recovery-1", "r1").unwrap();
    let fence_epoch = runtime.fence_role_input("r1").unwrap();
    assert!(runtime
        .fail_input_recovery("recovery-1", "r1", "context blocked")
        .unwrap());
    assert!(!runtime.resume_role_input("r1", fence_epoch).unwrap());
    assert!(!runtime.clear_recovery_replaced_by_fence("r1", fence_epoch + 1).unwrap());
    assert!(runtime.clear_recovery_replaced_by_fence("r1", fence_epoch).unwrap());
    assert!(runtime.resume_role_input("r1", fence_epoch).unwrap());
    let role = runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap();
    assert!(!role.restart_required);
    assert!(!role.quiesced);

    // A recovery still in flight when the new document arrives ends quietly,
    // so its late failure no longer marks the Role for restart.
    runtime.ensure_input_recovery("recovery-2", "r2").unwrap();
    let fence_epoch = runtime.fence_role_input("r2").unwrap();
    assert!(runtime.clear_recovery_replaced_by_fence("r2", fence_epoch).unwrap());
    assert!(!runtime
        .fail_input_recovery("recovery-2", "r2", "late")
        .unwrap());
    assert!(runtime.resume_role_input("r2", fence_epoch).unwrap());

    // Without a newer fence, a failed recovery still requires a restart.
    let recovery = runtime.ensure_input_recovery("recovery-3", "r3").unwrap();
    assert!(runtime
        .fail_input_recovery("recovery-3", "r3", "failed")
        .unwrap());
    assert!(!runtime
        .clear_recovery_replaced_by_fence("r3", recovery.input_epoch)
        .unwrap());
}
