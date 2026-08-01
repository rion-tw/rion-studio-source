struct RuntimeReparentedSurface {
    source_window: Window,
    #[cfg(windows)]
    source_window_id: String,
    surface: Webview,
    tab_id: String,
    #[cfg(windows)]
    target_window_id: String,
    was_visible: bool,
}

impl SystemRuntimeExecutor {
    fn rollback_runtime_reparented_surfaces(
        &self,
        reparented_surfaces: &[RuntimeReparentedSurface],
    ) -> Vec<String> {
        let mut errors = Vec::new();
        for moved in reparented_surfaces.iter().rev() {
            if let Err(error) = moved.surface.hide() {
                errors.push(format!("hide {}: {error}", moved.surface.label()));
            }
            if let Err(error) = moved.surface.reparent(&moved.source_window) {
                errors.push(format!("reparent {}: {error}", moved.surface.label()));
            }
        }

        #[cfg(windows)]
        {
            let mut groups = HashMap::<(String, String, String), (Window, Vec<Webview>)>::new();
            for moved in reparented_surfaces {
                let group = groups
                    .entry((
                        moved.source_window_id.clone(),
                        moved.target_window_id.clone(),
                        moved.tab_id.clone(),
                    ))
                    .or_insert_with(|| (moved.source_window.clone(), Vec::new()));
                group.1.push(moved.surface.clone());
            }
            for ((source_window_id, target_window_id, tab_id), (source_window, surfaces)) in groups
            {
                match synchronize_windows_reparented_surfaces(&surfaces, &source_window) {
                    Ok(outcome) => self.record_windows_reparent_sync_event(
                        "tab.reparent-sync-rolled-back",
                        "WebView2 surfaces synchronized with their source Game Window during rollback.",
                        &tab_id,
                        &target_window_id,
                        &source_window_id,
                        "topology-rollback",
                        Ok(&outcome),
                        Some(errors.len()),
                    ),
                    Err(failure) => {
                        errors.push(format!("reparent sync {tab_id}: {}", failure.message));
                        self.record_windows_reparent_sync_event(
                            "tab.reparent-sync-rolled-back",
                            "WebView2 surfaces did not fully synchronize with their source Game Window during rollback.",
                            &tab_id,
                            &target_window_id,
                            &source_window_id,
                            "topology-rollback",
                            Err(&failure),
                            Some(errors.len()),
                        );
                    }
                }
            }
        }

        let mut restored_tabs = HashSet::new();
        for moved in reparented_surfaces {
            if restored_tabs.insert(moved.tab_id.clone())
                && let Err(error) = self.layout_runtime_tab(&moved.tab_id)
            {
                errors.push(format!("layout {}: {}", moved.tab_id, error.message));
            }
        }
        for moved in reparented_surfaces {
            if moved.was_visible
                && let Err(error) = moved.surface.show()
            {
                errors.push(format!("show {}: {error}", moved.surface.label()));
            }
        }
        if !errors.is_empty() {
            self.health.mark_unhealthy();
        }
        errors
    }

    fn runtime_reparent_failure(
        &self,
        failure: RuntimeError,
        rollback_errors: Vec<String>,
    ) -> RuntimeError {
        if rollback_errors.is_empty() {
            failure
        } else {
            RuntimeError::new(
                "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
                format!(
                    "Moving native runtime surfaces failed: {} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                    failure.message,
                    rollback_errors.join("; ")
                ),
            )
        }
    }
}
