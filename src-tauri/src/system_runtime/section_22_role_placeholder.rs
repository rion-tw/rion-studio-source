fn runtime_role_slot_input(slot: &RuntimeRoleSlot) -> LayoutRoleInput {
    LayoutRoleInput {
        role_id: slot.role.id.clone(),
        rect: LayoutRect {
            x: slot.rect.x,
            y: slot.rect.y,
            width: slot.rect.width,
            height: slot.rect.height,
        },
    }
}

fn embedded_role_slot_input(slot: &EmbeddedRoleSlotEffectRecord) -> LayoutRoleInput {
    LayoutRoleInput {
        role_id: slot.role.id.clone(),
        rect: LayoutRect {
            x: slot.rect.x,
            y: slot.rect.y,
            width: slot.rect.width,
            height: slot.rect.height,
        },
    }
}

impl SystemRuntimeExecutor {
    fn create_role_placeholder(
        &self,
        window: &Window,
        window_id: &str,
        tab_id: &str,
        slot: &EmbeddedRoleSlotEffectRecord,
        bounds: RoleBounds,
        selected: bool,
    ) -> RuntimeResult<RolePlaceholderSurface> {
        let owner_tab_name = slot.owner.as_ref().and_then(|owner| {
            self.presentation
                .tab_window(&owner.tab_id)
                .ok()
                .flatten()
                .and_then(|window_id| self.presentation.existing(&window_id))
                .and_then(|presentation| {
                    presentation
                        .lock()
                        .ok()
                        .and_then(|presentation| presentation.tab_title(&owner.tab_id))
                })
        });
        let identity = RuntimeRolePlaceholderIdentity {
            blocked: slot.owner.is_some(),
            owner_generation: slot.owner.as_ref().map(|owner| owner.generation),
            owner_tab_name,
            role_id: slot.role.id.clone(),
            role_name: slot.role.name.clone(),
            slot_id: slot.slot_id.clone(),
            tab_id: tab_id.to_owned(),
        };
        let serialized_identity = serde_json::to_string(&identity).map_err(|error| {
            RuntimeError::new("SYSTEM_ROLE_PLACEHOLDER_INVALID", error.to_string())
        })?;
        let initialization_script = format!(
            "Object.defineProperty(globalThis, '__rionRoleSlotIdentity', {{ configurable: false, enumerable: false, writable: false, value: Object.freeze({serialized_identity}) }});"
        );
        let label = runtime_label(
            "role-placeholder",
            &format!("{tab_id}:{}", slot.slot_id),
        );
        let webview = self.with_native_creation_lane(window_id, || {
            self.add_child_bounded(
                window,
                WebviewBuilder::new(
                    label,
                    WebviewUrl::App("runtime-role-placeholder.html".into()),
                )
                .disable_drag_drop_handler()
                .initialization_script(&initialization_script),
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
                &format!("{tab_id}:placeholder:{}", slot.slot_id),
            )
        })?;
        if selected {
            webview.show().map_err(RuntimeError::tauri)?;
        } else {
            webview.hide().map_err(RuntimeError::tauri)?;
        }
        let surface_instance_id = next_surface_instance_id(webview.label());
        let bound = self
            .presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation.lock().ok().map(|mut presentation| {
                    presentation.bind_surface(
                        tab_id,
                        SurfacePresentationBinding {
                            generation: identity.owner_generation.unwrap_or(0),
                            instance_id: surface_instance_id.clone(),
                            webview: webview.clone(),
                        },
                    )
                })
            })
            .unwrap_or(false);
        if !bound {
            let _ = webview.close();
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                "The runtime tab closed before its role placeholder could bind.",
            ));
        }
        if let Err(message) = self.presentation.assign_surface_owner(
            webview.label(),
            &surface_instance_id,
            window_id,
        ) {
            self.presentation
                .unbind_surface(&surface_instance_id, webview.label());
            let _ = webview.close();
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                message,
            ));
        }
        let inserted = if let Ok(mut state) = self.state.lock() {
            state
                .role_placeholder_identities
                .insert(webview.label().to_owned(), identity);
            true
        } else {
            false
        };
        if !inserted {
            self.presentation
                .unbind_surface(&surface_instance_id, webview.label());
            let _ = webview.close();
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_STATE_UNAVAILABLE",
                "The runtime role placeholder registry is unavailable.",
            ));
        }
        Ok(RolePlaceholderSurface {
            surface_instance_id,
            webview,
        })
    }

    fn close_role_placeholder_surface(
        &self,
        placeholder: RolePlaceholderSurface,
    ) -> RuntimeResult<()> {
        if let Ok(mut state) = self.state.lock() {
            state
                .role_placeholder_identities
                .remove(placeholder.webview.label());
        }
        self.presentation.unbind_surface(
            &placeholder.surface_instance_id,
            placeholder.webview.label(),
        );
        placeholder.webview.close().map_err(RuntimeError::tauri)
    }

    pub(crate) fn authorize_role_placeholder_action(
        &self,
        webview_label: &str,
        action: &RuntimeRolePlaceholderIdentity,
    ) -> RuntimeResult<()> {
        let state = self.state()?;
        let registered = state
            .role_placeholder_identities
            .get(webview_label)
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_ROLE_PLACEHOLDER_UNAUTHORIZED",
                    "This WebView is not an active role placeholder.",
                )
            })?;
        if registered != action {
            return Err(RuntimeError::new(
                "SYSTEM_ROLE_PLACEHOLDER_STALE",
                "The role placeholder changed before the action was submitted.",
            ));
        }
        let slot_current = state.tabs.get(&action.tab_id).is_some_and(|tab| {
            tab.slots.get(&action.slot_id).is_some_and(|slot| {
                slot.role.id == action.role_id
                    && slot.owner_generation == action.owner_generation
                    && slot
                        .placeholder
                        .as_ref()
                        .is_some_and(|surface| surface.webview.label() == webview_label)
            })
        });
        if !slot_current {
            return Err(RuntimeError::new(
                "SYSTEM_ROLE_PLACEHOLDER_STALE",
                "The role slot changed before the action was submitted.",
            ));
        }
        Ok(())
    }
}
