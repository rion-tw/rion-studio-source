impl SystemRuntimeExecutor {
    fn repair_missing_tab_presentation(
        &self,
        tab_id: &str,
        expected_window_id: &str,
    ) -> Result<bool, String> {
        if self.presentation.tab_window(tab_id)?.is_some() {
            return Ok(true);
        }
        if self.current_window_close_in_progress(expected_window_id) {
            return Ok(false);
        }
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let Some(core_tab) = snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id && tab.window_id == expected_window_id)
        else {
            return Ok(false);
        };
        let core_selected = snapshot.windows.iter().any(|window| {
            window.window_id == expected_window_id
                && window.active_tab_id.as_deref() == Some(tab_id)
        });
        let (host_generation, phase, bindings, workspace_template) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let Some(host) = state.display_hosts.get(expected_window_id) else {
                return Ok(false);
            };
            let Some(runtime_tab) = state
                .tabs
                .get(tab_id)
                .filter(|tab| tab.window_id == expected_window_id)
            else {
                return Ok(false);
            };
            let phase = match state.launch_phases.get(tab_id) {
                Some(LaunchPhase::Ready) => TabPresentationPhase::Ready,
                Some(LaunchPhase::Degraded) => TabPresentationPhase::Degraded,
                Some(LaunchPhase::Attaching) => TabPresentationPhase::Attaching,
                _ => TabPresentationPhase::Loading,
            };
            let bindings = runtime_tab
                .roles
                .values()
                .map(|surface| SurfacePresentationBinding {
                    generation: surface.generation,
                    instance_id: surface.surface_instance_id.clone(),
                    webview: surface.webview.clone(),
                })
                .chain(runtime_tab.slots.values().filter_map(|slot| {
                    slot.placeholder.as_ref().map(|surface| SurfacePresentationBinding {
                        generation: slot.owner_generation.unwrap_or_default(),
                        instance_id: surface.surface_instance_id.clone(),
                        webview: surface.webview.clone(),
                    })
                }))
                .collect::<Vec<_>>();
            (
                host.generation,
                phase,
                bindings,
                #[cfg(any(windows, target_os = "macos"))]
                runtime_tab.workspace_template.clone(),
                #[cfg(not(any(windows, target_os = "macos")))]
                None::<String>,
            )
        };
        let revision = self.presentation.next_revision();
        let coordinator = self.presentation.coordinator(expected_window_id)?;
        {
            let mut live = coordinator
                .lock()
                .map_err(|_| "Live runtime window state is unavailable.".to_owned())?;
            if live.window_generation != 0 && live.window_generation != host_generation {
                return Ok(false);
            }
            live.window_generation = host_generation;
            live.insert_tab(
                TabPresentation {
                    closable: true,
                    icon_data_url: None,
                    id: core_tab.id.clone(),
                    phase,
                    role_ids: core_tab
                        .slots
                        .iter()
                        .map(|slot| slot.role_id.clone())
                        .collect(),
                    source_id: core_tab.source_id.clone(),
                    tab_type: core_tab.tab_type.clone(),
                    title: core_tab.name.clone(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: workspace_template.clone(),
                },
                revision,
                core_selected,
            );
            if !bindings.is_empty() {
                live.surface_bindings
                .insert(tab_id.to_owned(), bindings.clone());
            }
        }
        if let Err(error) = self.try_ensure_native_tab(
            expected_window_id,
            tab_id,
            &core_tab.name,
            &core_tab.tab_type,
            workspace_template.as_deref(),
        ) {
            if let Ok(mut live) = coordinator.lock() {
                let rollback_revision = self.presentation.next_revision();
                live.remove_tab(tab_id, rollback_revision);
            }
            return Err(error.message);
        }
        for binding in bindings {
            self.presentation.assign_surface_owner(
                binding.webview.label(),
                &binding.instance_id,
                expected_window_id,
            )?;
        }
        self.record_presentation_event(
            LogLevel::Debug,
            "tab.presentation-repaired",
            "A live native tab repaired its missing presentation record before activation.",
            expected_window_id,
            Some(tab_id),
            revision,
            "presentation-repair",
            0,
        );
        Ok(true)
    }
}
