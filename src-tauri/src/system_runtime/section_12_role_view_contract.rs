impl SystemRuntimeExecutor {
    pub fn prepare_restored_tab_role_slots(
        &self,
        tab_id: &str,
        role_slots: &[GameWindowRoleSlotRecord],
    ) -> Result<(), String> {
        if role_slots.is_empty() {
            return Ok(());
        }
        self.state()
            .map_err(|error| error.message)?
            .pending_restore_role_slots
            .insert(tab_id.to_owned(), role_slots.to_vec());
        Ok(())
    }

    pub fn discard_prepared_tab_role_slots(&self, tab_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_restore_role_slots.remove(tab_id);
        }
    }

    pub fn restore_tab_role_slots(
        &self,
        tab_id: &str,
        role_slots: &[GameWindowRoleSlotRecord],
    ) -> Result<(), String> {
        if role_slots.is_empty() {
            return Ok(());
        }
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer live while restoring its layout.".to_owned())?;
        let live = self
            .presentation
            .existing(&window_id)
            .ok_or_else(|| "Runtime window topology is unavailable while restoring.".to_owned())?;
        let previous_role_slots = live
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.role_slots.clone())
            .ok_or_else(|| "Runtime tab topology is unavailable while restoring.".to_owned())?;
        let mut desired_role_slots = previous_role_slots.clone();
        let mut matched = 0;
        for saved in role_slots {
            let Some(slot) = desired_role_slots.iter_mut().find(|slot| {
                slot.slot_id == saved.slot_id || slot.role_id == saved.role_id
            }) else {
                continue;
            };
            slot.rect = saved.rect.clone();
            slot.browser_zoom_percent = saved.browser_zoom_percent;
            matched += 1;
        }
        if matched == 0 {
            return Err("No saved role slot matched the restored runtime tab.".to_owned());
        }
        let desired = self.presentation.live.commit_tab_role_slots(
            live.revision,
            tab_id,
            &window_id,
            desired_role_slots,
        )?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Err("Restored runtime role slots were superseded before native projection."
                .to_owned());
        }
        let projection = (|| -> Result<(usize, Vec<_>), String> {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state.native_resources.tabs.get_mut(tab_id).ok_or_else(|| {
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
                    (surface.rect.clone(), surface.zoom_factor)
                });
                previous.push((
                    slot.slot_id.clone(),
                    slot.rect.clone(),
                    slot.zoom_factor,
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
                if let Some(surface) = tab.roles.get_mut(&saved.role_id) {
                    surface.rect = saved.rect.clone();
                    surface.zoom_factor = slot.zoom_factor;
                }
                restored += 1;
            }
            Ok((restored, previous))
        })();
        let (restored, previous) = match projection {
            Ok(value) => value,
            Err(error) => {
                let compensation = self.presentation.live.commit_tab_role_slots(
                    desired.revision,
                    tab_id,
                    &window_id,
                    previous_role_slots,
                );
                if compensation.is_err()
                    || compensation
                        .is_ok_and(|receipt| receipt.status == LiveTopologyCommitStatus::Superseded)
                {
                    self.health.mark_unhealthy();
                    return Err(format!(
                        "{error} Kernel role-slot compensation was superseded; restart Rion Studio to recover safely."
                    ));
                }
                return Err(error);
            }
        };
        if restored == 0 {
            let compensation = self.presentation.live.commit_tab_role_slots(
                desired.revision,
                tab_id,
                &window_id,
                previous_role_slots,
            );
            if compensation.is_err()
                || compensation
                    .is_ok_and(|receipt| receipt.status == LiveTopologyCommitStatus::Superseded)
            {
                self.health.mark_unhealthy();
            }
            return Err("No saved role slot matched the restored native runtime tab.".to_owned());
        }
        if let Err(error) = self.layout_runtime_tab(tab_id) {
            let state_rolled_back = self.state.lock().is_ok_and(|mut state| {
                let Some(tab) = state.native_resources.tabs.get_mut(tab_id) else {
                    return false;
                };
                let mut restored_slots = 0;
                for (slot_id, rect, zoom_factor, previous_surface) in previous {
                    if let Some(slot) = tab.slots.get_mut(&slot_id) {
                        slot.rect = rect;
                        slot.zoom_factor = zoom_factor;
                        restored_slots += 1;
                    }
                    if let Some((rect, zoom_factor)) = previous_surface
                        && let Some(role_id) = tab
                            .slots
                            .get(&slot_id)
                            .map(|slot| slot.role.id.clone())
                        && let Some(surface) = tab.roles.get_mut(&role_id)
                    {
                        surface.rect = rect;
                        surface.zoom_factor = zoom_factor;
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
            let compensation = self.presentation.live.commit_tab_role_slots(
                desired.revision,
                tab_id,
                &window_id,
                previous_role_slots,
            );
            if compensation.is_err()
                || compensation
                    .is_ok_and(|receipt| receipt.status == LiveTopologyCommitStatus::Superseded)
            {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{} Native layout rolled back but Kernel role-slot compensation was superseded; restart Rion Studio to recover safely.",
                    error.message
                ));
            }
            return Err(error.message);
        }
        Ok(())
    }
}

fn apply_prepared_role_slots_to_effect(
    state: &mut RuntimeState,
    tab: &mut EmbeddedTabEffectRecord,
) -> RuntimeResult<()> {
    let Some(role_slots) = state.pending_restore_role_slots.get(&tab.tab_id).cloned() else {
        return Ok(());
    };
    let mut restored = 0;
    for saved in &role_slots {
        let Some(slot) = tab
            .slots
            .iter_mut()
            .find(|slot| slot.slot_id == saved.slot_id || slot.role.id == saved.role_id)
        else {
            continue;
        };
        let zoom_factor = (saved.browser_zoom_percent.unwrap_or(100.0) / 100.0).clamp(0.25, 3.0);
        slot.rect = saved.rect.clone();
        slot.zoom_factor = zoom_factor;
        if let Some(role) = tab
            .roles
            .iter_mut()
            .find(|role| role.role.id == saved.role_id)
        {
            role.rect = saved.rect.clone();
            role.zoom_factor = zoom_factor;
        }
        restored += 1;
    }
    if restored == 0 {
        return Err(RuntimeError::new(
            "SYSTEM_RUNTIME_RESTORE_SLOT_MISMATCH",
            "No saved role slot matched the native tab creation effect.",
        ));
    }
    state.pending_restore_role_slots.remove(&tab.tab_id);
    Ok(())
}
