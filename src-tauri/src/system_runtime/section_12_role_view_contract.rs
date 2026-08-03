impl SystemRuntimeExecutor {
    pub fn restore_tab_role_views(
        &self,
        tab_id: &str,
        role_views: &[GameWindowRoleViewRecord],
    ) -> Result<(), String> {
        if role_views.is_empty() {
            return Ok(());
        }
        let (restored, previous) = {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state.tabs.get_mut(tab_id).ok_or_else(|| {
                "Runtime tab was not found while restoring its layout.".to_owned()
            })?;
            let mut restored = 0;
            let mut previous = Vec::new();
            for view in role_views {
                if let Some(surface) = tab.roles.get_mut(&view.role_id) {
                    previous.push((
                        view.role_id.clone(),
                        surface.rect.clone(),
                        surface.zoom_factor,
                        surface.zoom_mode.clone(),
                    ));
                    surface.rect = view.rect.clone();
                    surface.zoom_factor = (view.browser_zoom_percent / 100.0).clamp(0.25, 5.0);
                    surface.zoom_mode = "fixed".to_owned();
                    restored += 1;
                }
            }
            (restored, previous)
        };
        if restored == 0 {
            return Err("No saved role view matched the restored runtime tab.".to_owned());
        }
        if let Err(error) = self.layout_runtime_tab(tab_id) {
            let state_rolled_back = self.state.lock().is_ok_and(|mut state| {
                let Some(tab) = state.tabs.get_mut(tab_id) else {
                    return false;
                };
                let mut restored_roles = 0;
                for (role_id, rect, zoom_factor, zoom_mode) in previous {
                    if let Some(surface) = tab.roles.get_mut(&role_id) {
                        surface.rect = rect;
                        surface.zoom_factor = zoom_factor;
                        surface.zoom_mode = zoom_mode;
                        restored_roles += 1;
                    }
                }
                restored_roles == restored
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
