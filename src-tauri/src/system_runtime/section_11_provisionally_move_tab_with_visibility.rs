#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProvisionalMoveFollowerPlan {
    reconcile_target_presentation: bool,
    reparent_surfaces: bool,
}

fn provisional_move_follower_plan(
    native_already_at_target: bool,
    tab_was_visible: bool,
) -> ProvisionalMoveFollowerPlan {
    ProvisionalMoveFollowerPlan {
        reconcile_target_presentation: tab_was_visible,
        reparent_surfaces: !native_already_at_target,
    }
}

impl SystemRuntimeExecutor {
    fn provisionally_move_tab_with_visibility_inner(
        &self,
        tab_id: &str,
        target_window_id: &str,
        reveal_hidden_target: bool,
        live_drag: bool,
    ) -> Result<(), String> {
        let live_window_id = self.resolve_live_tab_window_id(tab_id).map_err(|error| error.message)?;
        if live_window_id != target_window_id {
            // A newer topology intent already chose another destination. Native
            // projection work is stale and must never move the live tab back.
            return Ok(());
        }
        let (source_window_id, target_window, surfaces) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            let Some(tab) = state.native_resources.tabs.get(tab_id) else {
                // The visible tab may legitimately outlive its native resources
                // while a surface is loading or after a late cleanup callback.
                return Ok(());
            };
            let source_window_id = state
                .native_host_for_tab_handle(tab_id)
                .unwrap_or_else(|| live_window_id.clone());
            let target_window = state
                .native_resources.display_hosts
                .get(target_window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
            let mut surfaces = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            surfaces.extend(
                tab.slots
                    .values()
                    .filter_map(|slot| slot.placeholder.as_ref())
                    .map(|placeholder| placeholder.webview.clone()),
            );
            surfaces.extend(tab.dividers.iter().map(|divider| divider.webview.clone()));
            (source_window_id, target_window, surfaces)
        };
        let native_already_at_target = source_window_id == target_window_id;
        let selected_tabs_before_move = self.presentation.selected_tabs();
        let tab_was_visible = selected_tabs_before_move
            .get(target_window_id)
            .is_some_and(|active_tab_id| active_tab_id == tab_id);
        let follower_plan =
            provisional_move_follower_plan(native_already_at_target, tab_was_visible);
        let target_active_after_move = selected_tabs_before_move.get(target_window_id).cloned();
        let move_revision = self
            .presentation
            .existing(target_window_id)
            .map(|live| live.revision)
            .unwrap_or_else(|| self.presentation.current_revision());
        let target_window_was_visible = target_window
            .is_visible()
            .map_err(|error| error.to_string())?;

        let (source_is_empty, moved_surfaces) = if !follower_plan.reparent_surfaces {
            // A forward projection may win the race after live topology commits. Native
            // ownership is then already correct, but a newly-created target host remains
            // intentionally cloaked until the target presentation below is acknowledged.
            // Do not let the idempotent reparent shortcut skip that reveal boundary.
            (false, Vec::new())
        } else {
            let (_, source_presentation_operation_id) = self
                .reconcile_window_presentation(&source_window_id, "provisional-move-source")?;
            let source_receipt =
                self.wait_native_operation_summary(&source_presentation_operation_id)?;
            if !matches!(
                source_receipt.status,
                SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
            ) {
                return Err("The source presentation was superseded before reparent.".to_owned());
            }
            for surface in &surfaces {
                #[cfg(target_os = "macos")]
                let result = crate::runtime_tabs_macos::run_on_appkit_tracking_main({
                    let surface = surface.clone();
                    let target_window = target_window.clone();
                    move || surface.reparent(&target_window)
                })
                .and_then(|result| result.map_err(|error| error.to_string()));
                #[cfg(not(target_os = "macos"))]
                let result = surface
                    .reparent(&target_window)
                    .map_err(|error| error.to_string());
                if let Err(error) = result {
                    return Err(error.to_string());
                }
            }
            #[cfg(windows)]
            match synchronize_windows_reparented_surfaces(&surfaces, &target_window) {
                Ok(outcome) => self.record_windows_reparent_sync_event(
                    "tab.reparent-synchronized",
                    "WebView2 surfaces synchronized with the target Game Window after reparenting.",
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    "provisional-move",
                    Ok(&outcome),
                    None,
                ),
                Err(failure) => {
                    self.record_windows_reparent_sync_event(
                        "tab.reparent-sync-failed",
                        "WebView2 surfaces could not synchronize with the target Game Window.",
                        tab_id,
                        &source_window_id,
                        target_window_id,
                        "provisional-move",
                        Err(&failure),
                        None,
                    );
                    return Err(failure.message);
                }
            }
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    return Err("The System WebView runtime state lock was poisoned.".to_owned());
                }
            };
            let Some(_tab) = state.native_resources.tabs.get_mut(tab_id) else {
                drop(state);
                return Ok(());
            };
            let Some(target_window_generation) = state
                .native_resources.display_hosts
                .get(target_window_id)
                .map(|host| host.generation)
            else {
                return Err(
                    "The target native window generation disappeared during reparenting."
                        .to_owned(),
                );
            };
            for surface in state.native_resources.surface_registry.values_mut() {
                if surface.tab_id.as_deref() == Some(tab_id) {
                    surface.window_id = target_window_id.to_owned();
                    surface.window_generation = target_window_generation;
                }
            }
            let moved_surfaces = state
                .native_resources.surface_registry
                .values()
                .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                .cloned()
                .collect::<Vec<_>>();
            let source_is_empty = self
                .live_tab_ids_for_window(&source_window_id)
                .iter()
                .all(|live_tab_id| live_tab_id == tab_id);
            (source_is_empty, moved_surfaces)
        };
        self.presentation.follow_live_projection_membership()?;
        for surface in &moved_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }
        self.apply_native_active_style(
            target_window_id,
            target_active_after_move.as_deref(),
            move_revision,
            "provisional-move",
        );
        let reveal_result = (|| {
            if !(cfg!(target_os = "macos") && live_drag) {
                self.layout_runtime_tab(tab_id)
                    .map_err(|error| error.message)?;
            }
            if follower_plan.reconcile_target_presentation {
                let reveal_window = reveal_hidden_target || target_window_was_visible;
                // The target actor has never applied this surface when a tab is
                // reparented into a newly-created hidden host. Re-selecting the
                // already-authoritative tab would seed that actor from live
                // topology and incorrectly turn the required WebView show into
                // a no-op. Reconcile from the actor's empty physical projection
                // after the exact reparent acknowledgement instead.
                let (_, operation_id) = self.reconcile_window_presentation_with_visibility(
                    target_window_id,
                    "provisional-move-target",
                    reveal_window.then_some(true),
                )?;
                let receipt = self.wait_native_operation_summary(&operation_id)?;
                if !matches!(
                    receipt.status,
                    SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
                ) {
                    return Err("The target presentation was superseded after reparent.".to_owned());
                }
            }
            if source_is_empty {
                let (_, operation_id) = self
                    .request_window_contract_presentation(
                        &source_window_id,
                        Some(false),
                        NativePresentationFocus::None,
                        None,
                        "provisional-move-empty-source",
                    )
                    .map_err(|error| error.message)?;
                let receipt = self.wait_native_operation_summary(&operation_id)?;
                if !matches!(
                    receipt.status,
                    SystemRuntimeOperationStatus::Applied
                        | SystemRuntimeOperationStatus::Degraded
                ) {
                    return Err("The empty source window hide was superseded.".to_owned());
                }
            }
            Ok::<(), String>(())
        })();
        reveal_result?;
        if cfg!(target_os = "macos") && live_drag {
            self.schedule_live_tab_drag_layout(tab_id.to_owned());
        }
        Ok(())
    }

    fn schedule_live_tab_drag_layout(&self, tab_id: String) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-drag-layout-{tab_id}"))
            .spawn(move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                if let Err(error) = runtime.layout_runtime_tab(&tab_id) {
                    eprintln!("Live tab drag layout remains pending: tab={tab_id} error={}", error.message);
                }
            });
    }

    pub(crate) fn show_tab_drag_window(&self, window_id: &str) -> Result<(), String> {
        let (_, operation_id) = self
            .request_window_contract_presentation(
                window_id,
                Some(true),
                NativePresentationFocus::None,
                None,
                "tab-drag-target-reveal",
            )
            .map_err(|error| error.message)?;
        let receipt = self.wait_native_operation_summary(&operation_id)?;
        if matches!(
            receipt.status,
            SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
        ) {
            Ok(())
        } else {
            Err("The tab drag target reveal was superseded.".to_owned())
        }
    }

    pub fn discard_provisional_game_window(&self, window_id: &str) {
        if !self.live_tab_ids_for_window(window_id).is_empty() {
            return;
        }
        let Some((host, can_discard)) = self.state.lock().ok().map(|mut state| {
            let still_hosts_native_tab = state.window_has_attached_tab_handles(window_id);
            if still_hosts_native_tab {
                return (None, false);
            }
            let host = state.native_resources.display_hosts.remove(window_id);
            if let Some(host) = host.as_ref() {
                state
                    .allow_window_close_labels
                    .insert(host.window.label().to_owned());
            }
            (host, true)
        }) else {
            return;
        };
        if !can_discard {
            return;
        }
        self.presentation.remove(window_id);
        self.cancel_pending_window_activation(window_id);
        self.notify_optional_idle_changed();
        self.publish_launcher_presence();
        if let Some(host) = host {
            self.focus_broker
                .revoke_window(window_id, host.generation);
            self.unregister_runtime_launcher_window(window_id);
            let _ = host.window.close();
        }
    }

    #[cfg(not(windows))]
    pub fn window_id_for_label(&self, label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| window_id.clone())
            })
        })
    }

    #[cfg(windows)]
    pub fn tab_strip_window_for_webview(&self, webview_label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.native_resources.display_hosts.values().find_map(|host| {
                (host.tab_strip.label() == webview_label).then(|| host.target.window_id.clone())
            })
        })
    }

    #[cfg(windows)]
    pub fn tab_status_window_for_webview(&self, webview_label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.native_resources.display_hosts.values().find_map(|host| {
                host.tab_status
                    .as_ref()
                    .filter(|status| status.webview.label() == webview_label)
                    .map(|_| host.target.window_id.clone())
            })
        })
    }

    #[cfg(not(windows))]
    pub fn tab_status_window_for_webview(&self, _webview_label: &str) -> Option<String> {
        None
    }

    #[cfg(not(windows))]
    pub fn tab_strip_window_for_webview(&self, _webview_label: &str) -> Option<String> {
        None
    }

    pub fn reload_tab(
        self: &Arc<Self>,
        tab_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        let operation_id = self
            .reload_tab_contract(tab_id)
            .map_err(|error| error.message)?;
        self.wait_native_operation_summary(&operation_id)
    }

    pub fn set_tab_audio_muted(
        &self,
        tab_id: &str,
        muted: bool,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.require_runtime_accepting()
            .map_err(|error| error.message)?;
        let window_id = self.resolve_live_tab_window_id(tab_id).map_err(|error| error.message)?;
        let (role_id, surface_generation) = {
            let state = self.state().map_err(|error| error.message)?;
            let tab = state
                .native_resources.tabs
                .get(tab_id)
                .ok_or_else(|| "runtime tab was not found".to_owned())?;
            let role_id = tab
                .roles
                .keys()
                .next()
                .cloned()
                .ok_or_else(|| "runtime tab has no owned role surface".to_owned())?;
            let surface_generation = tab.roles.get(&role_id).map(|role| role.generation);
            (role_id, surface_generation)
        };
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Audio,
            "setGameWindowTabMuted",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
        .with_role(&role_id)
        .with_tab(tab_id)
        .with_window(window_id.clone());
        operation.surface_generation = surface_generation;
        self.operations
            .register(operation.clone())
            .map_err(str::to_owned)?;
        if !self.operations.mark_in_flight(&operation.operation_id) {
            return self.wait_native_operation_summary(&operation.operation_id);
        }
        let live = self
            .presentation
            .existing(&window_id)
            .ok_or_else(|| "runtime window was not found".to_owned())?;
        let previous_muted = live
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.audio_muted)
            .ok_or_else(|| "runtime tab was not found".to_owned())?;
        let desired = self
            .presentation
            .live
            .commit_tab_audio_muted(live.revision, tab_id, &window_id, muted)?;
        if desired.status == LiveTopologyCommitStatus::Superseded {
            return Ok(self
                .operations
                .complete(NativeOperationReceipt::with_status(
                    operation,
                    "audioMuteSuperseded",
                    NativeOperationStatus::Superseded,
                    Some("SYSTEM_RUNTIME_AUDIO_STALE"),
                ))
                .summary());
        }
        if let Err(error) = self.apply_role_audio_muted(&role_id, muted, previous_muted) {
            let compensation = self.presentation.live.commit_tab_audio_muted(
                desired.revision,
                tab_id,
                &window_id,
                previous_muted,
            );
            let compensation_is_indeterminate = match compensation.as_ref() {
                Ok(receipt) => receipt.status == LiveTopologyCommitStatus::Superseded,
                Err(_) => true,
            };
            let status = if error.code == "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"
                || compensation_is_indeterminate
            {
                NativeOperationStatus::Indeterminate
            } else {
                NativeOperationStatus::Failed
            };
            let mut receipt = NativeOperationReceipt::with_status(
                operation,
                "audioMuteFailed",
                status,
                Some(error.code),
            );
            if let Some(count) = error.rollback_error_count {
                receipt = receipt.with_rollback_error_count(count as usize);
            }
            return Ok(self.operations.complete(receipt).summary());
        }
        self.publish_projection();
        self.schedule_live_window_state_persistence(&window_id);
        Ok(self
            .operations
            .complete(NativeOperationReceipt::applied(
                operation,
                "audioMuteApplied",
            ))
            .summary())
    }

    #[cfg(windows)]
    fn windows_active_tab_is_materialized(
        &self,
        window_id: &str,
        tab_id: &str,
    ) -> Result<bool, String> {
        let state = self.state().map_err(|error| error.message)?;
        Ok(state.native_resources.display_hosts.contains_key(window_id)
            && state.native_resources.tabs.contains_key(tab_id))
    }

    #[cfg(windows)]
    fn refresh_windows_active_window_layout(&self, window_id: &str) -> Result<(), String> {
        let Some(tab_id) = self
            .presentation
            .existing(window_id)
            .and_then(|window| window.selected_tab_id.clone())
        else {
            return Ok(());
        };
        if !self.windows_active_tab_is_materialized(window_id, &tab_id)? {
            return Ok(());
        }
        if let Err(error) = self.layout_runtime_tab(&tab_id) {
            if !self.windows_active_tab_is_materialized(window_id, &tab_id)? {
                return Ok(());
            }
            return Err(error.message);
        }
        Ok(())
    }

    #[cfg(windows)]
    pub fn set_windows_toolbar_revealed(
        &self,
        window_id: &str,
        revealed: bool,
    ) -> Result<(), String> {
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .native_resources.display_hosts
                .get_mut(window_id)
                .ok_or_else(|| "Runtime display host was not found".to_owned())?;
            host.toolbar_revealed = revealed;
            self.live_tab_ids_for_window(window_id)
        };
        for tab_id in tab_ids {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        self.publish_projection();
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn set_windows_toolbar_revealed(
        &self,
        _window_id: &str,
        _revealed: bool,
    ) -> Result<(), String> {
        Err("Windows runtime tab strip is unavailable on this platform".to_owned())
    }
}
