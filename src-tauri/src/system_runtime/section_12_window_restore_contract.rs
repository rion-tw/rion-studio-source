struct RestoredForegroundVisibilitySnapshot<'a> {
    host_current: bool,
    live_contains_tab: bool,
    live_revision: u64,
    live_selected_tab_id: Option<&'a str>,
    live_window_generation: u64,
    tab_current: bool,
}

struct RestoredWindowDefinition<'a> {
    name: &'a str,
    tabs: &'a [GameWindowTabRecord],
}

fn restored_foreground_visibility_is_current(
    fence: &RestoredWindowVisibilityFence,
    tab_id: &str,
    window_generation: u64,
    snapshot: RestoredForegroundVisibilitySnapshot<'_>,
) -> bool {
    !fence.reveal_dispatched
        && fence.foreground_tab_id == tab_id
        && fence.window_generation == window_generation
        && snapshot.live_window_generation == window_generation
        && snapshot.live_revision >= fence.topology_revision
        && snapshot.live_selected_tab_id == Some(tab_id)
        && snapshot.live_contains_tab
        && snapshot.host_current
        && snapshot.tab_current
}

fn restored_tab_selection_intent_is_current(
    should_select: bool,
    restored_selected_tab_id: Option<&str>,
    tab_id: &str,
    current_selected_tab_id: Option<&str>,
) -> bool {
    if !should_select {
        return false;
    }
    let Some(restored_selected_tab_id) = restored_selected_tab_id else {
        return true;
    };
    restored_selected_tab_id == tab_id
        && current_selected_tab_id
            .is_none_or(|current| current == restored_selected_tab_id)
}

pub(crate) struct RestoredLaunchAdmission<'a> {
    admission_signal: &'a mut crate::runtime_tab_menu::LaunchAdmissionSignal,
    hydration_operation_id: &'a str,
    intent_id: &'a str,
    started_at: Instant,
}

impl<'a> RestoredLaunchAdmission<'a> {
    pub(crate) fn new(
        intent_id: &'a str,
        hydration_operation_id: &'a str,
        started_at: Instant,
        admission_signal: &'a mut crate::runtime_tab_menu::LaunchAdmissionSignal,
    ) -> Self {
        Self {
            admission_signal,
            hydration_operation_id,
            intent_id,
            started_at,
        }
    }

    fn latency_trace(&self) -> RuntimeLaunchLatencyTrace {
        RuntimeLaunchLatencyTrace {
            hydration_operation_id: self.hydration_operation_id.to_owned(),
            intent_id: self.intent_id.to_owned(),
            started_at: self.started_at,
        }
    }
}

impl SystemRuntimeExecutor {
    pub fn prepare_restored_window_tabs(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        saved_name: &str,
        tabs: &[GameWindowTabRecord],
        active_tab_id: Option<String>,
    ) -> Result<(), String> {
        self.prepare_restored_window_tabs_internal(
            target,
            RestoredWindowDefinition {
                name: saved_name,
                tabs,
            },
            active_tab_id,
            None,
            None,
            None,
        )
        .map(|_| ())
    }

    pub(crate) fn prepare_restored_window_tabs_for_launch(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        saved_name: &str,
        tabs: &[GameWindowTabRecord],
        active_tab_id: Option<String>,
        admission: &mut RestoredLaunchAdmission<'_>,
    ) -> Result<(), String> {
        let launch_trace = admission.latency_trace();
        self.prepare_restored_window_tabs_internal(
            target,
            RestoredWindowDefinition {
                name: saved_name,
                tabs,
            },
            active_tab_id,
            None,
            Some(launch_trace),
            Some(&mut *admission.admission_signal),
        )
        .map(|_| ())
    }

    pub(crate) fn prepare_restored_window_tabs_with_launch_for_intent(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        saved_name: &str,
        tabs: &[GameWindowTabRecord],
        source_id: &str,
        tab_type: &str,
        admission: &mut RestoredLaunchAdmission<'_>,
    ) -> Result<LaunchPreviewHandle, String> {
        let launch_trace = admission.latency_trace();
        self.prepare_restored_window_tabs_internal(
            target,
            RestoredWindowDefinition {
                name: saved_name,
                tabs,
            },
            None,
            Some((source_id, tab_type)),
            Some(launch_trace),
            Some(&mut *admission.admission_signal),
        )?
        .ok_or_else(|| "The restored launch preview was not created.".to_owned())
    }

    fn prepare_restored_window_tabs_internal(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        saved: RestoredWindowDefinition<'_>,
        active_tab_id: Option<String>,
        appended_source: Option<(&str, &str)>,
        launch_trace: Option<RuntimeLaunchLatencyTrace>,
        mut admission_signal: Option<&mut crate::runtime_tab_menu::LaunchAdmissionSignal>,
    ) -> Result<Option<LaunchPreviewHandle>, String> {
        let window_id = target.window_id.as_str();
        let tabs = saved.tabs;
        let ordered_tab_ids = tabs.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
        if ordered_tab_ids.is_empty() && appended_source.is_none() {
            return Ok(None);
        }
        if ordered_tab_ids.iter().collect::<HashSet<_>>().len() != ordered_tab_ids.len() {
            return Err("The saved window contains duplicate runtime tab identifiers.".to_owned());
        }
        for tab_id in &ordered_tab_ids {
            if let Some(owner) = self
                .presentation
                .tab_window(tab_id)
                .map_err(|message| message.to_owned())?
                && owner != window_id
            {
                return Err(format!(
                    "Runtime tab {tab_id} is already presented by window {owner}."
                ));
            }
        }
        let launch_preview = appended_source.map(|(source_id, tab_type)| {
            (
                allocate_launch_preview_handle(source_id, tab_type),
                source_id.to_owned(),
                tab_type.to_owned(),
            )
        });
        let existing_tab_ids = {
            let state = self.state().map_err(|error| error.message)?;
            ordered_tab_ids
                .iter()
                .filter(|tab_id| state.native_resources.tabs.contains_key(*tab_id))
                .cloned()
                .collect::<HashSet<_>>()
        };
        let mut visible_tab_ids = tabs
            .iter()
            .filter(|tab| !tab.hidden)
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>();
        if let Some((preview, _, _)) = launch_preview.as_ref() {
            visible_tab_ids.push(preview.provisional_tab_id.clone());
        }
        let saved_foreground_tab_id = active_tab_id
            .clone()
            .filter(|tab_id| visible_tab_ids.contains(tab_id))
            .or_else(|| visible_tab_ids.first().cloned());
        let foreground_tab_id = launch_preview
            .as_ref()
            .map(|(preview, _, _)| preview.provisional_tab_id.clone())
            .or(saved_foreground_tab_id);
        let title = foreground_tab_id
            .as_ref()
            .and_then(|foreground| tabs.iter().find(|tab| &tab.id == foreground))
            .map(|tab| tab.name.as_str())
            .unwrap_or(RION_STUDIO_APP_NAME);
        let mut reserved_tab_ids = existing_tab_ids.clone();
        reserved_tab_ids.extend(
            tabs.iter()
                .filter(|tab| tab.hidden)
                .map(|tab| tab.id.clone()),
        );
        let mut live_tabs = tabs
            .iter()
            .map(|tab| LiveTabRecord {
                audio_muted: tab.audio_muted,
                closable: true,
                icon_data_url: None,
                id: tab.id.clone(),
                persistable: true,
                role_ids: tab
                    .role_slots
                    .iter()
                    .map(|slot| slot.role_id.clone())
                    .collect(),
                role_slots: tab.role_slots.clone(),
                source_id: tab.source_id.clone(),
                tab_type: tab.tab_type.clone(),
                title: tab.name.clone(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            })
            .collect::<Vec<_>>();
        if let Some((preview, source_id, tab_type)) = launch_preview.as_ref() {
            live_tabs.push(LiveTabRecord {
                audio_muted: false,
                closable: true,
                icon_data_url: None,
                id: preview.provisional_tab_id.clone(),
                persistable: false,
                role_ids: if tab_type == "role" {
                    vec![source_id.clone()]
                } else {
                    Vec::new()
                },
                role_slots: Vec::new(),
                source_id: source_id.clone(),
                tab_type: tab_type.clone(),
                title: "Loading…".to_owned(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            });
        }
        let hidden_tab_ids = tabs
            .iter()
            .filter(|tab| tab.hidden)
            .map(|tab| tab.id.clone())
            .collect::<HashSet<_>>();
        let generation = self
            .presentation
            .existing(window_id)
            .map(|live| live.window_generation)
            .unwrap_or_default();
        let receipt = self.presentation.commit_live_topology(LiveTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
            source: "restore",
            primary_window_id: window_id.to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: foreground_tab_id.clone(),
                hidden_tab_ids,
                tabs: live_tabs,
                ui_sequence: 1,
                window_generation: generation,
                window_id: window_id.to_owned(),
            }],
        })?;
        let revision = receipt.revision;
        // A closed saved window has no live RuntimeKernel record. Rehydrating its
        // topology must restore the persisted identity before native host
        // creation; otherwise the host is treated as transient and terminal
        // geometry receipts cannot update the saved SQLite definition.
        self.set_live_window_persisted_name(window_id, Some(saved.name.to_owned()))?;
        if let Some(trace) = launch_trace.as_ref() {
            self.record_runtime_launch_latency(
                trace,
                "topology-committed",
                "completed",
                window_id,
                foreground_tab_id.as_deref(),
                None,
                None,
                generation,
                None,
                revision,
            );
        }
        {
            let mut state = self.state().map_err(|error| error.message)?;
            if let Some((preview, source_id, tab_type)) = launch_preview.as_ref() {
                if active_provisional_launch(&state, source_id, tab_type).is_some() {
                    return Err("The requested source already has an admitted launch intent."
                        .to_owned());
                }
                insert_provisional_launch(
                    &mut state,
                    ProvisionalLaunch {
                        cancelled: false,
                        failed: false,
                        host_created: false,
                        id: preview.provisional_tab_id.clone(),
                        launch_preview_id: preview.launch_preview_id.clone(),
                        source_id: source_id.clone(),
                        tab_type: tab_type.clone(),
                        window_id: window_id.to_owned(),
                    },
                );
            }
            state.pending_window_tab_restores.insert(
                window_id.to_owned(),
                PendingWindowTabRestore {
                    active_tab_id: foreground_tab_id.clone(),
                    completion_tab_ids: foreground_tab_id.iter().cloned().collect(),
                    host_created: false,
                    ordered_tab_ids: ordered_tab_ids.clone(),
                    reserved_tab_ids,
                    submission_complete: false,
                    successful_tab_ids: existing_tab_ids.clone(),
                    terminal_tab_ids: existing_tab_ids,
                    visibility_fence: foreground_tab_id.clone().map(|foreground_tab_id| {
                        RestoredWindowVisibilityFence {
                            foreground_tab_id,
                            launch_trace: launch_trace.clone(),
                            reveal_dispatched: false,
                            topology_revision: revision,
                            visibility_signal: RestoredVisibilitySignal::new(),
                            window_generation: generation,
                        }
                    }),
                    visible_tab_ids: visible_tab_ids.clone(),
                },
            );
        }
        if let Some(signal) = admission_signal.as_mut() {
            signal.complete();
        }
        // Restore commits the complete desired topology before creating a native window or tab
        // reservation. The host generation is then projected back into the same Kernel aggregate
        // by `ensure_display_host`; failure leaves retryable desired tabs, never native-only truth.
        let (_, host_created) = match self
            .with_native_creation_lane(window_id, || self.ensure_display_host(target, title))
        {
            Ok(result) => result,
            Err(error) => {
                if let Some((preview, _, _)) = launch_preview.as_ref() {
                    self.cancel_tab_launch_preview(&preview.launch_preview_id);
                }
                return Err(error.message);
            }
        };
        let host_generation = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .native_resources
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.generation)
            })
            .unwrap_or_default();
        if let Ok(mut state) = self.state.lock() {
            if let Some(restore) = state.pending_window_tab_restores.get_mut(window_id) {
                restore.host_created = host_created;
                if let Some(fence) = restore.visibility_fence.as_mut() {
                    fence.window_generation = host_generation;
                }
            }
            if let Some((preview, _, _)) = launch_preview.as_ref()
                && let Some(launch) = state.provisional_launches.get_mut(&preview.launch_preview_id)
            {
                launch.host_created = host_created;
            }
        }
        if let Some(trace) = launch_trace.as_ref() {
            self.record_runtime_launch_latency(
                trace,
                "host-created",
                "completed",
                window_id,
                foreground_tab_id.as_deref(),
                None,
                None,
                host_generation,
                None,
                revision,
            );
        }
        self.schedule_live_projection_membership_follow();
        self.seed_dormant_runtime_tabs(window_id, ordered_tab_ids.clone())?;
        for tab in tabs {
            self.presentation
                .statuses
                .set_presentation_phase(&tab.id, TabRuntimePhase::Dormant);
        }
        for tab in tabs.iter().filter(|tab| !tab.hidden) {
            if let Err(error) = self.reserve_native_tab(
                window_id,
                &tab.id,
                &tab.name,
                &tab.tab_type,
                None,
                revision,
            ) {
                self.presentation
                    .statuses
                    .set_presentation_phase(&tab.id, TabRuntimePhase::Failed);
                eprintln!(
                    "Restored tab chrome remains pending while live topology is retained: window={window_id} tab={} error={}",
                    tab.id, error.message
                );
                continue;
            }
            self.mark_restored_native_tab_reserved(window_id, &tab.id);
        }
        if let Some((preview, _, tab_type)) = launch_preview.as_ref() {
            self.presentation.statuses.set_presentation_phase(
                &preview.provisional_tab_id,
                TabRuntimePhase::Reserved,
            );
            if let Err(error) = self.reserve_native_tab(
                window_id,
                &preview.provisional_tab_id,
                "Loading…",
                tab_type,
                None,
                revision,
            ) {
                self.cancel_tab_launch_preview(&preview.launch_preview_id);
                return Err(error.message);
            }
        }
        self.schedule_native_tab_order_projection(window_id.to_owned(), visible_tab_ids);
        self.apply_native_active_style(
            window_id,
            foreground_tab_id.as_deref(),
            revision,
            "saved-window-restore-seeded",
        );
        self.publish_launcher_presence();
        Ok(launch_preview.map(|(preview, _, _)| preview))
    }

    pub fn discard_prepared_restored_window_tabs(&self, window_id: &str) {
        let prepared = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_window_tab_restores.remove(window_id));
        let Some(prepared) = prepared else {
            return;
        };
        let orphaned_tab_ids = self
            .state
            .lock()
            .ok()
            .map(|state| {
                prepared
                    .ordered_tab_ids
                    .iter()
                    .filter(|tab_id| {
                        !state.native_resources.tabs.contains_key(*tab_id)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if orphaned_tab_ids.is_empty() {
            return;
        }
        for tab_id in &orphaned_tab_ids {
            self.presentation
                .statuses
                .set_presentation_phase(tab_id, TabRuntimePhase::Failed);
        }
        // Restore cleanup owns only native resources. The one-pass restored live
        // topology remains intact so failed surfaces can hydrate into placeholders
        // and retry without a visible reorder or tab deletion.
        self.publish_launcher_presence();
    }

    fn pending_window_tab_restore(&self, window_id: &str) -> Option<PendingWindowTabRestore> {
        self.state.lock().ok().and_then(|state| {
            state
                .pending_window_tab_restores
                .get(window_id)
                .cloned()
        })
    }

    fn restored_tab_selection_intent(
        &self,
        window_id: &str,
        tab_id: &str,
        launch_preview: Option<&ProvisionalLaunch>,
    ) -> (Option<PendingWindowTabRestore>, bool) {
        let restore = self.pending_window_tab_restore(window_id);
        let preview_is_selected = launch_preview.is_some_and(|preview| {
            self.presentation
                .existing(window_id)
                .map(|selection| {
                    selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                })
                .unwrap_or(false)
        });
        let should_select = restore.as_ref().map_or_else(
            || {
                launch_preview.is_none_or(|preview| {
                    self.presentation
                        .existing(window_id)
                        .map(|selection| {
                            selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                        })
                        .unwrap_or(true)
                })
            },
            |restore| {
                if preview_is_selected {
                    return true;
                }
                restore
                    .active_tab_id
                    .as_ref()
                    .or_else(|| restore.ordered_tab_ids.first())
                    .is_some_and(|active_tab_id| active_tab_id == tab_id)
            },
        );
        (restore, should_select)
    }

    fn mark_restored_native_tab_reserved(&self, window_id: &str, tab_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(restore) = state.pending_window_tab_restores.get_mut(window_id)
            && restore.ordered_tab_ids.iter().any(|saved| saved == tab_id)
        {
            restore.reserved_tab_ids.insert(tab_id.to_owned());
        }
    }

    pub(crate) fn mark_prepared_restored_window_visible(&self, window_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(fence) = state
                .pending_window_tab_restores
                .get_mut(window_id)
                .and_then(|restore| restore.visibility_fence.as_mut())
        {
            fence.reveal_dispatched = true;
        }
    }

    pub(crate) async fn wait_for_prepared_restored_foreground_visible(
        &self,
        window_id: &str,
    ) -> Result<(), String> {
        let mut visibility = self
            .pending_window_tab_restore(window_id)
            .and_then(|restore| restore.visibility_fence)
            .map(|fence| fence.visibility_signal.subscribe())
            .ok_or_else(|| {
                "The saved-window foreground visibility fence is no longer active.".to_owned()
            })?;
        let operation_id = loop {
            if let Some(operation_id) = visibility.borrow().clone() {
                break operation_id;
            }
            visibility.changed().await.map_err(|_| {
                "The saved-window foreground visibility stream stopped before native terminal."
                    .to_owned()
            })?;
        };
        let operations = Arc::clone(&self.operations);
        let summary = tauri::async_runtime::spawn_blocking(move || {
            operations
                .wait(&operation_id)
                .map(|receipt| receipt.summary())
                .map_err(str::to_owned)
        })
        .await
        .map_err(|error| error.to_string())??;
        if summary.status == SystemRuntimeOperationStatus::Applied {
            Ok(())
        } else {
            Err(format!(
                "The saved-window foreground visibility operation ended as {:?}.",
                summary.status
            ))
        }
    }

    fn mark_restored_tab_creation_terminal(
        &self,
        window_id: &str,
        tab_id: &str,
        succeeded: bool,
    ) {
        if let Ok(mut state) = self.state.lock()
            && let Some(restore) = state.pending_window_tab_restores.get_mut(window_id)
            && restore.completion_tab_ids.contains(tab_id)
        {
            restore.terminal_tab_ids.insert(tab_id.to_owned());
            if succeeded {
                restore.successful_tab_ids.insert(tab_id.to_owned());
            }
        }
    }

    pub(crate) fn fail_prepared_restored_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        failure_code: &str,
    ) {
        self.presentation
            .statuses
            .set_failure(tab_id, failure_code);
        let trace = self.pending_window_tab_restore(window_id).and_then(|restore| {
            restore.visibility_fence.and_then(|fence| {
                fence.launch_trace.map(|trace| {
                    (
                        trace,
                        fence.foreground_tab_id,
                        fence.window_generation,
                        fence.topology_revision,
                    )
                })
            })
        });
        if let Some((trace, foreground_tab_id, window_generation, topology_revision)) = trace {
            self.record_runtime_launch_latency(
                &trace,
                "follower-admission-failed",
                "failed",
                window_id,
                Some(tab_id),
                None,
                None,
                window_generation,
                None,
                topology_revision,
            );
            if foreground_tab_id == tab_id {
                return;
            }
        }
        self.mark_restored_tab_creation_terminal(window_id, tab_id, false);
        let _ = self.reconcile_prepared_restored_window_tabs(window_id);
    }

    #[allow(clippy::too_many_arguments)]
    fn take_restored_foreground_visibility_fence(
        &self,
        window_id: &str,
        tab_id: &str,
        operation_id: &str,
        attempt_id: &str,
        window_generation: u64,
        surface_generation: u64,
    ) -> Option<RestoredWindowVisibilityFence> {
        let live = self.presentation.existing(window_id)?;
        let mut state = self.state.lock().ok()?;
        let host_current = state
            .native_resources
            .display_hosts
            .get(window_id)
            .is_some_and(|host| host.generation == window_generation);
        let tab_current = state.native_resources.tabs.contains_key(tab_id)
            && !state.tab_close_pending(tab_id)
            && !state.close_coordinator.closing_tabs.contains(tab_id);
        let restore = state.pending_window_tab_restores.get_mut(window_id)?;
        let fence = restore.visibility_fence.as_mut()?;
        if fence.foreground_tab_id != tab_id {
            return None;
        }
        let eligible = restored_foreground_visibility_is_current(
            fence,
            tab_id,
            window_generation,
            RestoredForegroundVisibilitySnapshot {
                host_current,
                live_contains_tab: live.contains_tab(tab_id),
                live_revision: live.revision,
                live_selected_tab_id: live.selected_tab_id.as_deref(),
                live_window_generation: live.window_generation,
                tab_current,
            },
        );
        if !eligible {
            let trace = fence.launch_trace.clone();
            drop(state);
            if let Some(trace) = trace.as_ref() {
                self.record_runtime_launch_latency(
                    trace,
                    "foreground-surfaces-attached",
                    "superseded",
                    window_id,
                    Some(tab_id),
                    Some(operation_id),
                    Some(attempt_id),
                    window_generation,
                    Some(surface_generation),
                    live.revision,
                );
            }
            return None;
        }
        fence.reveal_dispatched = true;
        Some(fence.clone())
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_restored_tab_creation(
        &self,
        window_id: &str,
        tab_id: &str,
        operation_id: &str,
        attempt_id: &str,
        window_generation: u64,
        surface_generation: u64,
        succeeded: bool,
    ) {
        let visibility_fence = succeeded.then(|| {
            self.take_restored_foreground_visibility_fence(
                window_id,
                tab_id,
                operation_id,
                attempt_id,
                window_generation,
                surface_generation,
            )
        }).flatten();
        if let Some(fence) = visibility_fence {
            if let Some(trace) = fence.launch_trace.as_ref() {
                self.record_runtime_launch_latency(
                    trace,
                    "foreground-surfaces-attached",
                    "completed",
                    window_id,
                    Some(tab_id),
                    Some(operation_id),
                    Some(attempt_id),
                    window_generation,
                    Some(surface_generation),
                    fence.topology_revision,
                );
            }
            match self.reveal_live_runtime_window(
                window_id,
                "saved-window-foreground-surfaces-attached",
                fence.launch_trace.clone(),
            ) {
                Ok(Some(visibility_operation_id)) => {
                    fence.visibility_signal.submit(&visibility_operation_id);
                    if let Some(trace) = fence.launch_trace.as_ref() {
                        self.record_runtime_launch_latency(
                            trace,
                            "first-visible-requested",
                            "submitted",
                            window_id,
                            Some(tab_id),
                            Some(operation_id),
                            Some(attempt_id),
                            window_generation,
                            Some(surface_generation),
                            fence.topology_revision,
                        );
                    }
                }
                Ok(None) | Err(_) => {
                    if let Ok(mut state) = self.state.lock()
                        && let Some(current) = state
                            .pending_window_tab_restores
                            .get_mut(window_id)
                            .and_then(|restore| restore.visibility_fence.as_mut())
                        && current == &fence
                    {
                        current.reveal_dispatched = false;
                    }
                }
            }
        }
        self.mark_restored_tab_creation_terminal(window_id, tab_id, succeeded);
        if let Err(error) = self.reconcile_prepared_restored_window_tabs(window_id) {
            eprintln!(
                "Saved Game Window tab order could not be finalized after native creation: window={window_id} tab={tab_id} error={}",
                error.message
            );
        }
    }

    pub fn finish_prepared_restored_window_tabs(&self, window_id: &str) -> Result<(), String> {
        if let Ok(mut state) = self.state.lock()
            && let Some(restore) = state.pending_window_tab_restores.get_mut(window_id)
        {
            restore.submission_complete = true;
        }
        self.reconcile_prepared_restored_window_tabs(window_id)
            .map_err(|error| error.message)
    }

    fn reconcile_prepared_restored_window_tabs(&self, window_id: &str) -> RuntimeResult<()> {
        let Some(prepared) = self.pending_window_tab_restore(window_id) else {
            return Ok(());
        };
        let Some(coordinator) = self.presentation.existing(window_id) else {
            return Ok(());
        };
        let (topology_ready, all_terminal, all_successful) = {
            let live_ready = prepared
                .ordered_tab_ids
                .iter()
                .all(|tab_id| coordinator.contains_tab(tab_id));
            // Create effects are accepted concurrently during restore. A Live tab can exist
            // before its AppKit/WebView2 chrome reservation has reached the native queue. Do
            // not consume the saved ordering fence until every expected reservation is queued,
            // otherwise the last concurrent create can append itself after the final reorder.
            let topology_ready = live_ready
                && prepared
                    .ordered_tab_ids
                    .iter()
                    .all(|tab_id| prepared.reserved_tab_ids.contains(tab_id));
            let all_terminal = prepared
                .completion_tab_ids
                .iter()
                .all(|tab_id| prepared.terminal_tab_ids.contains(tab_id));
            let all_successful = all_terminal
                && prepared
                    .completion_tab_ids
                    .iter()
                    .all(|tab_id| prepared.successful_tab_ids.contains(tab_id));
            (topology_ready, all_terminal, all_successful)
        };
        let retired = prepared.submission_complete
            && all_terminal
            && (!all_successful || topology_ready)
            && self.state.lock().is_ok_and(|mut state| {
                if state.pending_window_tab_restores.get(window_id) != Some(&prepared) {
                    return false;
                }
                state.pending_window_tab_restores.remove(window_id);
                true
            });
        if retired && all_successful {
            self.schedule_live_window_state_persistence(window_id);
        }
        if retired
            && let Some(fence) = prepared.visibility_fence.as_ref()
            && let Some(trace) = fence.launch_trace.as_ref()
        {
            let status = if all_successful { "completed" } else { "degraded" };
            self.record_runtime_launch_latency(
                trace,
                "followers-terminal",
                status,
                window_id,
                Some(&fence.foreground_tab_id),
                None,
                None,
                fence.window_generation,
                None,
                fence.topology_revision,
            );
            self.record_runtime_launch_latency(
                trace,
                "intent-terminal",
                status,
                window_id,
                Some(&fence.foreground_tab_id),
                None,
                None,
                fence.window_generation,
                None,
                fence.topology_revision,
            );
        }
        Ok(())
    }
}
