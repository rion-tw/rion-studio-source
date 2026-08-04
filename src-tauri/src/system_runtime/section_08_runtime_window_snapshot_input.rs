impl SystemRuntimeExecutor {
    pub(crate) fn runtime_game_window_save_input(
        &self,
        window_id: &str,
        name: String,
    ) -> Result<GameWindowSaveRuntimeInputRecord, String> {
        // Persistence is a projection of the already-committed in-memory UI state.
        // Never synchronously query Core, SQLite, AppKit, or a WebView from this
        // path: none of them is allowed to become a second tab authority.
        let live_window = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window was not found while saving.".to_owned())?
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .clone();
        let (target, tabs) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let target = state
                .display_hosts
                .get(window_id)
                .map(|host| host.target.clone())
                .ok_or_else(|| "Runtime window memory was not found while saving.".to_owned())?;
            let tabs = live_window
                .tabs
                .iter()
                .filter(|tab| !state.optimistic_closed_tabs.contains(&tab.id))
                .map(|presentation_tab| {
                    let runtime_tab = state.tabs.get(&presentation_tab.id).ok_or_else(|| {
                        "Runtime tab memory was not found while saving.".to_owned()
                    })?;
                    let mut role_slots = runtime_tab
                        .slots
                        .iter()
                        .map(|(slot_id, slot)| {
                            let surface = runtime_tab.roles.get(&slot.role.id);
                            let zoom_factor = surface
                                .map(|surface| surface.zoom_factor)
                                .unwrap_or(slot.zoom_factor);
                            let zoom_mode = surface
                                .map(|surface| surface.zoom_mode.as_str())
                                .unwrap_or(slot.zoom_mode.as_str());
                            GameWindowRoleSlotRecord {
                                slot_id: slot_id.clone(),
                                role_id: slot.role.id.clone(),
                                rect: slot.rect.clone(),
                                browser_zoom_percent: (zoom_mode == "fixed")
                                    .then_some((zoom_factor * 100.0).clamp(25.0, 500.0)),
                            }
                        })
                        .collect::<Vec<_>>();
                    role_slots.sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
                    Ok(GameWindowTabRecord {
                        id: presentation_tab.id.clone(),
                        tab_type: presentation_tab.tab_type.clone(),
                        source_id: presentation_tab.source_id.clone(),
                        name: presentation_tab.title.clone(),
                        role_slots,
                        hidden: false,
                        audio_muted: runtime_tab.audio_muted,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            (target, tabs)
        };
        let target_display = self
            .window_state_persistence
            .cached_target_display(window_id, target.display_id)
            .unwrap_or(DisplayTargetRecord {
                id: target.display_id,
                fingerprint: None,
            });
        let active_tab_id = live_window
            .selected_tab_id
            .clone()
            .filter(|tab_id| tabs.iter().any(|tab| &tab.id == tab_id));
        Ok(GameWindowSaveRuntimeInputRecord {
            window_id: window_id.to_owned(),
            name,
            target_display,
            placement: GameWindowPlacementRecord {
                normal_bounds: target.bounds,
                saved_work_area: target.work_area,
                presentation: target.presentation,
            },
            tabs,
            active_tab_id,
        })
    }
}
