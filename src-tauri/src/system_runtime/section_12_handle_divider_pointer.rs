fn workspace_slots_after_divider_resize(
    previous: &[StateWorkspaceSlotRecord],
    resized_roles: &[LayoutRoleInput],
    slot_ids_by_role: &HashMap<String, String>,
) -> Result<Vec<StateWorkspaceSlotRecord>, String> {
    let mut desired = previous.to_vec();
    for role in resized_roles {
        let slot_id = slot_ids_by_role.get(&role.role_id).ok_or_else(|| {
            format!(
                "Runtime divider surface {} has no native slot identity.",
                role.role_id
            )
        })?;
        let Some(slot) = desired.iter_mut().find(|slot| &slot.id == slot_id) else {
            return Err(format!(
                "Runtime divider slot {} has no authoritative workspace layout.",
                slot_id
            ));
        };
        slot.rect = StateNormalizedRectRecord {
            x: role.rect.x,
            y: role.rect.y,
            width: role.rect.width,
            height: role.rect.height,
        };
    }
    Ok(desired)
}

impl SystemRuntimeExecutor {
    pub fn handle_divider_pointer(
        &self,
        webview_label: &str,
        payload: DividerPointerPayload,
    ) -> Result<(), String> {
        if !matches!(payload.phase.as_str(), "start" | "move" | "end" | "reset") {
            return Err("divider pointer phase is invalid".to_owned());
        }
        let context = {
            let mut state = self.state().map_err(|error| error.message)?;
            let Some((tab_id, tab)) = state.native_resources.tabs.iter_mut().find(|(_, tab)| {
                tab.dividers
                    .iter()
                    .any(|divider| divider.webview.label() == webview_label)
            }) else {
                return Err("divider bridge is not authorized for this WebView".to_owned());
            };
            let divider = tab
                .dividers
                .iter()
                .find(|divider| divider.webview.label() == webview_label)
                .ok_or_else(|| "runtime divider was not found".to_owned())?;
            let window_id = self
                .presentation
                .tab_window(tab_id)?
                .ok_or_else(|| "Runtime divider tab is no longer live.".to_owned())?;
            if payload.phase == "end" {
                let active = tab.active_divider_resize.take();
                let role_ids = active.map(|value| value.role_ids).unwrap_or_default();
                let tab_id = tab_id.clone();
                drop(state);
                self.send_divider_indicators(&role_ids, "hide");
                self.persist_runtime_tab_role_views(&tab_id)?;
                return Ok(());
            }
            let previous = tab
                .active_divider_resize
                .as_ref()
                .filter(|active| active.divider_index == divider.index)
                .map(|active| active.snapped_position);
            let tab_context = (
                tab_id.clone(),
                divider.index,
                divider.descriptor.clone(),
                tab.dividers
                    .iter()
                    .map(|divider| divider.descriptor.clone())
                    .collect::<Vec<_>>(),
                tab.slots
                    .values()
                    .map(runtime_role_slot_input)
                    .collect::<Vec<_>>(),
                tab.slots
                    .values()
                    .map(|slot| (slot.role.id.clone(), slot.slot_id.clone()))
                    .collect::<HashMap<_, _>>(),
                window_id,
                previous,
                tab.active_divider_resize.clone(),
            );
            let host = state.native_resources.display_hosts.get(&tab_context.6).ok_or_else(|| {
                "runtime display host was not found for divider WebView".to_owned()
            })?;
            #[cfg(windows)]
            let toolbar_revealed = host.toolbar_revealed;
            #[cfg(not(windows))]
            let toolbar_revealed = false;
            (
                tab_context.0,
                tab_context.1,
                tab_context.2,
                tab_context.3,
                tab_context.4,
                tab_context.5,
                tab_context.6,
                tab_context.7,
                tab_context.8,
                host.window.clone(),
                toolbar_revealed,
            )
        };
        let (
            tab_id,
            divider_index,
            divider,
            dividers,
            roles,
            slot_ids_by_role,
            window_id,
            previous,
            previous_active_resize,
            window,
            _toolbar_revealed,
        ) = context;
        let requested_position = if payload.phase == "reset" {
            divider.default_position
        } else {
            let event_screen_position =
                payload
                    .screen_position
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| "divider screen position is invalid".to_owned())?;
            let scale = window.scale_factor().map_err(|error| error.to_string())?;
            let position = window.inner_position().map_err(|error| error.to_string())?;
            #[cfg(windows)]
            let metrics = runtime_window_content_metrics_with_tab_strip(
                &window,
                self.windows_tab_strip_height(&window, _toolbar_revealed),
            )
            .map_err(|error| error.message)?;
            #[cfg(not(windows))]
            let metrics = runtime_window_content_metrics(&window).map_err(|error| error.message)?;
            let screen_position = if cfg!(windows) {
                let cursor = self
                    .app
                    .cursor_position()
                    .map_err(|error| error.to_string())?;
                if divider.axis == "vertical" {
                    cursor.x / scale
                } else {
                    cursor.y / scale
                }
            } else {
                event_screen_position
            };
            if divider.axis == "vertical" {
                (screen_position - position.x as f64 / scale) / metrics.width.max(1.0)
            } else {
                (screen_position - position.y as f64 / scale - metrics.top_inset)
                    / metrics.height.max(1.0)
            }
        };
        let result = rion_core::resize_workspace_divider(&WorkspaceDividerResizeInput {
            roles: roles.clone(),
            dividers,
            divider_index,
            requested_position,
            previous_position: (payload.phase == "move").then_some(previous).flatten(),
        })
        .ok_or_else(|| "Runtime divider layout could not be resolved.".to_owned())?;
        let live = self
            .presentation
            .existing(&window_id)
            .ok_or_else(|| "Runtime divider topology is unavailable.".to_owned())?;
        let previous_workspace_slots = live
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.workspace_slots.clone())
            .ok_or_else(|| "Runtime divider tab topology is unavailable.".to_owned())?;
        let desired_workspace_slots = workspace_slots_after_divider_resize(
            &previous_workspace_slots,
            &result.roles,
            &slot_ids_by_role,
        )?;
        let desired = self.presentation.live.commit_tab_workspace_slots(
            live.revision,
            &tab_id,
            &window_id,
            desired_workspace_slots,
        )?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Err("Runtime divider update was superseded before native projection."
                .to_owned());
        }
        let projection_state_commit = (|| -> Result<(), String> {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state
                .native_resources.tabs
                .get_mut(&tab_id)
                .ok_or_else(|| "runtime tab was closed during divider resize".to_owned())?;
            for role in &result.roles {
                if let Some(slot) = tab
                    .slots
                    .values_mut()
                    .find(|slot| slot.role.id == role.role_id)
                {
                    slot.rect = StateNormalizedRectRecord {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    };
                }
                if let Some(surface) = tab.roles.get_mut(&role.role_id) {
                    surface.rect = StateNormalizedRectRecord {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    };
                }
            }
            if payload.phase == "start" {
                tab.active_divider_resize = Some(ActiveDividerResize {
                    divider_index,
                    role_ids: result.role_ids.clone(),
                    snapped_position: result.position,
                });
            } else if payload.phase == "move"
                && let Some(active) = tab.active_divider_resize.as_mut()
            {
                active.role_ids = result.role_ids.clone();
                active.snapped_position = result.position;
            } else if payload.phase == "reset" {
                tab.active_divider_resize = None;
            }
            Ok(())
        })();
        if let Err(error) = projection_state_commit {
            let compensation = self.presentation.live.commit_tab_workspace_slots(
                desired.revision,
                &tab_id,
                &window_id,
                previous_workspace_slots,
            );
            if compensation.is_err()
                || compensation
                    .is_ok_and(|receipt| receipt.status == LiveTopologyCommitStatus::Superseded)
            {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{error} Kernel divider compensation was superseded; restart Rion Studio to recover safely."
                ));
            }
            return Err(error);
        }
        if result.changed
            && let Err(error) = self.layout_runtime_tab(&tab_id)
        {
                let state_rolled_back = self.state.lock().is_ok_and(|mut state| {
                    let Some(tab) = state.native_resources.tabs.get_mut(&tab_id) else {
                        return false;
                    };
                    let mut restored_roles = 0;
                    for role in &roles {
                        if let Some(slot) = tab
                            .slots
                            .values_mut()
                            .find(|slot| slot.role.id == role.role_id)
                        {
                            slot.rect = StateNormalizedRectRecord {
                                x: role.rect.x,
                                y: role.rect.y,
                                width: role.rect.width,
                                height: role.rect.height,
                            };
                            restored_roles += 1;
                        }
                        if let Some(surface) = tab.roles.get_mut(&role.role_id) {
                            surface.rect = StateNormalizedRectRecord {
                                x: role.rect.x,
                                y: role.rect.y,
                                width: role.rect.width,
                                height: role.rect.height,
                            };
                        }
                    }
                    tab.active_divider_resize = previous_active_resize;
                    restored_roles == roles.len()
                });
                if !state_rolled_back {
                    self.health.mark_unhealthy();
                    return Err(format!(
                        "{} Runtime layout state compensation failed; restart Rion Studio to recover safely.",
                        error.message
                    ));
                }
                let compensation = self.presentation.live.commit_tab_workspace_slots(
                    desired.revision,
                    &tab_id,
                    &window_id,
                    previous_workspace_slots,
                );
                if compensation.is_err()
                    || compensation.is_ok_and(|receipt| {
                        receipt.status == LiveTopologyCommitStatus::Superseded
                    })
                {
                    self.health.mark_unhealthy();
                    return Err(format!(
                        "{} Native divider layout rolled back but Kernel compensation was superseded; restart Rion Studio to recover safely.",
                        error.message
                    ));
                }
                return Err(error.message);
        }
        let indicator_type = if payload.phase == "start" {
            "show"
        } else {
            "update"
        };
        self.send_divider_indicators(&result.role_ids, indicator_type);
        if payload.phase == "reset" {
            self.send_divider_indicators(&result.role_ids, "hide");
            self.persist_runtime_tab_role_views(&tab_id)?;
        }
        Ok(())
    }

    fn persist_runtime_tab_role_views(&self, tab_id: &str) -> Result<(), String> {
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer live while saving its layout.".to_owned())?;
        if self.presentation.tab(&window_id, tab_id).is_none() {
            return Err("Runtime tab layout is no longer authoritative.".to_owned());
        }
        self.schedule_live_window_state_persistence(&window_id);
        Ok(())
    }

    fn send_divider_indicators(&self, role_ids: &[String], indicator_type: &str) {
        let surfaces = self.state.lock().ok().map(|state| {
            role_ids
                .iter()
                .filter_map(|role_id| {
                    let tab_id = state.native_tab_id_for_role_surface(role_id)?;
                    let role = state.native_resources.tabs.get(tab_id)?.roles.get(role_id)?;
                    Some((role.webview.clone(), role.rect.clone()))
                })
                .collect::<Vec<_>>()
        });
        for (webview, rect) in surfaces.unwrap_or_default() {
            let payload = if indicator_type == "hide" {
                json!({ "type": "hide" })
            } else {
                json!({
                    "type": indicator_type,
                    "label": format!("{} × {}", format_ratio(rect.width), format_ratio(rect.height))
                })
            };
            let _ = webview.eval(format!(
                "globalThis.__rionStudioWorkspaceResizeIndicator?.({payload});"
            ));
        }
    }

    pub fn request_focused_runtime_fullscreen(
        &self,
    ) -> Result<Option<String>, String> {
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .native_resources.display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(None);
        };
        self.request_runtime_window_toggle_fullscreen(&window_id)
            .map(|(_, operation_id)| Some(operation_id))
    }

    pub fn toggle_runtime_window_fullscreen(
        &self,
        window_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        let (revision, operation_id) =
            self.request_runtime_window_toggle_fullscreen(window_id)?;
        self.wait_for_presentation_paint_barrier(window_id, revision);
        let summary = self.wait_native_operation_summary(&operation_id)?;
        #[cfg(windows)]
        if matches!(
            summary.status,
            SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
        ) {
            if let Err(error) = self.refresh_windows_active_window_layout(window_id) {
                eprintln!(
                    "Windows fullscreen toolbar layout refresh failed for {window_id}: {error}"
                );
            }
            self.publish_projection();
        }
        Ok(summary)
    }

    fn request_runtime_window_toggle_fullscreen(
        &self,
        window_id: &str,
    ) -> Result<(u64, String), String> {
        self.require_runtime_accepting()
            .map_err(|error| error.message)?;
        #[cfg(target_os = "macos")]
        {
            let window = self
                .window_for_id(window_id)
                .ok_or_else(|| "Runtime window was not found.".to_owned())?;
            let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
            self.prepare_runtime_window_fullscreen(window.label(), !fullscreen);
        }
        let (revision, operation_id) = self
            .request_window_contract_presentation(
                window_id,
                None,
                NativePresentationFocus::None,
                Some(NativeWindowMode::ToggleFullscreen),
                "toggle-fullscreen",
            )
            .map_err(|error| error.message)?;
        Ok((revision, operation_id))
    }

    pub fn zoom_focused_runtime(&self, action: &str) -> Result<bool, String> {
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .native_resources.display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(false);
        };
        self.zoom_runtime_window(&window_id, action)
    }

    pub fn zoom_runtime_window(&self, window_id: &str, action: &str) -> Result<bool, String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Zoom,
            "zoomRuntimeWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_window(window_id);
        let result = self.apply_runtime_window_zoom(window_id, action);
        let receipt = match result.as_ref() {
            Ok(_) => NativeOperationReceipt::applied(operation, "windowZoomApplied"),
            Err(message)
                if message
                    .to_ascii_lowercase()
                    .contains("compensation also failed") =>
            {
                NativeOperationReceipt::with_status(
                    operation,
                    "windowZoomRollbackFailed",
                    NativeOperationStatus::Indeterminate,
                    Some("SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"),
                )
            }
            Err(_) => NativeOperationReceipt::with_status(
                operation,
                "windowZoomFailed",
                NativeOperationStatus::Failed,
                Some("TAURI_RUNTIME_ZOOM_FAILED"),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn apply_runtime_window_zoom(&self, window_id: &str, action: &str) -> Result<bool, String> {
        if !matches!(action, "in" | "out" | "reset") {
            return Err("Runtime window zoom action is invalid.".to_owned());
        }
        if !self
            .state()
            .map_err(|error| error.message)?
            .native_resources.display_hosts
            .contains_key(window_id)
        {
            return Ok(false);
        }
        let live = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime window topology is unavailable while zooming.".to_owned())?;
        let current_zoom = live.window_zoom_factor.unwrap_or(1.0);
        let next_zoom = next_zoom_factor(current_zoom, action, 0.25, 5.0);
        let Some(tab_id) = self.presentation.selected_tabs().remove(window_id)
        else {
            return Ok(false);
        };
        let live_tab_ids = self
            .live_tab_ids_for_window(window_id)
            .into_iter()
            .collect::<HashSet<_>>();
        let (surface_projections, visible_role_ids) = {
            let state = self.state().map_err(|error| error.message)?;
            let Some(active_tab) = state.native_resources.tabs.get(&tab_id) else {
                return Ok(false);
            };
            let visible_role_ids = active_tab.roles.keys().cloned().collect::<HashSet<_>>();
            let surfaces = state
                .native_resources.tabs
                .iter()
                .filter(|(tab_id, _)| live_tab_ids.contains(*tab_id))
                .flat_map(|(_, tab)| {
                    tab.roles.iter().map(|(role_id, surface)| {
                        (
                            tab_id.clone(),
                            role_id.clone(),
                            surface.webview.clone(),
                            surface.zoom_factor,
                        )
                    })
                })
                .collect::<Vec<_>>();
            (surfaces, visible_role_ids)
        };
        let surfaces = surface_projections
            .into_iter()
            .map(|(tab_id, role_id, webview, projected_zoom)| {
                let (base, _) = self.runtime_role_zoom_contract(
                    window_id,
                    &tab_id,
                    &role_id,
                    projected_zoom,
                );
                (
                    role_id,
                    webview,
                    effective_zoom_factor(base, current_zoom),
                    effective_zoom_factor(base, next_zoom),
                )
            })
            .collect::<Vec<_>>();
        let popup_projections = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, role_id)| {
                    let tab_id = state.native_tab_id_for_role_surface(role_id)?;
                    let tab = state.native_resources.tabs.get(tab_id)?;
                    if !live_tab_ids.contains(tab_id) {
                        return None;
                    }
                    let base = tab.roles.get(role_id)?.zoom_factor;
                    Some((
                        label.clone(),
                        tab_id.clone(),
                        role_id.clone(),
                        base,
                    ))
                })
                .collect::<Vec<_>>()
        };
        let popup_surfaces = popup_projections
            .into_iter()
            .map(|(label, tab_id, role_id, projected_zoom)| {
                let (base, _) = self.runtime_role_zoom_contract(
                    window_id,
                    &tab_id,
                    &role_id,
                    projected_zoom,
                );
                (
                    label,
                    effective_zoom_factor(base, current_zoom),
                    effective_zoom_factor(base, next_zoom),
                )
            })
            .collect::<Vec<_>>();
        let mut zoom_mutations = surfaces
            .iter()
            .map(|(_, webview, previous_zoom, zoom)| (webview.clone(), *previous_zoom, *zoom))
            .collect::<Vec<_>>();
        for (label, previous_zoom, zoom) in popup_surfaces {
            let webview = self
                .app
                .get_webview(&label)
                .ok_or_else(|| format!("Runtime popup {label} has no live native handle."))?;
            zoom_mutations.push((webview, previous_zoom, zoom));
        }
        let desired = self.presentation.live.commit_window_zoom_factor(
            live.revision,
            window_id,
            next_zoom,
        )?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Err("Runtime window zoom was superseded before native submission.".to_owned());
        }
        if let Err(failure) = apply_reversible_fanout(
            &zoom_mutations,
            |index, (webview, _, zoom)| {
                webview
                    .set_zoom(*zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
            |index, (webview, previous_zoom, _)| {
                webview
                    .set_zoom(*previous_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            let compensation = self.presentation.live.commit_window_zoom_factor(
                desired.revision,
                window_id,
                current_zoom,
            );
            if match compensation.as_ref() {
                Ok(receipt) => receipt.status == LiveTopologyCommitStatus::Superseded,
                Err(_) => true,
            } {
                self.health.mark_unhealthy();
                return Err(format!(
                    "Native zoom failed and the authoritative Kernel compensation was superseded: {}",
                    failure.apply_error
                ));
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_ZOOM_FAILED",
                "Updating runtime window zoom",
                &failure,
            )
            .message);
        }
        let label = self.window_zoom_indicator_label(next_zoom);
        for (role_id, webview, _, _) in surfaces {
            if visible_role_ids.contains(&role_id) {
                show_zoom_indicator(&webview, &label);
            }
        }
        Ok(true)
    }

}
