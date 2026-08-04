impl SystemRuntimeExecutor {
    pub(crate) fn launcher_source_is_closing(&self, source_id: &str, tab_type: &str) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state
                .close_previews
                .values()
                .any(|close| tab_close_matches_launcher_source(close, source_id, tab_type))
                || optimistic_close_matches_launcher_source(&state, source_id, tab_type)
        })
    }

    fn runtime_tab_close_projection_fenced(&self, tab_id: &str) -> RuntimeResult<bool> {
        Ok(self.state()?.optimistic_closed_tabs.contains(tab_id))
    }
}

fn optimistic_close_matches_launcher_source(
    state: &RuntimeState,
    source_id: &str,
    tab_type: &str,
) -> bool {
    state.optimistic_closed_tabs.iter().any(|tab_id| {
        state.tabs.get(tab_id).is_some_and(|tab| {
            if tab_type == "workspace" {
                tab.workspace_id.as_deref() == Some(source_id)
            } else {
                tab.roles.contains_key(source_id)
                    || tab
                        .slots
                        .values()
                        .any(|slot| slot.role.id == source_id)
            }
        })
    })
}

fn tab_close_matches_launcher_source(
    close: &TabCloseTombstone,
    source_id: &str,
    tab_type: &str,
) -> bool {
    if tab_type == "workspace" {
        close.tab_type == "workspace" && close.source_id == source_id
    } else {
        (close.tab_type == "role" && close.source_id == source_id)
            || close.role_ids.iter().any(|role_id| role_id == source_id)
            || close
                .slot_owners
                .iter()
                .any(|(_, role_id, _)| role_id == source_id)
    }
}
