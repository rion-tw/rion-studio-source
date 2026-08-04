impl SystemRuntimeExecutor {
    pub fn restore_tab_role_views(
        &self,
        tab_id: &str,
        role_views: &[GameWindowRoleViewRecord],
    ) -> Result<(), String> {
        let role_slots = {
            let state = self.state().map_err(|error| error.message)?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                "Runtime tab was not found while restoring its layout.".to_owned()
            })?;
            role_views
                .iter()
                .filter_map(|view| {
                    let slot = tab.slots.values().find(|slot| slot.role.id == view.role_id)?;
                    Some(GameWindowRoleSlotRecord {
                        slot_id: slot.slot_id.clone(),
                        role_id: view.role_id.clone(),
                        rect: view.rect.clone(),
                        browser_zoom_percent: Some(view.browser_zoom_percent),
                    })
                })
                .collect::<Vec<_>>()
        };
        self.restore_tab_role_slots(tab_id, &role_slots)
    }

    pub fn restore_tab_role_slots(
        &self,
        tab_id: &str,
        role_slots: &[GameWindowRoleSlotRecord],
    ) -> Result<(), String> {
        if role_slots.is_empty() {
            return Ok(());
        }
        let (restored, previous) = {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state.tabs.get_mut(tab_id).ok_or_else(|| {
                "Runtime tab was not found while restoring its layout.".to_owned()
            })?;
            let mut restored = 0;
            let mut previous = Vec::new();
            for saved in role_slots {
                let slot_key = if tab.slots.contains_key(&saved.slot_id) {
                    Some(saved.slot_id.clone())
                } else {
                    tab.slots.iter().find_map(|(slot_id, slot)| {
                        (slot.role.id == saved.role_id).then(|| slot_id.clone())
                    })
                };
                let Some(slot) = slot_key.and_then(|slot_id| tab.slots.get_mut(&slot_id))
                else {
                    continue;
                };
                let previous_surface = tab.roles.get(&saved.role_id).map(|surface| {
                    (
                        surface.rect.clone(),
                        surface.zoom_factor,
                        surface.zoom_mode.clone(),
                    )
                });
                previous.push((
                    slot.slot_id.clone(),
                    slot.rect.clone(),
                    slot.zoom_factor,
                    slot.zoom_mode.clone(),
                    previous_surface,
                ));
                slot.rect = saved.rect.clone();
                slot.zoom_factor = saved
                    .browser_zoom_percent
                    .unwrap_or(100.0)
                    / 100.0;
                slot.zoom_factor = slot
                    .zoom_factor
                    .clamp(0.25, 5.0);
                slot.zoom_mode = if saved.browser_zoom_percent.is_some() {
                    "fixed".to_owned()
                } else {
                    "adaptive".to_owned()
                };
                if let Some(surface) = tab.roles.get_mut(&saved.role_id) {
                    surface.rect = saved.rect.clone();
                    surface.zoom_factor = slot.zoom_factor;
                    surface.zoom_mode.clone_from(&slot.zoom_mode);
                }
                restored += 1;
            }
            (restored, previous)
        };
        if restored == 0 {
            return Err("No saved role slot matched the restored runtime tab.".to_owned());
        }
        if let Err(error) = self.layout_runtime_tab(tab_id) {
            let state_rolled_back = self.state.lock().is_ok_and(|mut state| {
                let Some(tab) = state.tabs.get_mut(tab_id) else {
                    return false;
                };
                let mut restored_slots = 0;
                for (slot_id, rect, zoom_factor, zoom_mode, previous_surface) in previous {
                    if let Some(slot) = tab.slots.get_mut(&slot_id) {
                        slot.rect = rect;
                        slot.zoom_factor = zoom_factor;
                        slot.zoom_mode = zoom_mode;
                        restored_slots += 1;
                    }
                    if let Some((rect, zoom_factor, zoom_mode)) = previous_surface
                        && let Some(role_id) = tab
                            .slots
                            .get(&slot_id)
                            .map(|slot| slot.role.id.clone())
                        && let Some(surface) = tab.roles.get_mut(&role_id)
                    {
                        surface.rect = rect;
                        surface.zoom_factor = zoom_factor;
                        surface.zoom_mode = zoom_mode;
                    }
                }
                restored_slots == restored
            });
            if !state_rolled_back {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{} Restored layout state compensation failed; restart Rion Studio to recover safely.",
                    error.message
                ));
            }
            return Err(error.message);
        }
        Ok(())
    }
}
