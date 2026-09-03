pub(crate) fn prepare_application_update_exit(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<CoreState>() {
        state.application_exit_guard.permit();
        state.application_shutdown.mark_started();
        let shutdown_deadline = system_runtime::system_runtime_shutdown_deadline();
        let core_clear_drain_began = state
            .core
            .begin_role_browser_data_clear_command_drain()
            .is_ok();
        let receipt = state.runtime.close_all_until(shutdown_deadline);
        let core_clear_drain_safe = core_clear_drain_began
            && matches!(
                state
                    .core
                    .wait_for_role_browser_data_clear_command_drain(shutdown_deadline),
                Ok(true)
            );
        let exit_decision =
            application_shutdown_exit_decision(&receipt.status, core_clear_drain_safe);
        let shutdown_result = if exit_decision == ApplicationShutdownExitDecision::Clean {
            state.runtime.persist_restore_session(true)
        } else {
            Err(receipt
                .failure_code
                .unwrap_or_else(|| "SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE".to_owned()))
        };
        // An updater handoff owns the process after native drain begins. Even a
        // failed or indeterminate terminal drain must allow the caller's
        // fail-closed restart instead of leaving ExitRequested waiting for a
        // shutdown worker that this synchronous path never creates.
        if exit_decision == ApplicationShutdownExitDecision::HardExit {
            // Do not normally release the Core instance lock after an unsafe native terminal.
            // A non-zero hard exit leaves final release to the OS.
            std::process::exit(9);
        }
        if let Err(error) = compensate_checked_core_shutdown_result(
            &state.core,
            state.core.shutdown_checked(),
        ) {
            eprintln!("{error}");
            std::process::exit(9);
        }
        state.application_shutdown.mark_ready_to_exit();
        shutdown_result?;
    }
    Ok(())
}

fn prepare_application_update_install(runtime: &SystemRuntimeExecutor) -> Result<(), String> {
    runtime.persist_all_game_window_placements()?;
    runtime.persist_restore_session(false)?;
    Ok(())
}

fn run_downloaded_update_install(
    app: AppHandle,
    runtime: Arc<SystemRuntimeExecutor>,
    updates: Arc<update_manager::UpdateManager>,
) {
    if updates
        .transition_install("preparing", "preparing", None, None, false)
        .is_err()
    {
        return;
    }
    if let Err(error) = prepare_application_update_install(&runtime) {
        let _ = updates.transition_install(
            "failedBeforeDrain",
            "install_failed",
            Some("UPDATE_INSTALL_PREPARE_FAILED"),
            Some(&error),
            true,
        );
        return;
    }
    if updates
        .transition_install("installing", "installing", None, None, false)
        .is_err()
    {
        return;
    }
    if let Err(error) = updates.install_downloaded() {
        if updates.install_has_started_draining() {
            let _ = updates.transition_install(
                "failedAfterDrain",
                "install_failed",
                Some("UPDATE_INSTALL_HANDOFF_FAILED"),
                Some(&error),
                false,
            );
            app.restart();
        }
        let _ = updates.transition_install(
            "failedBeforeDrain",
            "install_failed",
            Some("UPDATE_INSTALL_STAGING_FAILED"),
            Some(&error),
            true,
        );
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let (post_drain_phase, post_drain_state) = update_transaction::install_boundary_contract(
            update_transaction::InstallPlatform::Macos,
            update_transaction::InstallBoundary::InstallReturned,
        )
        .map_err(str::to_owned)
        .unwrap_or_else(|_| {
            let _ = prepare_application_update_exit(&app);
            app.restart();
        });
        if updates
            .transition_install("draining", "draining", None, None, false)
            .is_err()
        {
            let _ = prepare_application_update_exit(&app);
            app.restart();
        }
        if let Err(error) = prepare_application_update_exit(&app) {
            let _ = updates.transition_install(
                "failedAfterDrain",
                "install_failed",
                Some("UPDATE_INSTALL_DRAIN_FAILED"),
                Some(&error),
                false,
            );
            app.restart();
        }
        if updates
            .transition_install(
                post_drain_phase,
                post_drain_state,
                None,
                None,
                false,
            )
            .is_err()
        {
            app.restart();
        }
        app.restart();
    }

    #[cfg(windows)]
    {
        let failure_code = update_transaction::install_boundary_contract(
            update_transaction::InstallPlatform::Windows,
            update_transaction::InstallBoundary::InstallReturned,
        )
        .err()
        .unwrap_or("UPDATE_INSTALLER_HANDOFF_RETURNED");
        let _ = updates.transition_install(
            "failedAfterDrain",
            "install_failed",
            Some(failure_code),
            Some("The Windows updater returned after installer handoff."),
            false,
        );
        app.restart();
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = updates.transition_install(
            "failedBeforeDrain",
            "install_failed",
            Some("UPDATE_INSTALL_PLATFORM_UNSUPPORTED"),
            Some("The current platform does not support updater installation."),
            true,
        );
    }
}
