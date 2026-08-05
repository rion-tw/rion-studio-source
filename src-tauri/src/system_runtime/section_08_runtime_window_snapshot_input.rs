fn persisted_role_slots_from_effect(
    slots: &[EmbeddedRoleSlotEffectRecord],
) -> Vec<GameWindowRoleSlotRecord> {
    slots
        .iter()
        .map(|slot| GameWindowRoleSlotRecord {
            slot_id: slot.slot_id.clone(),
            role_id: slot.role.id.clone(),
            rect: slot.rect.clone(),
            browser_zoom_percent: (slot.zoom_mode == "fixed")
                .then_some((slot.zoom_factor * 100.0).clamp(25.0, 500.0)),
        })
        .collect()
}

impl SystemRuntimeExecutor {
    fn refresh_live_window_persistence_metadata(&self, window_id: &str) -> Result<(), String> {
        let presentation = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window was not found while saving.".to_owned())?;
        let tab_ids = presentation
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .all_tab_ids();
        let metadata = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            tab_ids
                .iter()
                .filter_map(|tab_id| {
                    let runtime_tab = state.tabs.get(tab_id)?;
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
                    Some((tab_id.clone(), role_slots, runtime_tab.audio_muted))
                })
                .collect::<Vec<_>>()
        };
        let mut live = presentation
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?;
        for (tab_id, role_slots, audio_muted) in metadata {
            live.update_persistence_metadata(&tab_id, role_slots, audio_muted);
        }
        Ok(())
    }

    fn live_game_window_tabs(live: &LiveWindowTabState) -> Vec<GameWindowTabRecord> {
        live.tabs
            .iter()
            .filter(|tab| tab.persistable)
            .map(|tab| GameWindowTabRecord {
                id: tab.id.clone(),
                tab_type: tab.tab_type.clone(),
                source_id: tab.source_id.clone(),
                name: tab.title.clone(),
                role_slots: tab.role_slots.clone(),
                hidden: live.tab_is_hidden(&tab.id),
                audio_muted: tab.audio_muted,
            })
            .collect()
    }

    pub(crate) fn runtime_game_window_save_input(
        &self,
        window_id: &str,
        name: String,
    ) -> Result<GameWindowSaveRuntimeInputRecord, String> {
        // The live presentation is the complete tab snapshot. Runtime role
        // memory may refresh slot/audio metadata, but it cannot add, remove,
        // reorder, select, or hide a tab in this persistence path.
        self.refresh_live_window_persistence_metadata(window_id)?;
        let live_window = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window was not found while saving.".to_owned())?
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .clone();
        let target = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .display_hosts
            .get(window_id)
            .map(|host| host.target.clone())
            .ok_or_else(|| "Runtime window memory was not found while saving.".to_owned())?;
        let tabs = Self::live_game_window_tabs(&live_window);
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
