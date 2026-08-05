fn unavailable_role_ids_for_create(
    state: &RuntimeState,
    tab: &EmbeddedTabEffectRecord,
) -> HashSet<String> {
    tab.roles
        .iter()
        .filter(|role| {
            state
                .close_coordinator
                .closing_roles
                .contains(&role.role.id)
                || state
                    .close_coordinator
                    .quarantined_roles
                    .contains(&role.role.id)
                || state.surface_registry.values().any(|surface| {
                    surface.role_id.as_deref() == Some(role.role.id.as_str())
                        && surface.phase.blocks_role_relaunch()
                })
        })
        .map(|role| role.role.id.clone())
        .collect()
}

fn retain_available_roles_for_create(
    tab: &mut EmbeddedTabEffectRecord,
    unavailable_role_ids: &HashSet<String>,
) {
    tab.roles
        .retain(|role| !unavailable_role_ids.contains(&role.role.id));
    for slot in &mut tab.slots {
        if unavailable_role_ids.contains(&slot.role.id) {
            slot.state = "stopping".to_owned();
        }
    }
}

fn runtime_tab_from_effect(tab: &EmbeddedTabEffectRecord) -> RuntimeTab {
    RuntimeTab {
        active_divider_resize: None,
        audio_muted: false,
        dividers: Vec::new(),
        roles: HashMap::new(),
        slots: tab
            .slots
            .iter()
            .map(|slot| {
                (
                    slot.slot_id.clone(),
                    RuntimeRoleSlot {
                        owner_generation: slot.owner.as_ref().map(|owner| owner.generation),
                        placeholder: None,
                        rect: slot.rect.clone(),
                        role: slot.role.clone(),
                        slot_id: slot.slot_id.clone(),
                        zoom_factor: slot.zoom_factor.clamp(0.25, 3.0),
                        zoom_mode: slot.zoom_mode.clone(),
                    },
                )
            })
            .collect(),
        workspace_id: tab.workspace_id.clone(),
        workspace_appearance: tab.workspace_appearance.clone(),
        #[cfg(any(windows, target_os = "macos"))]
        workspace_template: tab.workspace_template.clone(),
    }
}

impl SystemRuntimeExecutor {
    fn retire_quarantined_tab_after_close(&self, tab_id: &str) {
        let retired = self.state.lock().ok().and_then(|mut state| {
            let tab = state.tabs.remove(tab_id)?;
            let role_ids = tab.roles.keys().cloned().collect::<Vec<_>>();
            let role_webviews = tab
                .roles
                .values()
                .map(|surface| surface.webview.clone())
                .collect::<Vec<_>>();
            let divider_ids = tab
                .dividers
                .iter()
                .map(|divider| divider.surface_instance_id.clone())
                .collect::<Vec<_>>();
            let placeholders = tab
                .slots
                .values()
                .filter_map(|slot| {
                    slot.placeholder
                        .as_ref()
                        .map(|placeholder| RolePlaceholderSurface {
                            surface_instance_id: placeholder.surface_instance_id.clone(),
                            webview: placeholder.webview.clone(),
                        })
                })
                .collect::<Vec<_>>();
            state
                .role_tabs
                .retain(|_, owner_tab_id| owner_tab_id != tab_id);
            state.launch_attempt_generations.remove(tab_id);
            state.optimistic_closed_tabs.remove(tab_id);
            for role_id in role_ids {
                state.recovery_budgets.remove(&role_id);
                state.recovery_generations.remove(&role_id);
                state.recovering_roles.remove(&role_id);
            }
            for webview in &role_webviews {
                state.audible_webviews.remove(webview.label());
            }
            let tombstone = state.close_previews.remove(tab_id);
            Some((divider_ids, placeholders, role_webviews, tombstone))
        });
        let Some((divider_ids, placeholders, role_webviews, tombstone)) = retired else {
            return;
        };
        for webview in role_webviews {
            let _ = webview.hide();
        }
        for instance_id in divider_ids {
            let _ = self.close_managed_divider(&instance_id);
        }
        for placeholder in placeholders {
            let _ = self.close_role_placeholder_surface(placeholder);
        }
        self.presentation.statuses.remove(tab_id);
        if let Some(tombstone) = tombstone.as_ref() {
            self.record_tab_close_tombstone_resolution(tab_id, tombstone, false);
        }
        self.publish_launcher_presence();
    }
}
