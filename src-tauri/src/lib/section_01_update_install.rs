pub(crate) fn prepare_application_update_exit(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<CoreState>() {
        state.application_exit_guard.permit();
        state
            .application_shutdown_started
            .store(true, Ordering::Release);
        let receipt = state.runtime.close_all();
        if !system_runtime::shutdown_receipt_allows_clean_exit(&receipt.status) {
            return Err(receipt
                .failure_code
                .unwrap_or_else(|| "SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE".to_owned()));
        }
        state.runtime.persist_restore_session(true)?;
        state.core.shutdown();
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
