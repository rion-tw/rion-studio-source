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
