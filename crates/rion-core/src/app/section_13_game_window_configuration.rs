impl AppCore {
    fn delete_game_window(&self, id: String) -> CoreResult<Value> {
        let result = self.mutate_state(StateMutation::GameWindowDelete { id: id.clone() })?;
        self.clear_pending_game_window_configuration(&id)?;
        Ok(result)
    }

    fn save_game_window_configuration(
        &self,
        id: String,
        input: GameWindowUpdateInputRecord,
    ) -> CoreResult<Value> {
        let content_updated = input.tabs.is_some() || input.active_tab_id.is_some();
        let live = content_updated && self.game_window_is_live(&id)?;
        let result = self.mutate_state(StateMutation::GameWindowUpdate {
            id: id.clone(),
            input,
        })?;
        if content_updated {
            if live {
                self.mark_pending_game_window_configuration(&id)?;
            } else {
                self.clear_pending_game_window_configuration(&id)?;
            }
        }
        Ok(result)
    }

    fn game_window_is_live(&self, window_id: &str) -> CoreResult<bool> {
        let runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        Ok(runtime
            .snapshot()
            .windows
            .iter()
            .any(|window| window.window_id == window_id))
    }

    fn mark_pending_game_window_configuration(&self, window_id: &str) -> CoreResult<()> {
        self.pending_game_window_configurations
            .lock()
            .map_err(|_| CoreError::Internal("pending game window configuration lock poisoned".to_owned()))?
            .insert(window_id.to_owned());
        Ok(())
    }

    fn clear_pending_game_window_configuration(&self, window_id: &str) -> CoreResult<()> {
        self.pending_game_window_configurations
            .lock()
            .map_err(|_| CoreError::Internal("pending game window configuration lock poisoned".to_owned()))?
            .remove(window_id);
        Ok(())
    }

    fn clear_pending_game_window_configurations(
        &self,
        window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        let mut pending = self
            .pending_game_window_configurations
            .lock()
            .map_err(|_| CoreError::Internal("pending game window configuration lock poisoned".to_owned()))?;
        for window_id in window_ids {
            pending.remove(window_id);
        }
        Ok(())
    }

    fn project_game_windows_from_runtime(
        &self,
        mut game_windows: Vec<StateGameWindowRecord>,
        previous_snapshot: Option<&crate::model::BrowserRuntimeSnapshot>,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        _removed_window_ids: &std::collections::HashSet<String>,
    ) -> Vec<StateGameWindowRecord> {
        let closing_tabs = self
            .embedded_closing_tabs
            .lock()
            .map(|tabs| tabs.clone())
            .unwrap_or_default();
        let previous_tabs = game_windows
            .iter()
            .flat_map(|window| window.tabs.iter().cloned())
            .map(|tab| (tab.id.clone(), tab))
            .collect::<std::collections::HashMap<_, _>>();
        let previous_live_tab_ids = previous_snapshot.map(|snapshot| {
            snapshot
                .tabs
                .iter()
                .map(|tab| tab.id.clone())
                .collect::<std::collections::HashSet<_>>()
        });
        let live_tab_ids = snapshot
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let no_previous_live_tabs = std::collections::HashSet::new();
        let pending_configurations = self
            .pending_game_window_configurations
            .lock()
            .map(|pending| pending.clone())
            .unwrap_or_default();
        let mut updates = Vec::new();
        for runtime_window in &snapshot.windows {
            let Some(game_window) = game_windows
                .iter_mut()
                .find(|window| window.id == runtime_window.window_id)
            else {
                continue;
            };
            let runtime_tabs = runtime_window
                .tab_ids
                .iter()
                .filter(|tab_id| !closing_tabs.contains(tab_id.as_str()))
                .filter_map(|tab_id| snapshot.tabs.iter().find(|tab| &tab.id == tab_id))
                .map(|tab| {
                    let previous = previous_tabs.get(&tab.id);
                    GameWindowTabRecord {
                        id: tab.id.clone(),
                        tab_type: tab.tab_type.clone(),
                        source_id: tab.source_id.clone(),
                        name: tab.name.clone(),
                        role_slots: previous
                            .map(|tab| tab.role_slots.clone())
                            .unwrap_or_else(|| {
                                tab.slots
                                    .iter()
                                    .map(|slot| GameWindowRoleSlotRecord {
                                        slot_id: slot.slot_id.clone(),
                                        role_id: slot.role_id.clone(),
                                        rect: slot.rect.clone(),
                                        browser_zoom_percent: slot.browser_zoom_percent,
                                    })
                                    .collect()
                            }),
                        hidden: tab.hidden,
                        audio_muted: previous.is_some_and(|tab| tab.audio_muted),
                    }
                })
                .filter(runtime_game_window_tab_is_valid)
                .collect::<Vec<_>>();
            let pending_configuration = pending_configurations.contains(&runtime_window.window_id);
            let tabs = if pending_configuration {
                merge_pending_saved_tabs(&game_window.tabs, &runtime_tabs, &closing_tabs)
            } else {
                merge_runtime_tabs_with_saved(
                    &game_window.tabs,
                    runtime_tabs,
                    previous_live_tab_ids
                        .as_ref()
                        .unwrap_or(&no_previous_live_tabs),
                    &live_tab_ids,
                )
            };
            let active_tab_id = if pending_configuration {
                runtime_window
                    .active_tab_id
                    .as_ref()
                    .filter(|tab_id| !closing_tabs.contains(tab_id.as_str()))
                    .and_then(|tab_id| {
                        snapshot
                            .tabs
                            .iter()
                            .find(|runtime_tab| &runtime_tab.id == tab_id)
                            .and_then(|runtime_tab| {
                                tabs.iter()
                                    .find(|saved_tab| saved_tab_matches_runtime_snapshot(saved_tab, runtime_tab))
                                    .map(|saved_tab| saved_tab.id.clone())
                            })
                    })
                    .or_else(|| {
                        game_window
                            .active_tab_id
                            .clone()
                            .filter(|active| tabs.iter().any(|tab| &tab.id == active))
                    })
            } else {
                runtime_window
                    .active_tab_id
                    .as_ref()
                    .filter(|tab_id| !closing_tabs.contains(tab_id.as_str()))
                    .filter(|tab_id| tabs.iter().any(|tab| &tab.id == *tab_id))
                    .cloned()
                    .or_else(|| {
                        game_window
                            .active_tab_id
                            .clone()
                            .filter(|active| tabs.iter().any(|tab| &tab.id == active))
                    })
            };
            if game_window.tabs == tabs && game_window.active_tab_id == active_tab_id {
                continue;
            }
            game_window.tabs = tabs;
            game_window.active_tab_id = active_tab_id;
            game_window.updated_at = chrono::Utc::now().to_rfc3339();
            updates.push(game_window.clone());
        }
        updates
    }
}

fn saved_tab_matches_runtime(
    saved: &GameWindowTabRecord,
    runtime: &GameWindowTabRecord,
) -> bool {
    saved.id == runtime.id
        || (saved.tab_type == runtime.tab_type && saved.source_id == runtime.source_id)
}

fn saved_tab_matches_runtime_snapshot(
    saved: &GameWindowTabRecord,
    runtime: &crate::model::BrowserRuntimeTabRecord,
) -> bool {
    saved.id == runtime.id
        || (saved.tab_type == runtime.tab_type && saved.source_id == runtime.source_id)
}

fn merge_pending_saved_tabs(
    saved_tabs: &[GameWindowTabRecord],
    runtime_tabs: &[GameWindowTabRecord],
    closing_tabs: &std::collections::HashSet<String>,
) -> Vec<GameWindowTabRecord> {
    saved_tabs
        .iter()
        .map(|saved| {
            let Some(runtime) = runtime_tabs
                .iter()
                .find(|runtime| !closing_tabs.contains(&runtime.id) && saved_tab_matches_runtime(saved, runtime))
            else {
                return saved.clone();
            };
            GameWindowTabRecord {
                id: saved.id.clone(),
                tab_type: saved.tab_type.clone(),
                source_id: saved.source_id.clone(),
                name: runtime.name.clone(),
                role_slots: saved.role_slots.clone(),
                hidden: runtime.hidden,
                audio_muted: runtime.audio_muted,
            }
        })
        .collect()
}
