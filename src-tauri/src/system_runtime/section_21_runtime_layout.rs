enum NativeLayoutMutation {
    #[cfg(not(windows))]
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
            #[cfg(not(windows))]
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
            #[cfg(not(windows))]
            Self::Bounds { webview, .. } => webview.label(),
            Self::Zoom { webview, .. } => webview.label(),
        }
    }
}

#[cfg(not(windows))]
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

fn collect_native_layout_submission_failures<T>(
    submissions: &[T],
    label: impl Fn(&T) -> String,
    submit: impl Fn(&T) -> Result<(), String>,
) -> Vec<(String, String)> {
    submissions
        .iter()
        .filter_map(|submission| {
            submit(submission)
                .err()
                .map(|error| (label(submission), error))
        })
        .collect()
}

fn submit_native_layout_mutations(
    mutations: &[NativeLayoutMutation],
) -> Vec<(String, String)> {
    collect_native_layout_submission_failures(
        mutations,
        |mutation| mutation.label().to_owned(),
        NativeLayoutMutation::apply,
    )
}

#[cfg(any(windows, test))]
fn resize_snapshot_tab_strip_height(metrics: WindowContentMetrics) -> f64 {
    metrics.top_inset.max(1.0)
}

#[cfg(windows)]
fn apply_resize_layout_mutations(
    _window: &Window,
    mutations: Vec<NativeLayoutMutation>,
) -> RuntimeResult<Vec<(String, String)>> {
    // Tauri's Windows dispatcher queues each WebView2 bounds update and returns immediately.
    // Do not wrap these submissions in another main-thread task and wait for it: Windows can
    // defer that task during an interactive sizing loop, making the visible surface trail the
    // native window by seconds. The resize worker already limits submissions to the latest
    // snapshot on the shared live-resize debounce interval.
    Ok(submit_native_layout_mutations(&mutations))
}

#[cfg(not(windows))]
fn apply_resize_layout_mutations(
    window: &Window,
    mutations: Vec<NativeLayoutMutation>,
) -> RuntimeResult<Vec<(String, String)>> {
    if mutations.is_empty() {
        return Ok(Vec::new());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let failures = mutations
                .iter()
                .filter_map(|mutation| {
                    mutation
                        .apply()
                        .err()
                        .map(|error| (mutation.label().to_owned(), error))
                })
                .collect();
            let _ = sender.send(failures);
        })
        .map_err(RuntimeError::tauri)?;
    receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_GEOMETRY_APPLY_FAILED",
            format!("The native resize layout batch did not complete on the UI thread: {error}"),
        )
    })
}

impl SystemRuntimeExecutor {
    fn resolve_runtime_layout(
        &self,
        metrics: WindowContentMetrics,
        roles: Vec<LayoutRoleInput>,
        gap: u32,
    ) -> RuntimeResult<ResolvedRuntimeLayout> {
        let descriptors = rion_core::create_workspace_dividers(&roles);
        let output = rion_core::resolve_workspace_layout(&WorkspaceLayoutInput {
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
        });
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
        self.layout_runtime_tab_inner_with_metrics(tab_id, None, false, true)
    }

    fn layout_runtime_tab_inner_with_metrics(
        &self,
        tab_id: &str,
        metrics_override: Option<WindowContentMetrics>,
        skip_active_bounds: bool,
        _publish_native_plan: bool,
    ) -> RuntimeResult<()> {
        let is_resize_projection = metrics_override.is_some();
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let desired_window_zoom_factor = self.runtime_window_zoom_factor(&window_id);
        let (
            window,
            role_views,
            role_generations,
            divider_views,
            gap,
            window_zoom_factor,
            tab_strip,
            _toolbar_revealed,
            _window_generation,
        ) = {
            let state = self.state()?;
            let tab = state.native_resources.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let host = state.native_resources.display_hosts.get(&window_id).ok_or_else(|| {
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
                                    String::new(),
                                    true,
                                )
                            } else {
                                let placeholder = slot.placeholder.as_ref()?;
                                (
                                    placeholder.webview.clone(),
                                    slot.zoom_factor,
                                    String::new(),
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
                desired_window_zoom_factor,
                #[cfg(windows)]
                Some(host.tab_strip.clone()),
                #[cfg(not(windows))]
                Option::<Webview>::None,
                #[cfg(windows)]
                host.toolbar_revealed,
                #[cfg(not(windows))]
                false,
                host.generation,
            )
        };
        let role_views = role_views
            .into_iter()
            .map(
                |(role_id, webview, projected_zoom, _projected_mode, role_surface, input)| {
                    let (zoom_factor, adaptive) = self.runtime_role_zoom_contract(
                        &window_id,
                        tab_id,
                        &role_id,
                        projected_zoom,
                    );
                    (
                        role_id,
                        webview,
                        zoom_factor,
                        if adaptive { "adaptive" } else { "fixed" }.to_owned(),
                        role_surface,
                        input,
                    )
                },
            )
            .collect::<Vec<_>>();
        #[cfg(windows)]
        let metrics = match metrics_override {
            Some(metrics) => metrics,
            None => {
                let tab_strip_height =
                    self.windows_tab_strip_height(&window, _toolbar_revealed);
                runtime_window_content_metrics_with_tab_strip(&window, tab_strip_height)?
            }
        };
        #[cfg(not(windows))]
        let metrics = metrics_override
            .map(Ok)
            .unwrap_or_else(|| runtime_window_content_metrics(&window))?;
        let role_inputs = role_views
            .iter()
            .map(|(_, _, _, _, _, input)| input.clone())
            .collect::<Vec<_>>();
        #[cfg(windows)]
        let is_active_tab = self
            .presentation
            .existing(&window_id)
            .map(|presentation| presentation.selected_tab_id.as_deref() == Some(tab_id))
            .unwrap_or(false);
        #[cfg(windows)]
        if _publish_native_plan
            && is_active_tab
            && let Some(tab_strip) = tab_strip.as_ref()
        {
            let descriptors = rion_core::create_workspace_dividers(&role_inputs);
            let revision = WINDOWS_LIVE_RESIZE_PLAN_REVISION
                .fetch_add(1, Ordering::AcqRel)
                .saturating_add(1);
            windows_live_resize_publish_plan(
                &window,
                WindowsLiveResizePlan {
                    dividers: descriptors
                        .iter()
                        .enumerate()
                        .filter_map(|(index, descriptor)| {
                            divider_views.get(&(index as u32)).map(|webview| {
                                WindowsLiveResizeDividerPlan {
                                    axis: descriptor.axis.clone(),
                                    index: index as u32,
                                    label: webview.label().to_owned(),
                                }
                            })
                        })
                        .collect(),
                    gap,
                    generation: _window_generation,
                    revision,
                    roles: role_views
                        .iter()
                        .map(|(_, webview, _, _, _, input)| WindowsLiveResizeRolePlan {
                            input: input.clone(),
                            label: webview.label().to_owned(),
                        })
                        .collect(),
                    tab_strip_height: resize_snapshot_tab_strip_height(metrics),
                    tab_strip_label: tab_strip.label().to_owned(),
                    window_draggable: !window.is_fullscreen().unwrap_or(false),
                },
            );
        }
        let (role_bounds, divider_bounds) =
            self.resolve_runtime_layout(metrics, role_inputs, gap)?;
        #[cfg(windows)]
        let _ = (&divider_bounds, skip_active_bounds);
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
        let _ = tab_strip;
        #[cfg(not(windows))]
        let _ = tab_strip;
        #[cfg(not(windows))]
        if !skip_active_bounds {
            for (role_id, webview, _, _, _, _) in &role_views {
                if let Some(bounds) = role_bounds.get(role_id) {
                    mutations.push(native_layout_bounds_mutation(
                        webview.clone(),
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                    ));
                }
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
        #[cfg(not(windows))]
        if !skip_active_bounds {
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
        }
        let projection_failures = if is_resize_projection {
            apply_resize_layout_mutations(&window, mutations)?
        } else {
            submit_native_layout_mutations(&mutations)
        };
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
            let tab = state.native_resources.tabs.get_mut(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab disappeared before native layout could commit.",
                )
            })?;
            for (role_id, _, base_zoom, _, _) in &zoom_updates {
                if let Some(surface) = tab.roles.get_mut(role_id) {
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
        Ok(rion_core::resolve_adaptive_zoom_percent(
            viewport_width,
            current_factor.map(|factor| (factor * 100.0).round() as u32),
        ) as f64
            / 100.0)
    }

    fn ensure_display_host(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        _title: &str,
    ) -> RuntimeResult<(Window, bool)> {
        let existing_host = {
            let mut runtime_state = self.state()?;
            if runtime_state
                .retiring_native_window_hosts
                .values()
                .any(|host| host.window_id == target.window_id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_WINDOW_CLOSING",
                    "The previous native window generation has not emitted its destroyed event.",
                ));
            }
            runtime_state
                .native_resources.display_hosts
                .get_mut(&target.window_id)
                .map(|host| {
                host.retirement_revision = WINDOW_RETIREMENT_SEQUENCE
                    .fetch_add(1, Ordering::AcqRel)
                    .saturating_add(1);
                (host.window.clone(), host.generation)
                })
        };
        if let Some((window, generation)) = existing_host {
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
            .presentation
            .existing(&target.window_id)
            .and_then(|window| window.persisted_name.clone());
        let window_title = native_runtime_window_title(saved_name.as_deref());
        let bounds = target.bounds.clone();
        let physical_position = physical_window_position(bounds.x, bounds.y, target.scale_factor);
        #[cfg(windows)]
        let windows_mica_enabled = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        let windows_mica_enabled_for_creation = Arc::clone(&windows_mica_enabled);
        let window = self.create_window_bounded(&target.window_id, move || {
            #[cfg(windows)]
            {
                let (window, material) = build_windows_runtime_host_window(
                    &window_app,
                    &window_label,
                    &window_title,
                    bounds.width.max(1) as f64,
                    bounds.height.max(1) as f64,
                )?;
                windows_mica_enabled_for_creation.store(
                    material == WindowsMicaMaterial::Mica,
                    Ordering::Release,
                );
                Ok(window)
            }
            #[cfg(not(windows))]
            {
            let builder = WindowBuilder::new(&window_app, window_label)
                .title(window_title)
                .inner_size(bounds.width.max(1) as f64, bounds.height.max(1) as f64)
                .min_inner_size(640.0, 480.0)
                .visible(false)
                .focused(false);
            builder.build()
            }
        })?;
        #[cfg(windows)]
        let windows_mica_enabled = windows_mica_enabled.load(Ordering::Acquire);
        window
            .set_position(PhysicalPosition::new(
                physical_position.0,
                physical_position.1,
            ))
            .map_err(RuntimeError::tauri)?;
        #[cfg(windows)]
        let tab_chrome_cloaked = match set_windows_runtime_window_cloaked(&window, true) {
            Ok(()) => true,
            Err(error) => {
                eprintln!(
                    "Windows runtime window could not be cloaked during tab chrome hydration: {error:?}"
                );
                false
            }
        };
        let window_generation = WINDOW_GENERATION_SEQUENCE
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        #[cfg(windows)]
        {
            let runtime = self.self_weak.get().cloned().ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_UNAVAILABLE",
                    "The Windows geometry coordinator could not bind to the runtime.",
                )
            })?;
            let receipt_window_id = target.window_id.clone();
            let receipt_handler: WindowsGeometryReceiptHandler = Arc::new(move |receipt| {
                if let Some(runtime) = runtime.upgrade() {
                    runtime.observe_windows_geometry_receipt(
                        receipt_window_id.clone(),
                        receipt,
                    );
                }
            });
            windows_live_resize_install_host(
                &window,
                window_generation,
                receipt_handler,
            )?;
        }
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
        let tab_initialization_script = windows_runtime_tab_initialization_script(
            &target.window_id,
            window_generation,
            self.lifecycle_epoch(),
            windows_mica_enabled,
        )
        .map_err(RuntimeError::tauri)?;
        #[cfg(windows)]
        let tab_strip_builder = WebviewBuilder::new(
            runtime_label("game-tab-strip", &host_id),
            WebviewUrl::App("runtime-tabs.html".into()),
        )
        .disable_drag_drop_handler()
        .initialization_script(&tab_initialization_script)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                // Module scripts finish before the document load event. Re-announce from this
                // authoritative event when the native host registration won the startup race.
                let _ = webview.eval(
                    "globalThis.__rionAnnounceRuntimeTabChromeReady?.();",
                );
            }
        });
        #[cfg(windows)]
        let tab_strip_builder = if windows_mica_enabled {
            tab_strip_builder.transparent(true)
        } else {
            tab_strip_builder
        };
        #[cfg(windows)]
        let tab_strip = match self.add_child_bounded(
            &window,
            tab_strip_builder,
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
        #[cfg(windows)]
        windows_live_resize_register_webview(&tab_strip)?;

        let mut state = self.state()?;
        if let Some(existing) = state.native_resources.display_hosts.get(&target.window_id) {
            let existing = existing.window.clone();
            drop(state);
            let _ = window.close();
            self.register_runtime_launcher_window(&target.window_id);
            return Ok((existing, false));
        }
        state.native_resources.display_hosts.insert(
            target.window_id.clone(),
            RuntimeDisplayHost {
                generation: window_generation,
                retirement_revision: 0,
                target: target.clone(),
                window: window.clone(),
                #[cfg(windows)]
                last_geometry_receipt_revision: 0,
                #[cfg(windows)]
                tab_strip: tab_strip.clone(),
                #[cfg(windows)]
                toolbar_revealed: false,
                #[cfg(windows)]
                tab_chrome_reveal: WindowsTabChromeRevealState::new(tab_chrome_cloaked),
                #[cfg(target_os = "macos")]
                tabs_controller,
            },
        );
        drop(state);
        #[cfg(windows)]
        {
            // A fast WebView2 can finish its document and reject both renderer announcements
            // before the tab-strip label is committed above. The native registration commit is
            // the complementary authoritative event: by this point a finished renderer has the
            // callback installed, while a renderer still loading will announce on its own.
            let _ = tab_strip.eval(
                "globalThis.__rionAnnounceRuntimeTabChromeReady?.();",
            );
        }
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
        self.complete_pending_window_activation(&target.window_id, window_generation);
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
        self.remove_empty_display_host_at_revision(window_id, created_for_operation, None);
    }

    fn remove_empty_display_host_at_revision(
        &self,
        window_id: &str,
        created_for_operation: bool,
        expected_retirement_revision: Option<u64>,
    ) {
        if let Err(error) = self.with_native_window_lifecycle_lane(window_id, || {
            self.remove_empty_display_host_at_revision_in_lane(
                window_id,
                created_for_operation,
                expected_retirement_revision,
            );
            Ok(())
        }) {
            self.health.mark_unhealthy();
            eprintln!(
                "Native Game Window lifecycle lane failed before host retirement: window={window_id} error={}",
                error.message
            );
        }
        self.tab_close_changed.notify_all();
    }

    fn remove_empty_display_host_at_revision_in_lane(
        &self,
        window_id: &str,
        created_for_operation: bool,
        expected_retirement_revision: Option<u64>,
    ) {
        if !created_for_operation || !self.live_tab_ids_for_window(window_id).is_empty() {
            return;
        }
        let host = self.state.lock().ok().and_then(|mut state| {
            if state.quarantined_window_hosts.contains(window_id) {
                return None;
            }
            if !state.native_resources.display_hosts.get(window_id).is_some_and(|host| {
                window_retirement_revision_is_current(
                    host.retirement_revision,
                    expected_retirement_revision,
                )
            }) {
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
            state.retiring_window_revisions.remove(window_id);
            let host = state.native_resources.display_hosts.remove(window_id)?;
            let label = host.window.label().to_owned();
            state.allow_window_close_labels.insert(label.clone());
            state.retiring_native_window_hosts.insert(
                label,
                RetiringNativeWindowHost {
                    generation: host.generation,
                    window_id: window_id.to_owned(),
                },
            );
            Some(host)
        });
        if let Some(host) = host {
            let label = host.window.label().to_owned();
            match host.window.close() {
                Ok(()) => self.unregister_runtime_launcher_window(window_id),
                Err(error) => {
                    if let Ok(mut state) = self.state.lock() {
                        state.allow_window_close_labels.remove(&label);
                        state.retiring_native_window_hosts.remove(&label);
                        state
                            .native_resources.display_hosts
                            .entry(window_id.to_owned())
                            .or_insert(host);
                    }
                    self.health.mark_unhealthy();
                    self.tab_close_changed.notify_all();
                    let error_message = error.to_string();
                    let core = Arc::clone(&self.core);
                    let context = json!({
                        "error": error_message.clone(),
                        "windowId": window_id,
                        "windowLabel": label,
                    });
                    tauri::async_runtime::spawn(async move {
                        let _ = core
                            .invoke_async(CoreCommand::LogsCapture {
                                entries: vec![LogCaptureRecord {
                                    level: LogLevel::Error,
                                    source: LogSource::Browser,
                                    event: "native.window-retirement-failed".to_owned(),
                                    message: "The empty native game window could not be released."
                                        .to_owned(),
                                    context_raw_json: serde_json::to_string(&context).ok(),
                                    error: Some(LogErrorDetails {
                                        name: "SYSTEM_WINDOW_RELEASE_FAILED".to_owned(),
                                        message: error_message,
                                        stack: None,
                                        cause: None,
                                    }),
                                }],
                            })
                            .await;
                    });
                    let _ = self.app.emit(
                        "rion://shell-error",
                        json!({
                            "code": "SYSTEM_WINDOW_RELEASE_FAILED",
                            "failureKind": "native-window-retirement",
                            "message": "Rion Studio could not release the empty game window. Reopen it or restart Rion Studio before retrying.",
                            "windowId": window_id,
                        }),
                    );
                }
            }
        }
    }

    fn complete_retiring_window_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        cleanup_failed: bool,
        expected_retirement_revision: Option<u64>,
    ) {
        let retirement = self.state.lock().ok().map(|mut state| {
            let Some(tab_ids) = state.retiring_window_tabs.get_mut(window_id) else {
                if cleanup_failed {
                    state
                        .quarantined_window_hosts
                        .insert(window_id.to_owned());
                } else if should_preserve_window_retirement_fence(
                    expected_retirement_revision,
                    state
                        .native_resources
                        .display_hosts
                        .get(window_id)
                        .map(|host| host.retirement_revision),
                ) {
                    // Keep a continuous close fence until host removal atomically
                    // replaces this marker with a native-window tombstone. A late
                    // duplicate completion after that handoff must not recreate an
                    // orphaned fence that no future destroyed event can retire.
                    state
                        .retiring_window_tabs
                        .insert(window_id.to_owned(), HashSet::new());
                }
                return (false, expected_retirement_revision);
            };
            tab_ids.remove(tab_id);
            let all_tabs_terminal = tab_ids.is_empty();
            if cleanup_failed {
                state
                    .retiring_window_cleanup_failed
                    .insert(window_id.to_owned());
            }
            if !all_tabs_terminal {
                return (false, None);
            }
            let retirement_revision = state.retiring_window_revisions.remove(window_id);
            let failed = state.retiring_window_cleanup_failed.remove(window_id);
            if failed {
                state
                    .quarantined_window_hosts
                    .insert(window_id.to_owned());
            }
            (failed, retirement_revision.or(expected_retirement_revision))
        });
        self.tab_close_changed.notify_all();
        match retirement {
            Some((true, _)) => return,
            Some((false, None)) if self.state.lock().ok().is_some_and(|state| {
                state.retiring_window_tabs.contains_key(window_id)
            }) => return,
            Some((false, revision)) => {
                self.remove_empty_display_host_at_revision(window_id, true, revision);
                return;
            }
            None if cleanup_failed => return,
            None => {}
        }
        self.remove_empty_display_host_at_revision(
            window_id,
            true,
            expected_retirement_revision,
        );
    }

}

fn window_retirement_revision_is_current(active: u64, expected: Option<u64>) -> bool {
    expected.is_none_or(|expected| active == expected)
}

fn should_preserve_window_retirement_fence(
    expected: Option<u64>,
    live_host_revision: Option<u64>,
) -> bool {
    expected.is_some() && expected == live_host_revision
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
