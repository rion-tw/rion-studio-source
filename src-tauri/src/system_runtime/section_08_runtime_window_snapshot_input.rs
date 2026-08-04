impl SystemRuntimeExecutor {
    pub(crate) fn runtime_game_window_save_input(
        &self,
        window_id: &str,
        name: String,
    ) -> Result<GameWindowSaveRuntimeInputRecord, String> {
        // Core role ownership may legitimately lag the native tab presentation
        // while a launch settles or a close tombstone is being isolated. It is
        // metadata fallback only; LiveWindowTabState owns which tabs are saved.
        let core_tabs = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .ok()
            .and_then(|value| serde_json::from_value::<BrowserRuntimeSnapshot>(value).ok())
            .map(|snapshot| {
                snapshot
                    .tabs
                    .into_iter()
                    .map(|tab| (tab.id.clone(), tab))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let live_window = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window was not found while saving.".to_owned())?
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .clone();
        let live_tabs = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            live_window
                .tabs
                .iter()
                .filter(|tab| {
                    state.tabs.contains_key(&tab.id)
                        && !state.optimistic_closed_tabs.contains(&tab.id)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let primary_id = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .map(super::monitor_id);
        let placement = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| (host.window.clone(), host.target.clone()))
            },
            |(window, target)| {
                let presentation = if window.is_fullscreen().unwrap_or(false) {
                    "fullscreen"
                } else if window.is_maximized().unwrap_or(false) {
                    "maximized"
                } else {
                    "normal"
                };
                let target_display = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .map(|monitor| super::display_target_and_work_area(&monitor, primary_id).0)
                    .unwrap_or(DisplayTargetRecord {
                        id: target.display_id,
                        fingerprint: None,
                    });
                (
                    target_display,
                    GameWindowPlacementRecord {
                        normal_bounds: target.bounds,
                        saved_work_area: target.work_area,
                        presentation: presentation.to_owned(),
                    },
                )
            },
        )
        .ok_or_else(|| "Native runtime window was not found while saving.".to_owned())?;
        let native_tabs = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            live_tabs
                .iter()
                .map(|presentation_tab| {
                    let runtime_tab = state.tabs.get(&presentation_tab.id).ok_or_else(|| {
                        "Native runtime tab was not found while saving.".to_owned()
                    })?;
                    let mut role_slots = runtime_tab
                        .slots
                        .iter()
                        .map(|(slot_id, slot)| {
                            let live = runtime_tab.roles.get(&slot.role.id);
                            let zoom_factor = live
                                .map(|surface| surface.zoom_factor)
                                .unwrap_or(slot.zoom_factor);
                            let zoom_mode = live
                                .map(|surface| surface.zoom_mode.as_str())
                                .unwrap_or(slot.zoom_mode.as_str());
                            (
                                slot_id.clone(),
                                GameWindowRoleSlotRecord {
                                    slot_id: slot_id.clone(),
                                    role_id: slot.role.id.clone(),
                                    rect: slot.rect.clone(),
                                    browser_zoom_percent: (zoom_mode == "fixed").then_some(
                                        (zoom_factor * 100.0).clamp(25.0, 500.0),
                                    ),
                                },
                            )
                        })
                        .collect::<Vec<_>>();
                    role_slots.sort_by(|left, right| left.0.cmp(&right.0));
                    Ok::<_, String>((
                        presentation_tab.id.clone(),
                        (runtime_tab.audio_muted, role_slots),
                    ))
                })
                .collect::<Result<HashMap<_, _>, _>>()?
        };
        let tabs = live_tabs
            .iter()
            .map(|presentation_tab| {
                let core_tab = core_tabs.get(&presentation_tab.id);
                let (audio_muted, native_role_slots) = native_tabs
                    .get(&presentation_tab.id)
                    .ok_or_else(|| "Native runtime tab metadata changed while saving.".to_owned())?;
                let native_role_slots_by_id = native_role_slots
                    .iter()
                    .cloned()
                    .collect::<HashMap<_, _>>();
                let role_slots = core_tab.map_or_else(
                    || {
                        native_role_slots
                            .iter()
                            .map(|(_, slot)| slot.clone())
                            .collect()
                    },
                    |tab| {
                        tab.slots
                            .iter()
                            .map(|slot| {
                                native_role_slots_by_id
                                    .get(&slot.slot_id)
                                    .cloned()
                                    .unwrap_or_else(|| GameWindowRoleSlotRecord {
                                        slot_id: slot.slot_id.clone(),
                                        role_id: slot.role_id.clone(),
                                        rect: slot.rect.clone(),
                                        browser_zoom_percent: slot.browser_zoom_percent,
                                    })
                            })
                            .collect()
                    },
                );
                Ok(GameWindowTabRecord {
                    id: presentation_tab.id.clone(),
                    tab_type: presentation_tab.tab_type.clone(),
                    source_id: presentation_tab.source_id.clone(),
                    name: presentation_tab.title.clone(),
                    role_slots,
                    hidden: core_tab.is_some_and(|tab| tab.hidden),
                    audio_muted: *audio_muted,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(GameWindowSaveRuntimeInputRecord {
            window_id: window_id.to_owned(),
            name,
            target_display: placement.0,
            placement: placement.1,
            tabs,
            active_tab_id: live_window
                .selected_tab_id
                .filter(|tab_id| live_tabs.iter().any(|tab| &tab.id == tab_id)),
        })
    }
}
