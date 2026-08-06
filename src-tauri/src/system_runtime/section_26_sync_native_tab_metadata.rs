impl SystemRuntimeExecutor {
    #[cfg(target_os = "macos")]
    fn sync_native_tab_metadata(&self, snapshot: &BrowserRuntimeSnapshot) {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Metadata,
            "syncNativeTabMetadata",
            PLATFORM_CALLBACK_TIMEOUT,
        );
        let preferences = crate::runtime_tabs_macos::runtime_window_preferences(&self.core);
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let roles = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default();
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let games = self
            .core
            .invoke(CoreCommand::GamesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateGameRecord>>(value).ok())
            .unwrap_or_default();
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
                    .filter(|tab| !tab.hidden && !state.optimistic_closed_tabs.contains(&tab.id))
                    .filter_map(|tab| {
                        let live = state.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&tab.window_id, &tab.id)?;
                        let controller = state
                            .display_hosts
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
                                audio_muted: live.audio_muted,
                                audible: runtime_tab_is_audible(&state, live),
                                icon_data_url,
                                id: tab.id.clone(),
                                name: presented.title,
                                tooltip,
                                tab_type: presented.tab_type,
                                workspace_template: presented
                                    .workspace_template
                                    .or_else(|| live.workspace_template.clone()),
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
        let preferences = self
            .core
            .invoke(CoreCommand::RuntimeWindowPreferencesGet)
            .unwrap_or(Value::Null);
        let always_hide_tab_close_button = preferences["alwaysHideTabCloseButton"]
            .as_bool()
            .unwrap_or(false);
        let roles = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default();
        let games = self
            .core
            .invoke(CoreCommand::GamesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateGameRecord>>(value).ok())
            .unwrap_or_default();
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
                        !tab.hidden && !state.optimistic_closed_tabs.contains(&tab.id)
                    })
                    .filter_map(|tab| {
                        let live = state.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&tab.window_id, &tab.id)?;
                        let tab_strip = state.display_hosts.get(&tab.window_id)?.tab_strip.clone();
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
                                "workspaceTemplate": presented
                                    .workspace_template
                                    .or_else(|| live.workspace_template.clone()),
                                "sourceId": presented.source_id,
                                "phase": phase.as_str(),
                                "tooltip": tooltip,
                                "iconDataUrl": icon_data_url,
                                "audible": runtime_tab_is_audible(&state, live),
                                "audioMuted": live.audio_muted,
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

    fn close_surface_and_wait(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        role_id: &str,
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
        let result = (|| -> RuntimeResult<SurfaceCloseOutcome> {
            let platform = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "other"
            };
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.blank-requested",
                "Native blank isolation was requested.",
                &label,
            );
            let quiesce_result = if lifecycle.native_surface_is_released() {
                lifecycle.mark_isolated();
                Ok(SurfaceIsolationRequest::AlreadyIsolated)
            } else {
                quiesce_platform_surface(webview, lifecycle)
            };
            if let Ok(request) = quiesce_result.as_ref() {
                self.record_surface_isolation_request(&label, *request);
            }
            let isolated = quiesce_result.is_ok()
                && lifecycle.wait_for_isolation(SURFACE_ISOLATION_TIMEOUT);
            if !isolated {
                self.record_surface_stage_by_label(
                    LogLevel::Error,
                    "surface.quiesce-unverified",
                    "Native surface isolation could not be verified.",
                    &label,
                );
                let quiesce_error = quiesce_result.err().map(|error| error.message);
                let message = "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.".to_owned();
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "failureKind": "native-isolation-timeout",
                        "message": message,
                        "roleId": role_id,
                        "webviewLabel": label,
                        "quiesceError": quiesce_error,
                        "isolationWaitMs": SURFACE_ISOLATION_TIMEOUT.as_millis()
                    }),
                );
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    message,
                ));
            }
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.blank-finished",
                "Native blank isolation was confirmed for the exact surface.",
                &label,
            );
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.native-release-requested",
                "The exact isolated native surface release was requested.",
                &label,
            );
            release_platform_surface(lifecycle)?;
            if !lifecycle.wait_for(
                SURFACE_RECLAMATION_TIMEOUT,
                |release| release.native_surface_released,
            ) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The native surface did not acknowledge its exact release before the watchdog deadline.",
                ));
            }
            self.record_surface_stage_by_label(
                LogLevel::Info,
                "surface.native-released",
                "The exact native surface generation was released.",
                &label,
            );
            webview.close().map_err(RuntimeError::tauri)?;
            lifecycle.mark_controller_released();
            self.record_surface_stage_by_label(
                LogLevel::Info,
                "surface.wrapper-close-accepted",
                "Tauri accepted the wrapper close and unregistered its manager entry.",
                &label,
            );
            let store_reusable = lifecycle.wait_for_store_reusable(platform, Duration::ZERO);
            if !store_reusable {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The exact surface generation did not reach the store-reusable milestone.",
                ));
            }
            self.record_surface_stage_by_label(
                LogLevel::Info,
                "role.store-reusable",
                "The role store is immediately reusable after exact native release.",
                &label,
            );
            Ok(SurfaceCloseOutcome {
                isolated,
                store_reusable,
            })
        })();
        if result.is_ok() {
            self.revoke_overlay_capability(&label);
        }
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_webviews.remove(&label);
        }
        result
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
        if lifecycle.wait_for_store_reusable(platform, Duration::ZERO) {
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

    fn close_managed_surface_and_wait(
        &self,
        instance_id: &str,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let surface = self.managed_surface(instance_id)?;
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::SurfaceLifecycle,
            "closeManagedSurface",
            SURFACE_RECLAMATION_TIMEOUT,
        )
        .with_surface_generation(surface.generation)
        .with_window(&surface.window_id);
        if let Some(role_id) = surface.role_id.as_ref() {
            operation = operation.with_role(role_id);
        }
        if let Some(tab_id) = surface.tab_id.as_ref() {
            operation = operation.with_tab(tab_id);
        }
        let result = (|| {
            match surface.phase {
                ManagedSurfacePhase::Released => return Ok(()),
                ManagedSurfacePhase::CloseRequested
                | ManagedSurfacePhase::Isolating
                | ManagedSurfacePhase::Isolated
                => {
                    return self.wait_for_managed_surface_release(instance_id, &surface);
                }
                ManagedSurfacePhase::Live
                | ManagedSurfacePhase::Provisional
                | ManagedSurfacePhase::Quarantined
                | ManagedSurfacePhase::Retired => {}
            }
            let native_lifecycle_guard = surface.native_lifecycle_lane.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                    "The native surface lifecycle lane is unavailable.",
                )
            })?;
            let (surface, owns_close) = {
                let mut state = self.state()?;
                let surface = state.surface_registry.get_mut(instance_id).ok_or_else(|| {
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
                        surface.close_started_at = Some(Instant::now());
                        true
                    }
                };
                (surface.clone(), owns_close)
            };
            if !owns_close {
                drop(native_lifecycle_guard);
                return self.wait_for_managed_surface_release(instance_id, &surface);
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
            let close_result =
                self.close_surface_and_wait(&surface.webview, &surface.lifecycle, lifecycle_id);
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
                        if let Some(current) = state.surface_registry.get_mut(instance_id) {
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
        })();
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

    fn wait_for_managed_surface_release(
        &self,
        instance_id: &str,
        surface: &ManagedSurface,
    ) -> RuntimeResult<()> {
        let deadline = surface
            .close_started_at
            .unwrap_or_else(Instant::now)
            .checked_add(SURFACE_RECLAMATION_TIMEOUT)
            .unwrap_or_else(Instant::now);
        if surface
            .lifecycle
            .wait_for_store_reusable(
                current_runtime_platform(),
                deadline.saturating_duration_since(Instant::now()),
            )
        {
            return Ok(());
        }
        let phase = self
            .state()?
            .surface_registry
            .get(instance_id)
            .map(|surface| surface.phase);
        if phase.is_none()
            || matches!(
                phase,
                Some(
                    ManagedSurfacePhase::Released
                )
            )
        {
            return Ok(());
        }
        Err(RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "Rion Studio could not verify the exact native surface release. The tab remains closed; restart Rion Studio before reopening this role.",
        ))
    }

    fn close_popup_and_wait(&self, label: &str, role_id: &str) -> RuntimeResult<()> {
        let instance_id = self
            .state()?
            .surface_registry
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
