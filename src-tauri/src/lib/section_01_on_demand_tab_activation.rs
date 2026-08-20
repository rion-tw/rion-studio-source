async fn activate_runtime_tab_on_demand(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    native_style_applied: bool,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    activate_runtime_tab_on_demand_at_revision(app, state, tab_id, native_style_applied, None).await
}

async fn activate_runtime_tab_on_demand_at_revision(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    native_style_applied: bool,
    expected_revision: Option<u64>,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    let (claim_applied, launch) = state
        .runtime
        .claim_runtime_tab_activation(tab_id, expected_revision)
        .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))?;
    if expected_revision.is_some() && !claim_applied {
        return Ok(state.runtime.superseded_tab_activation_summary(tab_id));
    }
    let presentation = match preview_and_commit_tab_selection_inner(
        app,
        state,
        tab_id,
        native_style_applied,
    ) {
        Ok(presentation) => presentation,
        Err(message) => {
            if launch.is_some() {
                state
                    .runtime
                    .mark_runtime_tab_activation_failed(tab_id, "TAURI_RUNTIME_TAB_ACTION_FAILED");
            }
            return Err(shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message));
        }
    };
    let Some(launch) = launch else {
        return Ok(presentation);
    };
    state
        .runtime
        .prepare_restored_tab_role_slots(&launch.tab_id, &launch.role_slots)
        .map_err(|message| shell_error("TAURI_RESTORE_LAYOUT_PREPARE_FAILED", message))?;
    if let Err(message) = state
        .runtime
        .prepare_restored_tab_workspace_slots(&launch.tab_id, &launch.workspace_slots)
    {
        state
            .runtime
            .discard_prepared_tab_role_slots(&launch.tab_id);
        return Err(shell_error("TAURI_RESTORE_LAYOUT_PREPARE_FAILED", message));
    }
    let admission = match invoke_runtime_source_launch(
        state,
        &launch.source_id,
        &launch.tab_type,
        launch.target,
        None,
        Some(launch.tab_id.clone()),
        Some(launch.role_slots),
    )
    .await
    {
        Ok(admission) => admission,
        Err(error) => {
            state
                .runtime
                .discard_prepared_tab_role_slots(&launch.tab_id);
            state
                .runtime
                .mark_runtime_tab_activation_failed(&launch.tab_id, &error.code);
            return Err(error);
        }
    };
    if resolve_launch_admission(
        admission.completion,
        &admission.disposition,
        &admission.tab_id,
    ) == LaunchAdmissionResolution::OwnershipDiverged
        || admission.tab_id != launch.tab_id
    {
        state
            .runtime
            .discard_prepared_tab_role_slots(&launch.tab_id);
        state
            .runtime
            .mark_runtime_tab_activation_failed(
                &launch.tab_id,
                "TAURI_RUNTIME_LAUNCH_OWNER_DIVERGED",
            );
        return Err(shell_error(
            "TAURI_RUNTIME_LAUNCH_OWNER_DIVERGED",
            "Core completed an on-demand launch without the requested tab owner.",
        ));
    }
    if launch.audio_muted
        && let Err(message) = state
            .runtime
            .restore_tab_audio_muted(&launch.source_id, true)
    {
        state
            .runtime
            .mark_runtime_tab_activation_degraded(&launch.tab_id);
        eprintln!(
            "On-demand tab audio state could not be restored: tab={} error={message}",
            launch.tab_id
        );
    }
    Ok(presentation)
}

async fn activate_selected_restored_tab_on_demand(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    // Native placement and tab-chrome receipts may advance the containing window revision while
    // restore is creating its host. They do not represent a competing tab selection, so using
    // that revision as this activation fence can abandon the still-selected dormant tab before
    // its only launch is admitted. Revalidate the selected dormant tab, then let the Kernel
    // atomically activate that exact selection without coupling it to native geometry churn.
    if state.runtime.selected_dormant_tab_revision(tab_id).is_none() {
        return Ok(state.runtime.superseded_tab_activation_summary(tab_id));
    }
    activate_runtime_tab_on_demand_at_revision(
        app,
        state,
        tab_id,
        false,
        None,
    )
    .await
}

async fn activate_adjacent_runtime_tab_on_demand(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    direction: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    let tab_id = state
        .runtime
        .adjacent_runtime_tab_id(window_id, direction)
        .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))?;
    activate_runtime_tab_on_demand(app, state, &tab_id, false).await
}

async fn activate_selected_runtime_tab_on_demand(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
) {
    let selected_tab_id = state
        .core
        .runtime_kernel()
        .snapshot()
        .ok()
        .and_then(|snapshot| {
            snapshot
                .windows
                .get(window_id)
                .and_then(|window| window.selected_tab_id.as_ref())
                .map(|tab_id| tab_id.as_str().to_owned())
        });
    let Some(tab_id) = selected_tab_id else {
        return;
    };
    if let Err(error) = activate_selected_restored_tab_on_demand(app, state, &tab_id).await
    {
        reveal_shell_error(app, error);
    }
}
