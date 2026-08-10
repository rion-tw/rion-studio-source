impl SystemRuntimeExecutor {
    fn with_native_window_lifecycle_lane<T>(
        &self,
        window_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let lane = {
            let mut lanes = self.native_creation_lanes.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                    "The native surface lifecycle coordinator is unavailable.",
                )
            })?;
            Arc::clone(
                lanes
                    .entry(window_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = lane.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                "The native surface lifecycle lane is unavailable.",
            )
        })?;
        operation()
    }

    fn with_native_creation_lane<T>(
        &self,
        window_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        self.require_runtime_accepting()?;
        let _global_permit = self.native_creation_slots.acquire()?;
        self.with_native_window_lifecycle_lane(window_id, || {
            self.require_runtime_accepting()?;
            operation()
        })
    }

    pub(crate) fn preview_tab_launch_for_intent(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        source_id: &str,
        tab_type: &str,
        admission_signal: &mut crate::runtime_tab_menu::LaunchAdmissionSignal,
    ) -> RuntimeResult<LaunchPreviewHandle> {
        let mut admission_signal = Some(admission_signal);
        let preview_started = Instant::now();
        self.mark_critical_activity();
        let existing = {
            let state = self.state()?;
            active_provisional_launch(&state, source_id, tab_type).map(launch_preview_handle)
        };
        if let Some(existing) = existing {
            if let Some(signal) = admission_signal.as_mut() {
                signal.complete();
            }
            return Ok(existing);
        }
        if self.current_window_close_in_progress(&target.window_id) {
            let _cleanup_operation_id = self
                .wait_for_window_close_before_reopen(&target.window_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_WINDOW_CLOSING", message)
                })?;
        }
        let preview = allocate_launch_preview_handle(source_id, tab_type);
        let provisional_id = preview.provisional_tab_id.clone();
        let launch_preview_id = preview.launch_preview_id.clone();
        let placeholder_name = self
            .language
            .lock()
            .ok()
            .map(|language| match language.as_str() {
                "zh-TW" => "載入中…",
                "zh-CN" => "加载中…",
                "ja" => "読み込み中…",
                _ => "Loading…",
            })
            .unwrap_or("Loading…");
        let duplicate = {
            let mut state = self.state()?;
            if let Some(existing) = active_provisional_launch(&state, source_id, tab_type) {
                Some(launch_preview_handle(existing))
            } else {
                insert_provisional_launch(
                    &mut state,
                    ProvisionalLaunch {
                        cancelled: false,
                        failed: false,
                        host_created: false,
                        id: provisional_id.clone(),
                        launch_preview_id: launch_preview_id.clone(),
                        source_id: source_id.to_owned(),
                        tab_type: tab_type.to_owned(),
                        window_id: target.window_id.clone(),
                    },
                );
                None
            }
        };
        if let Some(existing) = duplicate {
            if let Some(signal) = admission_signal.as_mut() {
                signal.complete();
            }
            return Ok(existing);
        }
        // Clone the live record and release its window mutex before committing.
        // `commit_live_window_record` reacquires the same coordinator through the
        // store's atomic commit lane; retaining the guard here would deadlock the
        // AppKit menu callback against itself.
        let mut selection = match self.presentation.snapshot_live_window(&target.window_id) {
            Ok(selection) => selection,
            Err(_) => {
                self.cancel_tab_launch_preview(&launch_preview_id);
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                ));
            }
        };
        let previous_tab_id = selection.selected_tab_id.clone();
        let previous_surfaces = self
            .presentation
            .surfaces(&target.window_id, previous_tab_id.as_deref());
        selection.insert_tab(
            LiveTabRecord {
                audio_muted: false,
                closable: true,
                icon_data_url: None,
                id: provisional_id.clone(),
                persistable: false,
                role_ids: if tab_type == "role" {
                    vec![source_id.to_owned()]
                } else {
                    Vec::new()
                },
                role_slots: Vec::new(),
                source_id: source_id.to_owned(),
                tab_type: tab_type.to_owned(),
                title: placeholder_name.to_owned(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: None,
            },
            0,
            true,
        );
        let receipt = self
            .presentation
            .commit_live_window_record("command", &target.window_id, &selection)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        self.presentation
            .statuses
            .set_presentation_phase(&provisional_id, TabRuntimePhase::Reserved);
        let revision = receipt.revision;
        if let Some(signal) = admission_signal.as_mut() {
            signal.complete();
        }
        self.publish_launcher_presence();
        // Desired topology and the permanent TabId are authoritative before any native host or
        // tab-chrome resource exists. Native creation is a one-way projection of this committed
        // revision and may never be used to discover whether the launch logically exists.
        let (window, host_created) = match self
            .with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(target, "Rion Studio")
            }) {
            Ok(result) => result,
            Err(error) => {
                self.cancel_tab_launch_preview(&launch_preview_id);
                return Err(error);
            }
        };
        let launch_still_current = self.state.lock().ok().is_some_and(|mut state| {
            state
                .provisional_launches
                .get_mut(&launch_preview_id)
                .filter(|launch| {
                    !launch.cancelled
                        && launch.id == provisional_id
                        && launch.window_id == target.window_id
                })
                .is_some_and(|launch| {
                    launch.host_created = host_created;
                    true
                })
        });
        if !launch_still_current {
            self.remove_empty_display_host(&target.window_id, host_created);
            return Err(RuntimeError::new(
                "LAUNCH_CANCELLED",
                "The runtime tab closed before native host projection began.",
            ));
        }
        if let Err(error) = self.reserve_native_tab(
            &target.window_id,
            &provisional_id,
            placeholder_name,
            tab_type,
            None,
            revision,
        ) {
            self.cancel_tab_launch_preview(&launch_preview_id);
            return Err(error);
        }
        // Both native reserve implementations activate the inserted item in the
        // same UI callback. Scheduling a second active-style callback only adds
        // event-loop work during a rapid launch burst.
        self.dispatch_native_presentation(
            target.window_id.clone(),
            Some(provisional_id.clone()),
            revision,
            "launch-preview",
            Instant::now(),
            window,
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            Some(true),
            NativePresentationFocus::WindowAndContent,
            None,
            None,
        );
        self.record_launch_presentation_event_with_error_diagnostic(
            LogLevel::Debug,
            "tab.launch-preview-committed",
            "The launcher action committed its provisional presentation.",
            &target.window_id,
            self.state
                .lock()
                .ok()
                .and_then(|state| {
                    state
                        .provisional_launches
                        .get(&launch_preview_id)
                        .map(|launch| launch.id.clone())
                })
                .as_deref(),
            revision,
            "launch-preview",
            preview_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Some(&launch_preview_id),
            None,
            None,
        );
        Ok(preview)
    }

    pub(crate) fn cancel_tab_launch_preview(&self, launch_preview_id: &str) {
        let provisional = self.state.lock().ok().and_then(|mut state| {
            state.automatic_launch_retries.remove(launch_preview_id);
            let provisional = state.provisional_launches.remove(launch_preview_id)?;
            let source_key = launch_source_key(&provisional.tab_type, &provisional.source_id);
            clear_active_provisional_launch(&mut state, &source_key, launch_preview_id);
            Some(provisional)
        });
        let Some(provisional) = provisional else {
            return;
        };
        let next_tab_id = self
            .presentation
            .commit_live_tab_removal("command", &provisional.window_id, &provisional.id)
            .ok()
            .and_then(|(next_tab_id, _)| next_tab_id);
        self.publish_launcher_presence();
        self.remove_native_tab_reservation(
            &provisional.window_id,
            &provisional.id,
            next_tab_id.as_deref(),
        );
        if let Some(tab_id) = next_tab_id {
            let _ = self.request_tab_presentation(
                &tab_id,
                NativePresentationFocus::None,
                "launch-preview-cancelled",
            );
        }
        self.remove_empty_display_host(&provisional.window_id, provisional.host_created);
    }

    pub(crate) fn fail_tab_launch_preview(&self, launch_preview_id: &str) {
        let provisional = self.state.lock().ok().and_then(|mut state| {
            let provisional = state.provisional_launches.get_mut(launch_preview_id)?;
            provisional.failed = true;
            Some(provisional.clone())
        });
        let Some(provisional) = provisional else {
            return;
        };
        self.presentation
            .statuses
            .set_presentation_phase(&provisional.id, TabRuntimePhase::Failed);
    }

    pub(crate) fn resolve_browser_launch_completion(
        self: &Arc<Self>,
        completion: BrowserLaunchCompletionRecord,
    ) -> bool {
        let launch_preview_id = completion.launch_preview_id.as_deref();
        let (diagnostic, completed_retries, release_verified) = self
            .state
            .lock()
            .ok()
            .map(|mut state| {
                (
                    state.failed_launch_diagnostics.remove(&completion.tab_id),
                    launch_preview_id
                        .and_then(|launch_preview_id| {
                            state
                                .automatic_launch_retries
                                .get(launch_preview_id)
                                .copied()
                        })
                        .unwrap_or_default(),
                    state.retryable_failed_launches.remove(&completion.tab_id),
                )
            })
            .unwrap_or_default();
        let cancellation = completion
            .error
            .as_ref()
            .is_some_and(|error| error.code == "LAUNCH_CANCELLED");
        let stale_preview = completion
            .error
            .as_ref()
            .is_some_and(|error| error.code == "LAUNCH_PREVIEW_STALE");
        self.record_launch_presentation_event_with_error_diagnostic(
            if cancellation {
                LogLevel::Debug
            } else if completion.error.is_some() {
                LogLevel::Error
            } else {
                LogLevel::Info
            },
            if cancellation {
                "tab.launch-cancelled-settled"
            } else if stale_preview {
                "tab.launch-preview-stale"
            } else {
                "tab.launch-settled"
            },
            if cancellation {
                "The cancelled launch attempt settled without attaching a native tab."
            } else if stale_preview {
                "A launch effect was rejected because its provisional identity was stale."
            } else if completion.error.is_some() {
                "The accepted background launch settled with an error."
            } else {
                "The accepted background launch settled successfully."
            },
            &completion.window_id,
            Some(&completion.tab_id),
            self.presentation.current_revision(),
            "launch-completion",
            completion
                .accepted_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            launch_preview_id,
            completion.error.as_ref(),
            diagnostic.clone(),
        );
        if cancellation || stale_preview {
            return false;
        }
        let Some(error) = completion.error.as_ref() else {
            if completed_retries > 0 {
                if let Some(launch_preview_id) = launch_preview_id
                    && let Ok(mut state) = self.state.lock()
                {
                    state.automatic_launch_retries.remove(launch_preview_id);
                }
                self.record_presentation_event(
                    LogLevel::Info,
                    "tab.launch-auto-retry-recovered",
                    "The Windows System WebView launch recovered on its automatic retry.",
                    &completion.window_id,
                    Some(&completion.tab_id),
                    self.presentation.current_revision(),
                    "launch-auto-retry",
                    0,
                );
            }
            return false;
        };
        let retry = automatic_role_setup_retry_allowed(
            current_runtime_platform(),
            completed_retries,
            &error.code,
            release_verified,
        );
        let retained_preview = self.retain_launch_completion_presentation(&completion, !retry);
        if retry {
            let Some(retained_preview) = retained_preview else {
                return true;
            };
            if let Ok(mut state) = self.state.lock() {
                state
                    .automatic_launch_retries
                    .insert(retained_preview.launch_preview_id.clone(), 1);
            }
            self.record_presentation_event_with_error_diagnostic(
                LogLevel::Warn,
                "tab.launch-auto-retry-scheduled",
                "The transient Windows System WebView setup failure will be retried once.",
                &completion.window_id,
                Some(&completion.tab_id),
                self.presentation.current_revision(),
                "launch-auto-retry",
                WINDOWS_ROLE_SETUP_RETRY_DELAY.as_millis() as u64,
                Some(error),
                diagnostic,
            );
            self.schedule_automatic_launch_retry(retained_preview.launch_preview_id, completion);
            return false;
        }
        if let Some(launch_preview_id) = launch_preview_id
            && let Ok(mut state) = self.state.lock()
        {
            state.automatic_launch_retries.remove(launch_preview_id);
        }
        if completed_retries > 0 {
            self.record_presentation_event_with_error_diagnostic(
                LogLevel::Error,
                "tab.launch-auto-retry-exhausted",
                "The Windows System WebView launch failed again after its automatic retry.",
                &completion.window_id,
                Some(&completion.tab_id),
                self.presentation.current_revision(),
                "launch-auto-retry",
                0,
                Some(error),
                diagnostic.clone(),
            );
        }
        if retained_preview.is_some() {
            self.record_presentation_event_with_error_diagnostic(
                LogLevel::Error,
                "tab.launch-failed-retained",
                "The background launch failed and its presentation tab was retained.",
                &completion.window_id,
                Some(&completion.tab_id),
                self.presentation.current_revision(),
                "launch-completion",
                0,
                Some(error),
                diagnostic,
            );
        }
        true
    }

    fn retain_launch_completion_presentation(
        &self,
        completion: &BrowserLaunchCompletionRecord,
        failed: bool,
    ) -> Option<LaunchPreviewHandle> {
        let existing = self.state.lock().ok().and_then(|mut state| {
            settle_provisional_launch_completion(
                &mut state,
                completion.launch_preview_id.as_deref(),
                failed,
            )
        });
        if let Some((handle, provisional, phase)) = existing {
            self.presentation.statuses.set_presentation_phase(
                &provisional.id,
                phase,
            );
            return Some(handle);
        }
        if completion.launch_preview_id.is_some() {
            return None;
        }
        let source_is_busy = self.state.lock().ok().is_some_and(|state| {
            active_provisional_launch(&state, &completion.source_id, &completion.tab_type).is_some()
        });
        if source_is_busy {
            return None;
        }
        let phase = launch_completion_phase(failed);
        let mut presentation = self
            .presentation
            .snapshot_live_window(&completion.window_id)
            .ok()?;
        if !presentation
            .tabs
            .iter()
            .any(|tab| tab.id == completion.tab_id)
        {
            let should_select = presentation.selected_tab_id.is_none();
            presentation.insert_tab(
                LiveTabRecord {
                    audio_muted: false,
                    closable: true,
                    icon_data_url: None,
                    id: completion.tab_id.clone(),
                    persistable: false,
                    role_ids: if completion.tab_type == "role" {
                        vec![completion.source_id.clone()]
                    } else {
                        Vec::new()
                    },
                    role_slots: Vec::new(),
                    source_id: completion.source_id.clone(),
                    tab_type: completion.tab_type.clone(),
                    title: completion.title.clone(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: None,
                },
                0,
                should_select,
            );
        }
        let receipt = self
            .presentation
            .commit_live_window_record("command", &completion.window_id, &presentation)
            .ok()?;
        self.presentation
            .statuses
            .set_presentation_phase(&completion.tab_id, phase);
        let active_tab_id = presentation.selected_tab_id.clone();
        let revision = receipt.revision;
        let launch_preview_id = uuid::Uuid::new_v4().to_string();
        let provisional = ProvisionalLaunch {
            cancelled: false,
            failed,
            host_created: false,
            id: completion.tab_id.clone(),
            launch_preview_id: launch_preview_id.clone(),
            source_id: completion.source_id.clone(),
            tab_type: completion.tab_type.clone(),
            window_id: completion.window_id.clone(),
        };
        let handle = launch_preview_handle(&provisional);
        if let Ok(mut state) = self.state.lock() {
            insert_provisional_launch(&mut state, provisional);
        } else {
            return None;
        }
        self.publish_launcher_presence();
        let host_created = match self.ensure_display_host(&completion.target, &completion.title) {
            Ok((_, created)) => created,
            Err(host_error) => {
                eprintln!(
                    "Failed launch tab retained its desired state without a native host: {}",
                    host_error.message
                );
                return Some(handle);
            }
        };
        if let Ok(mut state) = self.state.lock()
            && let Some(launch) = state.provisional_launches.get_mut(&launch_preview_id)
        {
            launch.host_created = host_created;
        }
        let native_reservation = self.reserve_native_tab(
            &completion.window_id,
            &completion.tab_id,
            &completion.title,
            &completion.tab_type,
            None,
            revision,
        );
        if native_reservation.is_ok() {
            self.apply_native_active_style(
                &completion.window_id,
                active_tab_id.as_deref(),
                revision,
                "launch-completion-failed",
            );
        }
        Some(handle)
    }

    fn schedule_automatic_launch_retry(
        self: &Arc<Self>,
        launch_preview_id: String,
        completion: BrowserLaunchCompletionRecord,
    ) {
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WINDOWS_ROLE_SETUP_RETRY_DELAY).await;
            let retry_is_current = runtime
                .state
                .lock()
                .ok()
                .is_some_and(|state| {
                    automatic_launch_retry_is_current(&state, &launch_preview_id)
                });
            if !retry_is_current {
                return;
            }
            let Some(retry_preview) = runtime.state.lock().ok().and_then(|mut state| {
                let retry_preview =
                    renew_provisional_launch(&mut state, &launch_preview_id, false)?;
                state
                    .automatic_launch_retries
                    .insert(retry_preview.launch_preview_id.clone(), 1);
                Some(retry_preview)
            }) else {
                return;
            };
            let command = if completion.tab_type == "workspace" {
                CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id: completion.source_id.clone(),
                    target: completion.target.clone(),
                    launch_preview_id: Some(retry_preview.launch_preview_id.clone()),
                    launch_tab_id: Some(retry_preview.provisional_tab_id.clone()),
                    restore_role_slots: None,
                }
            } else {
                CoreCommand::BrowserRoleLaunch {
                    role_id: completion.source_id.clone(),
                    target: completion.target.clone(),
                    launch_preview_id: Some(retry_preview.launch_preview_id.clone()),
                    launch_tab_id: Some(retry_preview.provisional_tab_id.clone()),
                    zoom_factor: completion.zoom_factor,
                    restore_role_slots: None,
                }
            };
            if let Err(error) = Arc::clone(&runtime.core).invoke_async(command).await {
                let error = error.payload();
                if let Ok(mut state) = runtime.state.lock() {
                    state
                        .automatic_launch_retries
                        .remove(&retry_preview.launch_preview_id);
                }
                runtime.fail_tab_launch_preview(&retry_preview.launch_preview_id);
                runtime.record_presentation_event_with_error(
                    LogLevel::Error,
                    "tab.launch-auto-retry-exhausted",
                    "The automatic Windows System WebView retry could not be accepted.",
                    &completion.window_id,
                    Some(&completion.tab_id),
                    runtime.presentation.current_revision(),
                    "launch-auto-retry",
                    0,
                    Some(&error),
                );
                runtime.record_presentation_event_with_error(
                    LogLevel::Error,
                    "tab.launch-failed-retained",
                    "The automatic retry was rejected and its presentation tab was retained.",
                    &completion.window_id,
                    Some(&completion.tab_id),
                    runtime.presentation.current_revision(),
                    "launch-auto-retry",
                    0,
                    Some(&error),
                );
                crate::reveal_shell_error(&runtime.app, error);
            }
        });
    }

    pub(crate) fn cancel_provisional_tab_launch(&self, tab_id: &str) -> bool {
        self.cancel_provisional_tab_launch_with_presentation(tab_id, true)
    }

    fn cancel_provisional_tab_launch_with_presentation(
        &self,
        tab_id: &str,
        present_successor: bool,
    ) -> bool {
        let provisional = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| cancel_provisional_launch_state(&mut state, tab_id));
        let Some(provisional) = provisional else {
            return false;
        };
        if let Ok(mut state) = self.state.lock() {
            state
                .completed_failed_launch_cleanups
                .retain(|(tab_id, _)| tab_id != &provisional.id);
            state.retryable_failed_launches.remove(&provisional.id);
            state.launch_attempt_generations.remove(&provisional.id);
        }
        let next_tab_id = self
            .presentation
            .commit_live_tab_removal("command", &provisional.window_id, &provisional.id)
            .ok()
            .and_then(|(next_tab_id, _)| next_tab_id);
        self.publish_launcher_presence();
        self.remove_native_tab_reservation(
            &provisional.window_id,
            &provisional.id,
            next_tab_id.as_deref(),
        );
        if present_successor
            && let Some(tab_id) = next_tab_id
        {
            let _ = self.request_tab_presentation(
                tab_id.as_str(),
                NativePresentationFocus::None,
                "launch-preview-closed",
            );
        }
        self.record_launch_presentation_event_with_error_diagnostic(
            LogLevel::Debug,
            "tab.launch-preview-cancelled",
            "The provisional launch was cancelled and fenced from future native attachment.",
            &provisional.window_id,
            Some(&provisional.id),
            self.presentation.current_revision(),
            "launch-preview-close",
            0,
            Some(&provisional.launch_preview_id),
            None,
            None,
        );
        true
    }

    fn take_tab_launch_preview(
        &self,
        launch_preview_id: Option<&str>,
        tab_id: &str,
        window_id: &str,
        source_id: &str,
        tab_type: &str,
    ) -> RuntimeResult<Option<ProvisionalLaunch>> {
        let Some(launch_preview_id) = launch_preview_id else {
            return Ok(None);
        };
        let mut state = self.state()?;
        take_provisional_launch_attempt(
            &mut state,
            launch_preview_id,
            tab_id,
            window_id,
            source_id,
            tab_type,
        )
        .map(Some)
    }

}
