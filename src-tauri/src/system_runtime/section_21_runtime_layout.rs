enum NativeLayoutMutation {
    Bounds {
        next_position: LogicalPosition<f64>,
        next_size: LogicalSize<f64>,
        webview: Webview,
    },
    Zoom {
        next: f64,
        webview: Webview,
    },
}

impl NativeLayoutMutation {
    fn apply(&self) -> Result<(), String> {
        match self {
            Self::Bounds {
                next_position,
                next_size,
                webview,
                ..
            } => webview
                .set_bounds(tauri::Rect {
                    position: (*next_position).into(),
                    size: (*next_size).into(),
                })
                .map_err(|error| error.to_string()),
            Self::Zoom { next, webview, .. } => {
                webview.set_zoom(*next).map_err(|error| error.to_string())
            }
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Bounds { webview, .. } | Self::Zoom { webview, .. } => webview.label(),
        }
    }
}

fn native_layout_bounds_mutation(
    webview: Webview,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> NativeLayoutMutation {
    NativeLayoutMutation::Bounds {
        next_position: position,
        next_size: size,
        webview,
    }
}

fn zoom_factor_changed(previous: f64, next: f64) -> bool {
    (previous - next).abs() > 0.000_1
}

impl SystemRuntimeExecutor {
    fn resolve_runtime_layout(
        &self,
        metrics: WindowContentMetrics,
        roles: Vec<LayoutRoleInput>,
        gap: u32,
    ) -> RuntimeResult<ResolvedRuntimeLayout> {
        let descriptors = self
            .core
            .invoke(CoreCommand::LayoutCreateDividers {
                roles: roles.clone(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<Vec<WorkspaceDividerDescriptor>>(value)
                    .map_err(|error| RuntimeError::new("TAURI_LAYOUT_INVALID", error.to_string()))
            })?;
        let output = self
            .core
            .invoke(CoreCommand::LayoutResolve {
                input: WorkspaceLayoutInput {
                    active: true,
                    hidden: false,
                    window_visible: true,
                    content_bounds: LayoutBounds {
                        x: 0,
                        y: metrics.top_inset.round() as i32,
                        width: metrics.width.round().max(1.0) as i32,
                        height: metrics.height.round().max(1.0) as i32,
                    },
                    gap,
                    roles,
                    dividers: descriptors
                        .iter()
                        .map(|divider| LayoutDividerInput {
                            axis: divider.axis.clone(),
                            before_role_ids: divider.before_role_ids.clone(),
                            after_role_ids: divider.after_role_ids.clone(),
                        })
                        .collect(),
                },
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<WorkspaceLayoutOutput>(value)
                    .map_err(|error| RuntimeError::new("TAURI_LAYOUT_INVALID", error.to_string()))
            })?;
        let roles = output
            .roles
            .into_iter()
            .map(|role| {
                (
                    role.role_id,
                    RoleBounds {
                        x: role.bounds.x as f64,
                        y: role.bounds.y as f64,
                        width: role.bounds.width.max(1) as f64,
                        height: role.bounds.height.max(1) as f64,
                    },
                )
            })
            .collect();
        let dividers = output
            .dividers
            .into_iter()
            .filter_map(|divider| {
                descriptors
                    .get(divider.index as usize)
                    .cloned()
                    .map(|descriptor| {
                        (
                            divider.index,
                            descriptor,
                            RoleBounds {
                                x: divider.bounds.x as f64,
                                y: divider.bounds.y as f64,
                                width: divider.bounds.width.max(1) as f64,
                                height: divider.bounds.height.max(1) as f64,
                            },
                        )
                    })
            })
            .collect();
        Ok((roles, dividers))
    }

    fn layout_runtime_tab_inner(&self, tab_id: &str) -> RuntimeResult<()> {
        self.layout_runtime_tab_inner_with_metrics(tab_id, None)
    }

    fn layout_runtime_tab_inner_with_metrics(
        &self,
        tab_id: &str,
        metrics_override: Option<WindowContentMetrics>,
    ) -> RuntimeResult<()> {
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let (
            window,
            role_views,
            role_generations,
            divider_views,
            gap,
            window_zoom_factor,
            tab_strip,
            _toolbar_revealed,
        ) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let host = state.display_hosts.get(&window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            (
                host.window.clone(),
                tab.slots
                    .values()
                    .filter_map(|slot| {
                        let (webview, current_zoom, zoom_mode, role_surface) =
                            if let Some(surface) = tab.roles.get(&slot.role.id) {
                                (
                                    surface.webview.clone(),
                                    surface.zoom_factor,
                                    surface.zoom_mode.clone(),
                                    true,
                                )
                            } else {
                                let placeholder = slot.placeholder.as_ref()?;
                                (
                                    placeholder.webview.clone(),
                                    slot.zoom_factor,
                                    slot.zoom_mode.clone(),
                                    false,
                                )
                            };
                        Some((
                            slot.role.id.clone(),
                            webview,
                            current_zoom,
                            zoom_mode,
                            role_surface,
                            runtime_role_slot_input(slot),
                        ))
                    })
                    .collect::<Vec<_>>(),
                tab.roles
                    .iter()
                    .map(|(role_id, surface)| {
                        (
                            surface.webview.label().to_owned(),
                            role_id.clone(),
                            surface.generation,
                        )
                    })
                    .collect::<Vec<_>>(),
                tab.dividers
                    .iter()
                    .map(|divider| (divider.index, divider.webview.clone()))
                    .collect::<HashMap<_, _>>(),
                tab.workspace_appearance.gap,
                host.zoom_factor,
                #[cfg(windows)]
                Some(host.tab_strip.clone()),
                #[cfg(not(windows))]
                Option::<Webview>::None,
                #[cfg(windows)]
                host.toolbar_revealed,
                #[cfg(not(windows))]
                false,
            )
        };
        #[cfg(windows)]
        let metrics = if let Some(metrics) = metrics_override {
            metrics
        } else {
            let tab_strip_height = self.windows_tab_strip_height(&window, _toolbar_revealed);
            runtime_window_content_metrics_with_tab_strip(&window, tab_strip_height)?
        };
        #[cfg(not(windows))]
        let metrics = metrics_override
            .map(Ok)
            .unwrap_or_else(|| runtime_window_content_metrics(&window))?;
        let role_inputs = role_views
            .iter()
            .map(|(_, _, _, _, _, input)| input.clone())
            .collect();
        let (role_bounds, divider_bounds) =
            self.resolve_runtime_layout(metrics, role_inputs, gap)?;
        let mut zoom_updates = Vec::with_capacity(role_views.len());
        for (role_id, webview, current_zoom, zoom_mode, role_surface, _) in &role_views {
            let Some(bounds) = role_bounds.get(role_id) else {
                continue;
            };
            let base_zoom = if zoom_mode == "adaptive" {
                self.adaptive_zoom_factor(bounds.width, Some(*current_zoom))?
            } else {
                *current_zoom
            };
            if *role_surface {
                zoom_updates.push((
                    role_id.clone(),
                    webview.clone(),
                    base_zoom,
                    effective_zoom_factor(base_zoom, window_zoom_factor),
                    effective_zoom_factor(*current_zoom, window_zoom_factor),
                ));
            }
        }
        let mut mutations = Vec::new();
        #[cfg(windows)]
        if let Some(tab_strip) = tab_strip {
            mutations.push(native_layout_bounds_mutation(
                tab_strip,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(metrics.width, tab_strip_height),
            ));
        }
        #[cfg(not(windows))]
        let _ = tab_strip;
        for (role_id, webview, _, _, _, _) in &role_views {
            if let Some(bounds) = role_bounds.get(role_id) {
                mutations.push(native_layout_bounds_mutation(
                    webview.clone(),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                ));
            }
        }
        for (_, webview, _, effective_zoom, previous_zoom) in &zoom_updates {
            if zoom_factor_changed(*previous_zoom, *effective_zoom) {
                mutations.push(NativeLayoutMutation::Zoom {
                    next: *effective_zoom,
                    webview: webview.clone(),
                });
            }
        }
        let popup_updates = {
            let state = self.state()?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, popup_role_id)| {
                    zoom_updates
                        .iter()
                        .find(|(role_id, _, _, _, _)| role_id == popup_role_id)
                        .map(|(_, _, _, effective, previous)| {
                            (label.clone(), *effective, *previous)
                        })
                })
                .collect::<Vec<_>>()
        };
        for (label, effective_zoom, previous_zoom) in popup_updates {
            if zoom_factor_changed(previous_zoom, effective_zoom)
                && let Some(webview) = self.app.get_webview(&label)
            {
                mutations.push(NativeLayoutMutation::Zoom {
                    next: effective_zoom,
                    webview,
                });
            }
        }
        for (index, descriptor, bounds) in divider_bounds {
            if let Some(webview) = divider_views.get(&index) {
                let bounds = divider_hit_bounds(&descriptor.axis, bounds);
                mutations.push(native_layout_bounds_mutation(
                    webview.clone(),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                ));
            }
        }
        let projection_failures = mutations
            .iter()
            .filter_map(|mutation| {
                mutation
                    .apply()
                    .err()
                    .map(|error| (mutation.label().to_owned(), error))
            })
            .collect::<Vec<_>>();
        let disconnected = projection_failures
            .iter()
            .filter(|(_, error)| native_surface_channel_is_unavailable(error))
            .collect::<Vec<_>>();
        if !disconnected.is_empty() {
            let disconnected_labels = disconnected
                .iter()
                .map(|(label, _)| label.as_str())
                .collect::<HashSet<_>>();
            let reason = format!(
                "Native layout lost contact with {} System WebView surface(s).",
                disconnected.len()
            );
            self.schedule_layout_surface_recovery(
                &role_generations,
                &disconnected_labels,
                reason,
            );
            eprintln!(
                "Native runtime layout skipped disconnected surfaces and queued recovery: tab={tab_id} surfaces={}",
                disconnected
                    .iter()
                    .map(|(label, _)| label.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
        let projection_errors = projection_failures
            .iter()
            .filter(|(_, error)| !native_surface_channel_is_unavailable(error))
            .map(|(label, error)| format!("{label}: {error}"))
            .collect::<Vec<_>>();
        let state_commit = (|| -> RuntimeResult<()> {
            let mut state = self.state()?;
            let tab = state.tabs.get_mut(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab disappeared before native layout could commit.",
                )
            })?;
            for (role_id, _, base_zoom, _, _) in &zoom_updates {
                if let Some(surface) = tab.roles.get_mut(role_id)
                    && surface.zoom_mode == "adaptive"
                {
                    surface.zoom_factor = *base_zoom;
                }
            }
            Ok(())
        })();
        if let Err(error) = state_commit {
            return Err(RuntimeError::new(
                "SYSTEM_GEOMETRY_APPLY_FAILED",
                format!(
                    "Native runtime layout state commit failed after the latest projection was submitted: {}",
                    error.message
                ),
            ));
        }
        if !projection_errors.is_empty() {
            return Err(RuntimeError::new(
                "SYSTEM_GEOMETRY_APPLY_FAILED",
                format!(
                    "Native runtime layout could not project every surface: {}",
                    projection_errors.join("; ")
                ),
            ));
        }
        Ok(())
    }

    fn schedule_layout_surface_recovery(
        &self,
        role_generations: &[(String, String, u64)],
        disconnected_labels: &HashSet<&str>,
        reason: String,
    ) {
        let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        for (_, role_id, generation) in role_generations
            .iter()
            .filter(|(label, _, _)| disconnected_labels.contains(label.as_str()))
        {
            runtime.schedule_surface_recovery(
                role_id.clone(),
                reason.clone(),
                *generation,
            );
        }
    }

    fn adaptive_zoom_factor(
        &self,
        viewport_width: f64,
        current_factor: Option<f64>,
    ) -> RuntimeResult<f64> {
        let value = self
            .core
            .invoke(CoreCommand::LayoutAdaptiveZoom {
                viewport_width,
                current_percent: current_factor.map(|factor| (factor * 100.0).round() as u32),
            })
            .map_err(RuntimeError::core)?;
        value
            .as_u64()
            .map(|percent| percent as f64 / 100.0)
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_LAYOUT_INVALID",
                    "Adaptive role zoom did not return a percentage.",
                )
            })
    }

    fn ensure_display_host(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        _title: &str,
    ) -> RuntimeResult<(Window, bool)> {
        if let Some((window, generation)) = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| (host.window.clone(), host.generation))
        {
            // A native host can outlive a removed live record while close cleanup
            // retires its surfaces. Reusing that host must first re-establish the
            // matching live generation so launch and placement intents never see
            // a native-only window.
            self.presentation
                .set_window_generation(&target.window_id, generation)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            self.update_live_window_target(target, false)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            self.register_runtime_launcher_window(&target.window_id);
            return Ok((window, false));
        }

        // Tauri unregisters a closed native window asynchronously. A fresh generation keeps a
        // display that loses its final tab from colliding with that retiring window while still
        // preserving one stable host for the full lifetime of the next tab group.
        let host_generation = DISPLAY_HOST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let host_id = format!("{}:{host_generation}", target.window_id);
        let window_label = runtime_label("game-display", &host_id);
        let window_app = self.app.clone();
        let saved_name = self
            .state()?
            .saved_window_names
            .get(&target.window_id)
            .cloned();
        let window_title = native_runtime_window_title(saved_name.as_deref());
        let bounds = target.bounds.clone();
        let physical_position = physical_window_position(bounds.x, bounds.y, target.scale_factor);
        let window = self.create_window_bounded(&target.window_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .title(window_title)
                .inner_size(bounds.width.max(1) as f64, bounds.height.max(1) as f64)
                .min_inner_size(640.0, 480.0)
                .visible(false)
                .focused(false)
                .build()
        })?;
        window
            .set_position(PhysicalPosition::new(
                physical_position.0,
                physical_position.1,
            ))
            .map_err(RuntimeError::tauri)?;
        if let Err(error) = self.begin_surface_host_initialization(&window, &target.window_id) {
            let _ = window.close();
            return Err(error);
        }
        let window_generation = WINDOW_GENERATION_SEQUENCE
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        #[cfg(target_os = "macos")]
        let tabs_controller = match crate::runtime_tabs_macos::MacRuntimeTabsController::create(
            &self.app,
            &window,
            &target.window_id,
        ) {
            Ok(controller) => controller,
            Err(message) => {
                let _ = window.close();
                return Err(RuntimeError::new("MACOS_RUNTIME_TABS_FAILED", message));
            }
        };
        #[cfg(target_os = "macos")]
        tabs_controller
            .set_window_name(saved_name.as_deref())
            .map_err(|message| RuntimeError::new("MACOS_RUNTIME_TABS_FAILED", message))?;
        #[cfg(windows)]
        let tab_initialization_script = windows_runtime_tab_initialization_script(
            &target.window_id,
            window_generation,
            self.lifecycle_epoch(),
        )
        .map_err(RuntimeError::tauri)?;
        #[cfg(windows)]
        let tab_strip = match self.add_child_bounded(
            &window,
            WebviewBuilder::new(
                runtime_label("game-tab-strip", &host_id),
                WebviewUrl::App("runtime-tabs.html".into()),
            )
            .disable_drag_drop_handler()
            .initialization_script(&tab_initialization_script),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(target.bounds.width.max(1) as f64, WINDOWS_TAB_STRIP_HEIGHT),
            &format!("{}:tab-strip", target.window_id),
        ) {
            Ok(tab_strip) => tab_strip,
            Err(error) => {
                let _ = window.close();
                return Err(error);
            }
        };

        let mut state = self.state()?;
        if let Some(existing) = state.display_hosts.get(&target.window_id) {
            let existing = existing.window.clone();
            drop(state);
            let _ = window.close();
            self.register_runtime_launcher_window(&target.window_id);
            return Ok((existing, false));
        }
        state.display_hosts.insert(
            target.window_id.clone(),
            RuntimeDisplayHost {
                generation: window_generation,
                target: target.clone(),
                window: window.clone(),
                zoom_factor: 1.0,
                #[cfg(windows)]
                tab_strip,
                #[cfg(windows)]
                toolbar_revealed: false,
                #[cfg(target_os = "macos")]
                tabs_controller,
            },
        );
        drop(state);
        self.presentation
            .set_window_generation(&target.window_id, window_generation)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        self.update_live_window_target(target, false)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        self.set_live_window_persisted_name(&target.window_id, saved_name)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        self.register_runtime_launcher_window(&target.window_id);
        Ok((window, true))
    }

    fn register_runtime_launcher_window(&self, window_id: &str) {
        let Some(state) = self.app.try_state::<crate::CoreState>() else {
            return;
        };
        if let Err(error) = state
            .runtime_launcher_refresh
            .register_window(&self.app, window_id)
        {
            eprintln!("Runtime launcher menu could not register window {window_id}: {error}");
        }
    }

    fn unregister_runtime_launcher_window(&self, window_id: &str) {
        if let Some(state) = self.app.try_state::<crate::CoreState>() {
            state.runtime_launcher_refresh.unregister_window(window_id);
        }
    }

    fn remove_empty_display_host(&self, window_id: &str, created_for_operation: bool) {
        if !created_for_operation || !self.live_tab_ids_for_window(window_id).is_empty() {
            return;
        }
        let host = self.state.lock().ok().and_then(|mut state| {
            if state.quarantined_window_hosts.contains(window_id) {
                return None;
            }
            if state
                .retiring_window_tabs
                .get(window_id)
                .is_some_and(|tab_ids| !tab_ids.is_empty())
            {
                return None;
            }
            state.retiring_window_tabs.remove(window_id);
            let host = state.display_hosts.remove(window_id)?;
            state
                .allow_window_close_labels
                .insert(host.window.label().to_owned());
            Some(host)
        });
        if let Some(host) = host {
            self.unregister_runtime_launcher_window(window_id);
            let _ = host.window.close();
        }
    }

    fn complete_retiring_window_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        cleanup_failed: bool,
    ) {
        let retirement = self.state.lock().ok().and_then(|mut state| {
            let Some(tab_ids) = state.retiring_window_tabs.get_mut(window_id) else {
                if cleanup_failed {
                    state
                        .quarantined_window_hosts
                        .insert(window_id.to_owned());
                }
                return None;
            };
            tab_ids.remove(tab_id);
            let all_tabs_terminal = tab_ids.is_empty();
            if cleanup_failed {
                state
                    .retiring_window_cleanup_failed
                    .insert(window_id.to_owned());
            }
            if !all_tabs_terminal {
                return Some(false);
            }
            state.retiring_window_tabs.remove(window_id);
            let failed = state.retiring_window_cleanup_failed.remove(window_id);
            if failed {
                state
                    .quarantined_window_hosts
                    .insert(window_id.to_owned());
            }
            Some(failed)
        });
        match retirement {
            Some(true) => return,
            Some(false) => {}
            None if cleanup_failed => return,
            None => {}
        }
        self.remove_empty_display_host(window_id, true);
    }

}

fn native_surface_channel_is_unavailable(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("failed to receive message from webview")
        || message.contains("webview was closed")
        || message.contains("webview is closed")
        || message.contains("webview not found")
        || message.contains("channel closed")
        || message.contains("broken pipe")
}
