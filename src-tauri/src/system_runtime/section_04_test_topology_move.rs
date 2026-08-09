#[cfg(test)]
impl PresentationRegistry {
    fn move_tab(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        revision: u64,
    ) -> Result<(), String> {
        self.move_tab_with_activation(tab_id, source_window_id, target_window_id, revision, true)
    }

    fn move_tab_with_activation(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        revision: u64,
        activate_target_if_selected: bool,
    ) -> Result<(), String> {
        if source_window_id == target_window_id {
            return Ok(());
        }
        let mut source = self
            .existing(source_window_id)
            .map(|source| source.record)
            .ok_or_else(|| "The source presentation state was not found.".to_owned())?;
        let mut target = self.coordinator(target_window_id)?.record;
        let index = source
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| "The moving presentation tab was not found.".to_owned())?;
        let was_selected = source.selected_tab_id.as_deref() == Some(tab_id);
        let successor = was_selected
            .then(|| successor_tab_after_close(&source.tab_ids(), tab_id, |_| true))
            .flatten();
        let tab = source.tabs.remove(index);
        let was_hidden = source.hidden_tab_ids.remove(tab_id);
        if was_selected {
            source.selected_tab_id = successor;
        }
        if !target.contains_tab(tab_id) {
            target.tabs.push(tab);
        }
        if was_hidden {
            target.hidden_tab_ids.insert(tab_id.to_owned());
        }
        if was_selected && activate_target_if_selected {
            target.selected_tab_id = Some(tab_id.to_owned());
        }
        let receipt = self.commit_live_topology(LiveTopologyCommitInput {
            commit_id: format!("test-move-{revision}-{tab_id}"),
            source: "command",
            primary_window_id: target_window_id.to_owned(),
            windows: vec![
                LiveWindowTopologyCommit {
                    active_tab_id: source.selected_tab_id,
                    hidden_tab_ids: source.hidden_tab_ids,
                    tabs: source.tabs,
                    ui_sequence: source.ui_sequence.saturating_add(1).max(1),
                    window_generation: source.window_generation,
                    window_id: source_window_id.to_owned(),
                },
                LiveWindowTopologyCommit {
                    active_tab_id: target.selected_tab_id,
                    hidden_tab_ids: target.hidden_tab_ids,
                    tabs: target.tabs,
                    ui_sequence: target.ui_sequence.saturating_add(1).max(1),
                    window_generation: target.window_generation,
                    window_id: target_window_id.to_owned(),
                },
            ],
        })?;
        if receipt.status == LiveTopologyCommitStatus::Superseded {
            return Err("The test topology move was superseded.".to_owned());
        }
        Ok(())
    }
}
