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
    fn live_game_window_tabs(live: &LiveWindowRecord) -> Vec<GameWindowTabRecord> {
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
        let live_window = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window was not found while saving.".to_owned())?
            .record;
        let tabs = Self::live_game_window_tabs(&live_window);
        let target_display = live_window
            .target_display
            .clone()
            .ok_or_else(|| "Live runtime window placement is not initialized.".to_owned())?;
        let placement = live_window
            .placement
            .clone()
            .ok_or_else(|| "Live runtime window placement is not initialized.".to_owned())?;
        let active_tab_id = live_window
            .selected_tab_id
            .clone()
            .filter(|tab_id| tabs.iter().any(|tab| &tab.id == tab_id));
        Ok(GameWindowSaveRuntimeInputRecord {
            window_id: window_id.to_owned(),
            name,
            target_display,
            placement,
            tabs,
            active_tab_id,
        })
    }
}
