impl SystemRuntimeExecutor {
    pub fn refresh_local_storage_sync_metadata(
        &self,
        roles: &[StateRoleRecord],
        games: &[StateGameRecord],
    ) -> Result<(), String> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            "The localStorage synchronization lifecycle lane is unavailable.".to_owned()
        })?;
        let roles_by_id = roles
            .iter()
            .map(|role| (role.id.as_str(), role))
            .collect::<HashMap<_, _>>();
        let games_by_id = games
            .iter()
            .map(|game| (game.id.as_str(), game))
            .collect::<HashMap<_, _>>();
        let candidates = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.iter())
                .map(|(role_id, surface)| {
                    let previous = surface.local_storage_sync.clone();
                    let next = roles_by_id.get(role_id.as_str()).and_then(|role| {
                        let game = games_by_id.get(role.game_id.as_str())?;
                        if game.local_storage_sync_keys.is_empty() {
                            return None;
                        }
                        let origin = checked_web_url(&role.launch_url)
                            .ok()?
                            .origin()
                            .ascii_serialization();
                        let token = previous
                            .as_ref()
                            .map(|config| config.token.clone())
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let generation = previous
                            .as_ref()
                            .map_or(1, |config| config.generation.saturating_add(1));
                        Some(LocalStorageRuntimeConfig {
                            dependent_role_ids: roles
                                .iter()
                                .filter(|candidate| {
                                    candidate.local_storage_source_role_id.as_deref()
                                        == Some(role.id.as_str())
                                })
                                .map(|candidate| candidate.id.clone())
                                .collect(),
                            generation,
                            keys: game.local_storage_sync_keys.clone(),
                            origin,
                            source_role_id: role.local_storage_source_role_id.clone(),
                            token,
                        })
                    });
                    (
                        role_id.clone(),
                        surface.webview.clone(),
                        surface.webview.label().to_owned(),
                        previous,
                        next,
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut updates = Vec::with_capacity(candidates.len());
        for (role_id, webview, webview_label, previous, next) in candidates {
            let source_changed = previous
                .as_ref()
                .and_then(|config| config.source_role_id.clone())
                != next
                    .as_ref()
                    .and_then(|config| config.source_role_id.clone());
            let mut apply_scripts = Vec::new();
            let mut rollback_scripts = Vec::new();
            if let Some(config) = next.as_ref() {
                apply_scripts.push(
                    local_storage_sync_configure_script(config).map_err(|error| error.message)?,
                );
            } else if let Some(config) = previous.as_ref() {
                apply_scripts.push(
                    local_storage_sync_disable_script(&config.token)
                        .map_err(|error| error.message)?,
                );
            }
            if let Some(config) = previous.as_ref() {
                rollback_scripts.push(
                    local_storage_sync_configure_script(config).map_err(|error| error.message)?,
                );
            } else if let Some(config) = next.as_ref() {
                rollback_scripts.push(
                    local_storage_sync_disable_script(&config.token)
                        .map_err(|error| error.message)?,
                );
            }
            if source_changed
                && let Some(config) = next.as_ref()
                && let Some(source_role_id) = config.source_role_id.as_deref()
            {
                require_exact_local_storage_sync_origin(&webview, &config.origin)
                    .map_err(|error| error.message)?;
                let previous_entries = read_scoped_local_storage_entries(&webview, &config.keys)
                    .map_err(|error| error.message)?;
                let snapshot = self
                    .load_local_storage_sync_snapshot(source_role_id, &config.origin, &config.keys)
                    .map_err(|error| error.message)?;
                apply_scripts.push(
                    local_storage_sync_apply_script(&snapshot).map_err(|error| error.message)?,
                );
                rollback_scripts.push(
                    local_storage_sync_apply_script(&PersistedLocalStorageSyncSnapshot {
                        schema_version: 1,
                        source_role_id: role_id.clone(),
                        origin: config.origin.clone(),
                        entries: previous_entries,
                    })
                    .map_err(|error| error.message)?,
                );
            }
            updates.push(LocalStorageMetadataUpdate {
                apply_scripts,
                next,
                previous,
                role_id,
                rollback_scripts,
                webview,
                webview_label,
            });
        }
        if let Err(failure) = apply_reversible_fanout(
            &updates,
            |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.apply_scripts)
            },
            |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.rollback_scripts)
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "LOCAL_STORAGE_SYNC_METADATA_REFRESH_FAILED",
                "Refreshing localStorage synchronization metadata",
                &failure,
            )
            .message);
        }
        let mut state = self.state().map_err(|error| error.message)?;
        let stale = updates.iter().any(|update| {
            state
                .role_tabs
                .get(&update.role_id)
                .and_then(|tab_id| state.tabs.get(tab_id))
                .and_then(|tab| tab.roles.get(&update.role_id))
                .is_none_or(|surface| {
                    surface.webview.label() != update.webview_label
                        || surface.local_storage_sync != update.previous
                })
        });
        if stale {
            drop(state);
            let rollback_errors = rollback_reversible_fanout(&updates, |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.rollback_scripts)
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(if rollback_errors.is_empty() {
                "Runtime roles changed before localStorage synchronization metadata could be committed."
                    .to_owned()
            } else {
                format!(
                    "Runtime roles changed before localStorage synchronization metadata could be committed. Compensation also failed: {}. Restart Rion Studio to recover safely.",
                    rollback_errors.join("; ")
                )
            });
        }
        for update in updates {
            let tab_id = state.role_tabs[&update.role_id].clone();
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&update.role_id))
                .expect("localStorage metadata commit prevalidated every runtime role");
            surface.local_storage_sync = update.next;
            surface.local_storage_sync_sequence = 0;
        }
        Ok(())
    }

    fn apply_local_storage_sync_to_running_dependents(
        &self,
        source_role_id: &str,
        snapshot: &PersistedLocalStorageSyncSnapshot,
    ) -> RuntimeResult<()> {
        let targets = {
            let state = self.state()?;
            state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.values())
                .filter_map(|surface| {
                    let config = surface.local_storage_sync.as_ref()?;
                    (config.source_role_id.as_deref() == Some(source_role_id)
                        && config.origin == snapshot.origin)
                        .then(|| (surface.webview.clone(), config.origin.clone()))
                })
                .collect::<Vec<_>>()
        };
        let script = local_storage_sync_apply_script(snapshot)?;
        let mut first_error = None;
        for (webview, origin) in targets {
            let result = require_exact_local_storage_sync_origin(&webview, &origin)
                .and_then(|()| webview.eval(&script).map_err(RuntimeError::tauri));
            if first_error.is_none()
                && let Err(error) = result
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn local_storage_sync_source_cleared(
        &self,
        source_role_id: &str,
        origin: &str,
        keys: &[String],
    ) -> RuntimeResult<()> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
        if keys.is_empty() {
            return Ok(());
        }
        validate_local_storage_sync_contract(origin, keys)?;
        let snapshot = PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: source_role_id.to_owned(),
            origin: origin.to_owned(),
            entries: keys.iter().map(|key| (key.clone(), None)).collect(),
        };
        self.persist_local_storage_sync_snapshot(snapshot.clone())?;
        self.apply_local_storage_sync_to_running_dependents(source_role_id, &snapshot)
    }

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

    fn layout_runtime_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let (
            window,
            role_views,
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
            let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            (
                host.window.clone(),
                tab.roles
                    .iter()
                    .map(|(role_id, surface)| {
                        (
                            role_id.clone(),
                            surface.webview.clone(),
                            surface.zoom_factor,
                            surface.zoom_mode.clone(),
                            LayoutRoleInput {
                                role_id: role_id.clone(),
                                rect: LayoutRect {
                                    x: surface.rect.x,
                                    y: surface.rect.y,
                                    width: surface.rect.width,
                                    height: surface.rect.height,
                                },
                            },
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
        let tab_strip_height = self.windows_tab_strip_height(&window, _toolbar_revealed);
        #[cfg(windows)]
        let metrics = runtime_window_content_metrics_with_tab_strip(&window, tab_strip_height)?;
        #[cfg(not(windows))]
        let metrics = runtime_window_content_metrics(&window)?;
        #[cfg(windows)]
        if let Some(tab_strip) = tab_strip {
            tab_strip
                .set_position(LogicalPosition::new(0.0, 0.0))
                .map_err(RuntimeError::tauri)?;
            tab_strip
                .set_size(LogicalSize::new(metrics.width, tab_strip_height))
                .map_err(RuntimeError::tauri)?;
        }
        #[cfg(not(windows))]
        let _ = tab_strip;
        let role_inputs = role_views
            .iter()
            .map(|(_, _, _, _, input)| input.clone())
            .collect();
        let (role_bounds, divider_bounds) =
            self.resolve_runtime_layout(metrics, role_inputs, gap)?;
        let mut zoom_updates = Vec::with_capacity(role_views.len());
        for (role_id, webview, current_zoom, zoom_mode, _) in &role_views {
            let Some(bounds) = role_bounds.get(role_id) else {
                continue;
            };
            let base_zoom = if zoom_mode == "adaptive" {
                self.adaptive_zoom_factor(bounds.width, Some(*current_zoom))?
            } else {
                *current_zoom
            };
            zoom_updates.push((
                role_id.clone(),
                webview.clone(),
                base_zoom,
                effective_zoom_factor(base_zoom, window_zoom_factor),
            ));
        }
        for (role_id, webview, _, _, _) in role_views {
            if let Some(bounds) = role_bounds.get(&role_id) {
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(RuntimeError::tauri)?;
                webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(RuntimeError::tauri)?;
            }
        }
        for (_, webview, _, effective_zoom) in &zoom_updates {
            webview
                .set_zoom(*effective_zoom)
                .map_err(RuntimeError::tauri)?;
        }
        let popup_updates = {
            let state = self.state()?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, popup_role_id)| {
                    zoom_updates
                        .iter()
                        .find(|(role_id, _, _, _)| role_id == popup_role_id)
                        .map(|(_, _, _, effective)| (label.clone(), *effective))
                })
                .collect::<Vec<_>>()
        };
        for (label, effective_zoom) in popup_updates {
            if let Some(webview) = self.app.get_webview(&label) {
                webview
                    .set_zoom(effective_zoom)
                    .map_err(RuntimeError::tauri)?;
            }
        }
        if let Ok(mut state) = self.state()
            && let Some(tab) = state.tabs.get_mut(tab_id)
        {
            for (role_id, _, base_zoom, _) in zoom_updates {
                if let Some(surface) = tab.roles.get_mut(&role_id)
                    && surface.zoom_mode == "adaptive"
                {
                    surface.zoom_factor = base_zoom;
                }
            }
        }
        for (index, descriptor, bounds) in divider_bounds {
            if let Some(webview) = divider_views.get(&index) {
                let bounds = divider_hit_bounds(&descriptor.axis, bounds);
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(RuntimeError::tauri)?;
                webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(RuntimeError::tauri)?;
            }
        }
        Ok(())
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
        if let Some(window) = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.window.clone())
        {
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
        let tab_strip = match self.add_child_bounded(
            &window,
            WebviewBuilder::new(
                runtime_label("game-tab-strip", &host_id),
                WebviewUrl::App("runtime-tabs.html".into()),
            )
            .initialization_script(WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT),
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
        if !created_for_operation {
            return;
        }
        let host = self.state.lock().ok().and_then(|mut state| {
            let has_tabs = state.tabs.values().any(|tab| tab.window_id == window_id);
            if has_tabs {
                return None;
            }
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

}
