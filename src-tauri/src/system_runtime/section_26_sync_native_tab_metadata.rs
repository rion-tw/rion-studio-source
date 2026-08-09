impl SystemRuntimeExecutor {
    #[cfg(target_os = "macos")]
    fn sync_native_tab_metadata(&self, snapshot: &BrowserRuntimeSnapshot) {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Metadata,
            "syncNativeTabMetadata",
            PLATFORM_CALLBACK_TIMEOUT,
        );
        let metadata = self.projection_metadata();
        let preferences = metadata.window_preferences;
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let roles = metadata.roles;
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let games = metadata.games;
        let game_icons = games
            .iter()
            .filter_map(|game| {
                game.icon_image_data_url
                    .as_ref()
                    .map(|icon| (game.id.as_str(), icon.as_str()))
            })
            .collect::<HashMap<_, _>>();
        let role_games = roles
            .iter()
            .map(|role| (role.id.as_str(), role.game_id.as_str()))
            .collect::<HashMap<_, _>>();
        let selected_tabs = self.presentation.selected_tabs();
        let updates = self
            .state
            .lock()
            .ok()
            .map(|state| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|tab| !tab.hidden && !state.tab_close_pending(&tab.id))
                    .filter_map(|tab| {
                        let live = state.native_resources.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&tab.window_id, &tab.id)?;
                        let controller = state
                            .native_resources.display_hosts
                            .get(&tab.window_id)?
                            .tabs_controller
                            .clone();
                        let names = tab
                            .slots
                            .iter()
                            .filter_map(|slot| role_names.get(slot.role_id.as_str()).copied())
                            .collect::<Vec<_>>();
                        let tooltip = if tab.tab_type == "workspace" && !names.is_empty() {
                            let separator = if matches!(language.as_str(), "zh-TW" | "zh-CN") {
                                "："
                            } else {
                                ":"
                            };
                            format!("{}{separator}{}", tab.name, names.join(", "))
                        } else {
                            tab.name.clone()
                        };
                        let icon_data_url = presented.icon_data_url.clone().or_else(|| {
                            tab.slots.first().and_then(|slot| {
                                role_games
                                    .get(slot.role_id.as_str())
                                    .and_then(|game_id| game_icons.get(*game_id))
                                    .map(|value| (*value).to_owned())
                            })
                        });
                        let _presentation_identity = presented.source_id.as_str();
                        Some((
                            controller,
                            !presented.closable,
                            crate::runtime_tabs_macos::MacRuntimeTabState {
                                active: selected_tabs
                                    .get(&tab.window_id)
                                    .is_some_and(|selected| selected == &tab.id),
                                audio_muted: presented.audio_muted,
                                audible: runtime_tab_is_audible(&state, live),
                                icon_data_url,
                                id: tab.id.clone(),
                                name: presented.title,
                                tooltip,
                                tab_type: presented.tab_type,
                                workspace_template: presented.workspace_template,
                            },
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut failure_count = 0_usize;
        for (controller, presentation_hides_close, tab) in updates {
            if controller
                .update_metadata(
                tab,
                preferences.always_show_toolbar_in_full_screen,
                preferences.always_hide_tab_close_button || presentation_hides_close,
                &language,
            )
                .is_err()
            {
                failure_count = failure_count.saturating_add(1);
            }
        }
        let receipt = if failure_count == 0 {
            NativeOperationReceipt::applied(operation, "tabMetadataSynchronized")
        } else {
            NativeOperationReceipt::with_status(
                operation,
                "tabMetadataPartiallySynchronized",
                NativeOperationStatus::Degraded,
                Some("NATIVE_TAB_METADATA_PARTIAL"),
            )
        };
        self.record_native_operation_receipt(receipt);
    }

    #[cfg(windows)]
    fn sync_windows_tab_metadata(&self, snapshot: &BrowserRuntimeSnapshot) {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Metadata,
            "syncNativeTabMetadata",
            PLATFORM_CALLBACK_TIMEOUT,
        );
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let metadata = self.projection_metadata();
        let always_hide_tab_close_button = metadata
            .window_preferences
            .always_hide_tab_close_button;
        let roles = metadata.roles;
        let games = metadata.games;
        let icons = roles
            .iter()
            .filter_map(|role| {
                games
                    .iter()
                    .find(|game| game.id == role.game_id)
                    .and_then(|game| game.icon_image_data_url.clone())
                    .map(|icon| (role.id.as_str(), icon))
            })
            .collect::<HashMap<_, _>>();
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let (muted_label, playing_label, close_label) = match language.as_str() {
            "zh-TW" => ("分頁已靜音", "正在播放聲音", "停止並關閉分頁"),
            "zh-CN" => ("标签页已静音", "正在播放声音", "停止并关闭标签页"),
            "ja" => ("タブはミュート中", "音声を再生中", "停止してタブを閉じる"),
            _ => ("Tab muted", "Playing audio", "Stop and close tab"),
        };
        let updates = self
            .state
            .lock()
            .ok()
            .map(|state| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|tab| {
                        !tab.hidden && !state.tab_close_pending(&tab.id)
                    })
                    .filter_map(|tab| {
                        let live = state.native_resources.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&tab.window_id, &tab.id)?;
                        let tab_strip = state.native_resources.display_hosts.get(&tab.window_id)?.tab_strip.clone();
                        let names = tab
                            .slots
                            .iter()
                            .filter_map(|slot| role_names.get(slot.role_id.as_str()).copied())
                            .collect::<Vec<_>>();
                        let tooltip = if tab.tab_type == "workspace" && !names.is_empty() {
                            let separator = if matches!(language.as_str(), "zh-TW" | "zh-CN") {
                                "："
                            } else {
                                ":"
                            };
                            format!("{}{separator}{}", tab.name, names.join(", "))
                        } else {
                            tab.name.clone()
                        };
                        let icon_data_url = presented.icon_data_url.clone().or_else(|| {
                            tab.slots
                                .first()
                                .and_then(|slot| icons.get(slot.role_id.as_str()))
                                .cloned()
                        });
                        let phase = self
                            .presentation
                            .statuses
                            .presentation_phase(&tab.id);
                        Some((
                            tab_strip,
                            json!({
                                "id": tab.id,
                                "name": presented.title,
                                "type": presented.tab_type,
                                "workspaceTemplate": presented.workspace_template,
                                "sourceId": presented.source_id,
                                "phase": phase.as_str(),
                                "tooltip": tooltip,
                                "iconDataUrl": icon_data_url,
                                "audible": runtime_tab_is_audible(&state, live),
                                "audioMuted": presented.audio_muted,
                                "hideCloseButton": always_hide_tab_close_button || !presented.closable,
                                "mutedLabel": muted_label,
                                "playingLabel": playing_label,
                                "closeLabel": close_label,
                            }),
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let batches = updates.into_iter().fold(
            HashMap::<String, (Webview, Vec<Value>)>::new(),
            |mut batches, (webview, metadata)| {
                batches
                    .entry(webview.label().to_owned())
                    .or_insert_with(|| (webview.clone(), Vec::new()))
                    .1
                    .push(metadata);
                batches
            },
        );
        let mut failure_count = 0_usize;
        for (_, (webview, metadata)) in batches {
            let Ok(metadata) = serde_json::to_string(&metadata) else {
                failure_count = failure_count.saturating_add(1);
                continue;
            };
            if webview
                .eval(format!(
                    "window.__rionUpdateRuntimeTabMetadataBatch?.({metadata});"
                ))
                .is_err()
            {
                failure_count = failure_count.saturating_add(1);
            }
        }
        let receipt = if failure_count == 0 {
            NativeOperationReceipt::applied(operation, "tabMetadataSynchronized")
        } else {
            NativeOperationReceipt::with_status(
                operation,
                "tabMetadataPartiallySynchronized",
                NativeOperationStatus::Degraded,
                Some("NATIVE_TAB_METADATA_PARTIAL"),
            )
        };
        self.record_native_operation_receipt(receipt);
    }

    fn bind_role_close_operation(&self, role_id: &str, operation_id: &str) -> RuntimeResult<()> {
        let mut state = self.state()?;
        for surface in state
            .native_resources.surface_registry
            .values_mut()
            .filter(|surface| surface.role_id.as_deref() == Some(role_id))
        {
            surface.close_operation_id = Some(operation_id.to_owned());
        }
        for surface in state
            .native_resources.retired_surface_registry
            .values_mut()
            .filter(|surface| surface.role_id.as_deref() == Some(role_id))
        {
            surface.close_operation_id = Some(operation_id.to_owned());
        }
        Ok(())
    }

    fn bind_tab_close_operation(&self, tab_id: &str, operation_id: &str) -> RuntimeResult<()> {
        let mut state = self.state()?;
        for surface in state
            .native_resources.surface_registry
            .values_mut()
            .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
        {
            surface.close_operation_id = Some(operation_id.to_owned());
        }
        for surface in state
            .native_resources.retired_surface_registry
            .values_mut()
            .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
        {
            surface.close_operation_id = Some(operation_id.to_owned());
        }
        Ok(())
    }

    fn clear_surface_close_operation(&self, operation_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            for surface in state.native_resources.surface_registry.values_mut().filter(|surface| {
                surface.close_operation_id.as_deref() == Some(operation_id)
            }) {
                surface.close_operation_id = None;
            }
            for surface in state
                .native_resources.retired_surface_registry
                .values_mut()
                .filter(|surface| {
                    surface.close_operation_id.as_deref() == Some(operation_id)
                })
            {
                surface.close_operation_id = None;
            }
        }
    }

    pub(crate) fn cancel_surface_close_operation(&self, operation_id: &str) -> usize {
        let surfaces = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .native_resources.surface_registry
                    .values()
                    .chain(state.native_resources.retired_surface_registry.values())
                    .filter(|surface| {
                        surface.close_operation_id.as_deref() == Some(operation_id)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.cancel_surface_group_continuations(
            surfaces,
            "SYSTEM_SURFACE_OPERATION_CANCELLED",
            "The explicit Core operation cancellation ended the pending native close continuation.",
        )
    }

    fn cancel_pending_surface_continuations(
        &self,
        window_id: Option<&str>,
        code: &'static str,
        message: &'static str,
    ) -> usize {
        let surfaces = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .native_resources.surface_registry
                    .values()
                    .chain(state.native_resources.retired_surface_registry.values())
                    .filter(|surface| {
                        window_id.is_none_or(|window_id| surface.window_id == window_id)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.cancel_surface_continuations(surfaces, code, message)
    }

    fn complete_destroyed_host_surface_continuations(
        &self,
        window_id: &str,
        window_generation: u64,
    ) -> usize {
        let surfaces = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .native_resources.surface_registry
                    .values()
                    .chain(state.native_resources.retired_surface_registry.values())
                    .filter(|surface| {
                        destroyed_host_surface_identity_matches(
                            &surface.window_id,
                            surface.window_generation,
                            window_id,
                            window_generation,
                        ) && destroyed_host_surface_close_is_pending(
                            surface.close_operation_id.is_some(),
                            surface.phase,
                        )
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let completed = surfaces
            .into_iter()
            .filter(|surface| surface.lifecycle.mark_parent_window_destroyed())
            .collect::<Vec<_>>();
        for surface in &completed {
            self.record_surface_event(
                LogLevel::Info,
                "surface.parent-window-destroyed",
                "The exact parent window generation destroyed the pending native surface.",
                surface,
            );
        }
        if !completed.is_empty() {
            self.tab_close_changed.notify_all();
        }
        completed.len()
    }

    fn cancel_surface_continuations(
        &self,
        surfaces: Vec<ManagedSurface>,
        code: &'static str,
        message: &'static str,
    ) -> usize {
        self.cancel_surface_continuations_inner(surfaces, code, message, false)
    }

    fn cancel_surface_group_continuations(
        &self,
        surfaces: Vec<ManagedSurface>,
        code: &'static str,
        message: &'static str,
    ) -> usize {
        self.cancel_surface_continuations_inner(surfaces, code, message, true)
    }

    fn cancel_surface_continuations_inner(
        &self,
        surfaces: Vec<ManagedSurface>,
        code: &'static str,
        message: &'static str,
        include_accepted_intent: bool,
    ) -> usize {
        let cancelled = surfaces
            .into_iter()
            .filter(|surface| {
                let accepted_intent = include_accepted_intent
                    || surface.close_operation_id.is_some()
                    || matches!(
                        surface.phase,
                        ManagedSurfacePhase::CloseRequested
                            | ManagedSurfacePhase::Isolating
                            | ManagedSurfacePhase::Isolated
                    );
                if accepted_intent {
                    surface.lifecycle.cancel_accepted_intent(code, message)
                } else {
                    surface.lifecycle.cancel_pending(code, message)
                }
            })
            .collect::<Vec<_>>();
        if cancelled.is_empty() {
            return 0;
        }
        if let Ok(mut state) = self.state.lock() {
            for surface in &cancelled {
                if let Some(current) = state.native_resources.surface_registry.get_mut(&surface.instance_id)
                    && current.generation == surface.generation
                {
                    current.phase = ManagedSurfacePhase::Quarantined;
                }
                if let Some(current) = state
                    .native_resources.retired_surface_registry
                    .get_mut(&surface.instance_id)
                    && current.generation == surface.generation
                {
                    current.phase = ManagedSurfacePhase::Quarantined;
                }
                if let Some(role_id) = surface.role_id.as_ref() {
                    state
                        .close_coordinator
                        .quarantined_roles
                        .insert(role_id.clone());
                }
                if !state
                    .recovery_interrupted_window_ids
                    .contains(&surface.window_id)
                {
                    state
                        .recovery_interrupted_window_ids
                        .push(surface.window_id.clone());
                }
            }
            state.recovery_required = true;
        }
        for surface in &cancelled {
            self.record_surface_event(
                LogLevel::Warn,
                "surface.lifecycle-cancelled",
                "A terminal lifecycle event cancelled the exact pending close continuation.",
                surface,
            );
        }
        cancelled.len()
    }

    async fn close_surface_event_bound(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        _role_id: &str,
    ) -> RuntimeResult<SurfaceCloseOutcome> {
        let label = webview.label().to_owned();
        {
            let mut state = self.state()?;
            if !state
                .close_coordinator
                .closing_webviews
                .insert(label.clone())
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The System WebView surface is already closing.",
                ));
            }
        }
        let result: RuntimeResult<SurfaceCloseOutcome> = async {
            let platform = current_runtime_platform();
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.blank-requested",
                "Native blank isolation was requested.",
                &label,
            );
            let quiesce_result = if lifecycle.native_surface_is_released() {
                Ok(SurfaceIsolationRequest::AlreadyIsolated)
            } else {
                quiesce_platform_surface(webview, lifecycle)
            };
            if let Ok(request) = quiesce_result.as_ref() {
                self.record_surface_isolation_request(&label, *request);
            }
            if let Err(error) = quiesce_result {
                self.record_surface_stage_by_label(
                    LogLevel::Error,
                    "surface.navigation-failed",
                    "Native blank navigation submission failed.",
                    &label,
                );
                return Err(error);
            }
            lifecycle.wait_for_isolation_event().await?;
            if !lifecycle.parent_window_destroyed()
                && lifecycle.native_isolation_event() == 5
            {
                self.record_surface_stage_by_label(
                    LogLevel::Info,
                    "surface.process-terminated",
                    "The exact WebContent process termination stopped the page.",
                    &label,
                );
            } else if !lifecycle.parent_window_destroyed() {
                self.record_surface_stage_by_label(
                    LogLevel::Debug,
                    "surface.blank-finished",
                    "Native blank isolation was confirmed for the exact navigation.",
                    &label,
                );
            }
            if lifecycle.stale_native_event_count() > 0 {
                self.record_surface_stage_by_label(
                    LogLevel::Debug,
                    "surface.stale-native-event",
                    "A native lifecycle event for another or terminal surface generation was ignored.",
                    &label,
                );
            }
            if !lifecycle.parent_window_destroyed() {
                self.record_surface_stage_by_label(
                    LogLevel::Debug,
                    "surface.native-release-requested",
                    "The exact isolated native surface release was requested.",
                    &label,
                );
                if let Err(error) = release_platform_surface(webview, lifecycle)
                    && !lifecycle.parent_window_destroyed()
                {
                    return Err(error);
                }
            }
            lifecycle.wait_for_native_release_event().await?;
            self.record_surface_stage_by_label(
                LogLevel::Info,
                "surface.native-released",
                "The exact native surface generation was released.",
                &label,
            );
            if !lifecycle.parent_window_destroyed() {
                if let Err(error) = webview.close()
                    && !lifecycle.parent_window_destroyed()
                {
                    return Err(RuntimeError::tauri(error));
                }
                if !lifecycle.parent_window_destroyed() {
                    lifecycle.mark_controller_released();
                    self.record_surface_stage_by_label(
                        LogLevel::Info,
                        "surface.wrapper-close-accepted",
                        "Tauri accepted the wrapper close and unregistered its manager entry.",
                        &label,
                    );
                }
            }
            lifecycle.wait_for_store_reusable_event(platform).await?;
            self.record_surface_stage_by_label(
                LogLevel::Info,
                "role.store-reusable",
                "The role store is immediately reusable after exact native release.",
                &label,
            );
            Ok(SurfaceCloseOutcome {
                isolated: true,
                store_reusable: true,
            })
        }
        .await;
        if result.is_ok() {
            self.revoke_overlay_capability(&label);
        }
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_webviews.remove(&label);
        }
        result
    }

    fn close_surface_and_wait(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        role_id: &str,
    ) -> RuntimeResult<SurfaceCloseOutcome> {
        tauri::async_runtime::block_on(self.close_surface_event_bound(
            webview,
            lifecycle,
            role_id,
        ))
    }

    fn close_failed_launch_surface_and_wait(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let label = webview.label().to_owned();
        let outcome = self.close_surface_and_wait(webview, lifecycle, role_id)?;
        if outcome.store_reusable {
            return Ok(());
        }
        let platform = current_runtime_platform();
        if lifecycle.store_is_reusable(platform) {
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.failed-launch-release-verified",
                "The failed launch controller release was verified before compensation.",
                &label,
            );
            Ok(())
        } else {
            Err(RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "The failed launch controller did not release before the cleanup deadline. Restart Rion Studio before retrying.",
            ))
        }
    }

    fn close_untracked_failed_launch_surface_and_wait(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let label = webview.label().to_owned();
        let started = Instant::now();
        webview.close().map_err(RuntimeError::tauri)?;
        self.record_runtime_stage(
            format!("untracked-surface-wrapper-close-accepted:{role_id}:{label}"),
            "completed",
            started,
        );
        Ok(())
    }

    fn close_untracked_failed_launch_window_and_wait(
        &self,
        window: &Window,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let label = window.label().to_owned();
        let started = Instant::now();
        window.close().map_err(RuntimeError::tauri)?;
        self.record_runtime_stage(
            format!("untracked-window-close-accepted:{lifecycle_id}:{label}"),
            "completed",
            started,
        );
        Ok(())
    }

    async fn close_managed_surface_event_bound(
        &self,
        instance_id: &str,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let surface = self.managed_surface(instance_id)?;
        let mut operation = NativeOperationContext::new_event_bound(
            NativeOperationSubsystem::SurfaceLifecycle,
            "closeManagedSurface",
        )
        .with_surface_generation(surface.generation)
        .with_window(&surface.window_id);
        if let Some(role_id) = surface.role_id.as_ref() {
            operation = operation.with_role(role_id);
        }
        if let Some(tab_id) = surface.tab_id.as_ref() {
            operation = operation.with_tab(tab_id);
        }
        let result: RuntimeResult<()> = async {
            match surface.phase {
                ManagedSurfacePhase::Released => return Ok(()),
                ManagedSurfacePhase::CloseRequested
                | ManagedSurfacePhase::Isolating
                | ManagedSurfacePhase::Isolated
                => {
                    return self.wait_for_managed_surface_release(instance_id, &surface).await;
                }
                ManagedSurfacePhase::Live
                | ManagedSurfacePhase::Provisional
                | ManagedSurfacePhase::Quarantined
                | ManagedSurfacePhase::Retired => {}
            }
            let (surface, owns_close) = {
                let mut state = self.state()?;
                let surface = state.native_resources.surface_registry.get_mut(instance_id).ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_REGISTRY_MISSING",
                        "The native surface registry entry is missing.",
                    )
                })?;
                let owns_close = match surface.phase {
                    ManagedSurfacePhase::Released => return Ok(()),
                    ManagedSurfacePhase::CloseRequested
                    | ManagedSurfacePhase::Isolating
                    | ManagedSurfacePhase::Isolated
                    => false,
                    ManagedSurfacePhase::Live
                    | ManagedSurfacePhase::Provisional
                    | ManagedSurfacePhase::Quarantined
                    | ManagedSurfacePhase::Retired => {
                        surface.phase = ManagedSurfacePhase::CloseRequested;
                        true
                    }
                };
                (surface.clone(), owns_close)
            };
            if !owns_close {
                return self.wait_for_managed_surface_release(instance_id, &surface).await;
            }
            self.record_surface_event(
                LogLevel::Debug,
                "surface.phase",
                "Native surface phase changed.",
                &surface,
            );
            self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolating)?;
            self.record_surface_event(
                LogLevel::Info,
                "surface.close-requested",
                "Native surface close requested.",
                &surface,
            );
            let close_result = self
                .close_surface_event_bound(&surface.webview, &surface.lifecycle, lifecycle_id)
                .await;
            match close_result {
                Ok(outcome) => {
                    self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolated)?;
                    if !outcome.isolated || !outcome.store_reusable {
                        return Err(RuntimeError::new(
                            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                            "The exact native surface generation did not finish releasing.",
                        ));
                    }
                    self.remove_managed_surface(instance_id)?;
                    self.tab_close_changed.notify_all();
                    Ok(())
                }
                Err(error) => {
                    if let Ok(mut state) = self.state.lock() {
                        if let Some(current) = state.native_resources.surface_registry.get_mut(instance_id) {
                            current.phase = ManagedSurfacePhase::Quarantined;
                        }
                        if let Some(role_id) = surface.role_id.as_ref() {
                            state
                                .close_coordinator
                                .quarantined_roles
                                .insert(role_id.clone());
                        }
                    }
                    self.record_surface_event(
                        LogLevel::Error,
                        "surface.close-unverified",
                        "Native surface close could not be verified.",
                        &surface,
                    );
                    Err(RuntimeError::new(error.code, error.message))
                }
            }
        }
        .await;
        let receipt = match result.as_ref() {
            Ok(()) => NativeOperationReceipt::applied(operation, "surfaceIsolated"),
            Err(error) if error.code == "SYSTEM_SURFACE_RELEASE_UNVERIFIED" => {
                NativeOperationReceipt::with_status(
                    operation,
                    "surfaceIsolationUnverified",
                    NativeOperationStatus::Indeterminate,
                    Some(error.code),
                )
            }
            Err(error) => NativeOperationReceipt::with_status(
                operation,
                "surfaceIsolationFailed",
                NativeOperationStatus::Failed,
                Some(error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn close_managed_surface_and_wait(
        &self,
        instance_id: &str,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        tauri::async_runtime::block_on(
            self.close_managed_surface_event_bound(instance_id, lifecycle_id),
        )
    }

    async fn wait_for_managed_surface_release(
        &self,
        _instance_id: &str,
        surface: &ManagedSurface,
    ) -> RuntimeResult<()> {
        surface
            .lifecycle
            .wait_for_store_reusable_event(current_runtime_platform())
            .await
    }

    fn close_popup_and_wait(&self, label: &str, role_id: &str) -> RuntimeResult<()> {
        let instance_id = self
            .state()?
            .native_resources.surface_registry
            .values()
            .find(|surface| {
                surface.kind == ManagedSurfaceKind::Popup
                    && surface.role_id.as_deref() == Some(role_id)
                    && surface.webview.label() == label
            })
            .map(|surface| surface.instance_id.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The popup native surface registry entry is missing.",
                )
            })?;
        self.close_managed_surface_and_wait(&instance_id, role_id)
    }

    fn close_managed_divider(&self, instance_id: &str) -> RuntimeResult<()> {
        let surface = self.managed_surface(instance_id)?;
        if surface.kind != ManagedSurfaceKind::Divider {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_REGISTRY_MISMATCH",
                "The native surface is not a workspace divider.",
            ));
        }
        self.close_managed_surface_and_wait(instance_id, instance_id)
    }

}
