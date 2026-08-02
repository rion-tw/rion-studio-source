impl SystemRuntimeExecutor {
    fn with_native_creation_lane<T>(
        &self,
        window_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let _global_permit = self.native_creation_slots.acquire()?;
        let lane = {
            let mut lanes = self.native_creation_lanes.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                    "The native surface creation coordinator is unavailable.",
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
                "The native surface creation lane is unavailable.",
            )
        })?;
        operation()
    }

    pub(crate) fn preview_tab_launch(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        source_id: &str,
        tab_type: &str,
    ) -> RuntimeResult<String> {
        let preview_started = Instant::now();
        self.mark_critical_activity();
        let key = format!("{tab_type}:{source_id}");
        if self.state()?.provisional_launches.contains_key(&key) {
            return Ok(key);
        }
        // An existing game window already owns a fully initialized native tab controller.
        // Reserving another tab must not wait behind an in-flight WKWebView/WebView2 creation:
        // that worker may itself be waiting for the UI thread to attach its controller.
        let existing_window = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.window.clone());
        let (window, host_created) = if let Some(window) = existing_window {
            (window, false)
        } else {
            self.with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(target, "Rion Studio")
            })?
        };
        let provisional_id = format!("provisional-{}", uuid::Uuid::new_v4());
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
        let revision = self.presentation.next_revision();
        {
            let mut state = self.state()?;
            state.provisional_launches.insert(
                key.clone(),
                ProvisionalLaunch {
                    cancelled: false,
                    failed: false,
                    host_created,
                    id: provisional_id.clone(),
                    source_id: source_id.to_owned(),
                    tab_type: tab_type.to_owned(),
                    window_id: target.window_id.clone(),
                },
            );
        }
        let presentation = self
            .presentation
            .coordinator(&target.window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (previous_tab_id, previous_surfaces) = {
            let mut selection = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let previous_tab_id = selection.selected_tab_id.clone();
            let previous_surfaces = selection.surfaces(previous_tab_id.as_deref());
            selection.insert_tab(
                TabPresentation {
                    closable: true,
                    icon_data_url: None,
                    id: provisional_id.clone(),
                    phase: TabPresentationPhase::Reserved,
                    role_ids: if tab_type == "role" {
                        vec![source_id.to_owned()]
                    } else {
                        Vec::new()
                    },
                    source_id: source_id.to_owned(),
                    tab_type: tab_type.to_owned(),
                    title: placeholder_name.to_owned(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: None,
                },
                revision,
                true,
            );
            (previous_tab_id, previous_surfaces)
        };
        self.publish_launcher_presence();
        if let Err(error) = self.reserve_native_tab(
            &target.window_id,
            &provisional_id,
            placeholder_name,
            tab_type,
            None,
            revision,
        ) {
            self.cancel_tab_launch_preview(&key);
            return Err(error);
        }
        // Both native reserve implementations activate the inserted item in the
        // same UI callback. Scheduling a second active-style callback only adds
        // event-loop work during a rapid launch burst.
        self.dispatch_native_presentation(
            target.window_id.clone(),
            Some(provisional_id),
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
        );
        self.record_presentation_event(
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
                        .get(&key)
                        .map(|launch| launch.id.clone())
                })
                .as_deref(),
            revision,
            "launch-preview",
            preview_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        Ok(key)
    }

    pub(crate) fn cancel_tab_launch_preview(&self, key: &str) {
        let provisional = self.state.lock().ok().and_then(|mut state| {
            state.automatic_launch_retries.remove(key);
            state.provisional_launches.remove(key)
        });
        let Some(provisional) = provisional else {
            return;
        };
        let mut next_tab_id = None;
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut selection) = presentation.lock()
        {
            let was_selected =
                selection.selected_tab_id.as_deref() == Some(provisional.id.as_str());
            let revision = self.presentation.next_revision();
            selection.remove_tab(&provisional.id, revision);
            if was_selected {
                next_tab_id = selection.tabs.last().map(|tab| tab.id.clone());
                selection.select(next_tab_id.clone(), revision);
            }
        }
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

    pub(crate) fn fail_tab_launch_preview(&self, key: &str) {
        let provisional = self.state.lock().ok().and_then(|mut state| {
            let provisional = state.provisional_launches.get_mut(key)?;
            provisional.failed = true;
            Some(provisional.clone())
        });
        let Some(provisional) = provisional else {
            return;
        };
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut presentation) = presentation.lock()
        {
            presentation.update_phase(&provisional.id, TabPresentationPhase::Failed);
        }
    }

    pub(crate) fn retry_failed_tab_launch(
        &self,
        source_id: &str,
        tab_type: &str,
    ) -> Option<String> {
        let key = format!("{tab_type}:{source_id}");
        let provisional = self.state.lock().ok().and_then(|mut state| {
            let provisional = state.provisional_launches.get_mut(&key)?;
            if !provisional.failed || provisional.cancelled {
                return None;
            }
            provisional.failed = false;
            Some(provisional.clone())
        })?;
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut presentation) = presentation.lock()
        {
            presentation.update_phase(&provisional.id, TabPresentationPhase::Reserved);
        }
        Some(key)
    }

    pub(crate) fn resolve_browser_launch_completion(
        self: &Arc<Self>,
        completion: BrowserLaunchCompletionRecord,
    ) -> bool {
        let key = format!("{}:{}", completion.tab_type, completion.source_id);
        let (diagnostic, completed_retries, release_verified) = self
            .state
            .lock()
            .ok()
            .map(|mut state| {
                (
                    state.failed_launch_diagnostics.remove(&completion.tab_id),
                    state
                        .automatic_launch_retries
                        .get(&key)
                        .copied()
                        .unwrap_or_default(),
                    state.retryable_failed_launches.remove(&completion.tab_id),
                )
            })
            .unwrap_or_default();
        self.record_presentation_event_with_error_diagnostic(
            if completion.error.is_some() {
                LogLevel::Error
            } else {
                LogLevel::Info
            },
            "tab.launch-settled",
            if completion.error.is_some() {
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
            completion.error.as_ref(),
            diagnostic.clone(),
        );
        let Some(error) = completion.error.as_ref() else {
            if completed_retries > 0 {
                if let Ok(mut state) = self.state.lock() {
                    state.automatic_launch_retries.remove(&key);
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
        if retry && let Ok(mut state) = self.state.lock() {
            state.automatic_launch_retries.insert(key.clone(), 1);
        }
        self.retain_launch_completion_presentation(&completion, !retry);
        if retry {
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
            self.schedule_automatic_launch_retry(key, completion);
            return false;
        }
        if let Ok(mut state) = self.state.lock() {
            state.automatic_launch_retries.remove(&key);
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
        true
    }

    fn retain_launch_completion_presentation(
        &self,
        completion: &BrowserLaunchCompletionRecord,
        failed: bool,
    ) {
        let key = format!("{}:{}", completion.tab_type, completion.source_id);
        let existing = self.state.lock().ok().and_then(|mut state| {
            let provisional = state.provisional_launches.get_mut(&key)?;
            provisional.failed = failed;
            Some(provisional.clone())
        });
        if let Some(provisional) = existing {
            if let Some(presentation) = self.presentation.existing(&provisional.window_id)
                && let Ok(mut presentation) = presentation.lock()
            {
                presentation.update_phase(
                    &provisional.id,
                    if failed {
                        TabPresentationPhase::Failed
                    } else {
                        TabPresentationPhase::Reserved
                    },
                );
            }
            return;
        }
        let host_created = match self.ensure_display_host(&completion.target, &completion.title) {
            Ok((_, created)) => created,
            Err(host_error) => {
                eprintln!(
                    "Failed launch tab could not retain its native host: {}",
                    host_error.message
                );
                return;
            }
        };
        let revision = self.presentation.next_revision();
        let presentation = match self.presentation.coordinator(&completion.window_id) {
            Ok(presentation) => presentation,
            Err(message) => {
                eprintln!("Failed launch tab presentation could not be retained: {message}");
                return;
            }
        };
        let phase = if failed {
            TabPresentationPhase::Failed
        } else {
            TabPresentationPhase::Reserved
        };
        let active_tab_id = match presentation.lock() {
            Ok(mut presentation) => {
                if presentation
                    .tabs
                    .iter()
                    .any(|tab| tab.id == completion.tab_id)
                {
                    presentation.update_phase(&completion.tab_id, phase);
                } else {
                    let should_select = presentation.selected_tab_id.is_none();
                    presentation.insert_tab(
                        TabPresentation {
                            closable: true,
                            icon_data_url: None,
                            id: completion.tab_id.clone(),
                            phase,
                            role_ids: if completion.tab_type == "role" {
                                vec![completion.source_id.clone()]
                            } else {
                                Vec::new()
                            },
                            source_id: completion.source_id.clone(),
                            tab_type: completion.tab_type.clone(),
                            title: completion.title.clone(),
                            #[cfg(any(windows, target_os = "macos"))]
                            workspace_template: None,
                        },
                        revision,
                        should_select,
                    );
                }
                presentation.selected_tab_id.clone()
            }
            Err(_) => return,
        };
        if let Ok(mut state) = self.state.lock() {
            state.provisional_launches.insert(
                key,
                ProvisionalLaunch {
                    cancelled: false,
                    failed,
                    host_created,
                    id: completion.tab_id.clone(),
                    source_id: completion.source_id.clone(),
                    tab_type: completion.tab_type.clone(),
                    window_id: completion.window_id.clone(),
                },
            );
        }
        self.publish_launcher_presence();
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
    }

    fn schedule_automatic_launch_retry(
        self: &Arc<Self>,
        key: String,
        completion: BrowserLaunchCompletionRecord,
    ) {
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WINDOWS_ROLE_SETUP_RETRY_DELAY).await;
            let retry_is_current = runtime
                .state
                .lock()
                .ok()
                .is_some_and(|state| automatic_launch_retry_is_current(&state, &key));
            if !retry_is_current {
                return;
            }
            let command = if completion.tab_type == "workspace" {
                CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id: completion.source_id.clone(),
                    target: completion.target.clone(),
                }
            } else {
                CoreCommand::BrowserRoleLaunch {
                    role_id: completion.source_id.clone(),
                    target: completion.target.clone(),
                    zoom_factor: completion.zoom_factor,
                }
            };
            if let Err(error) = Arc::clone(&runtime.core).invoke_async(command).await {
                let error = error.payload();
                if let Ok(mut state) = runtime.state.lock() {
                    state.automatic_launch_retries.remove(&key);
                }
                runtime.fail_tab_launch_preview(&key);
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
        let provisional = self.state.lock().ok().and_then(|mut state| {
            state
                .provisional_launches
                .values_mut()
                .find(|launch| launch.id == tab_id)
                .map(|launch| {
                    launch.cancelled = true;
                    launch.clone()
                })
        });
        let Some(provisional) = provisional else {
            return false;
        };
        if let Ok(mut state) = self.state.lock() {
            state.automatic_launch_retries.remove(&format!(
                "{}:{}",
                provisional.tab_type, provisional.source_id
            ));
            state
                .completed_failed_launch_cleanups
                .retain(|(tab_id, _)| tab_id != &provisional.id);
            state.retryable_failed_launches.remove(&provisional.id);
            state.launch_attempt_generations.remove(&provisional.id);
        }
        let mut next_tab_id = None;
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut selection) = presentation.lock()
        {
            let was_selected =
                selection.selected_tab_id.as_deref() == Some(provisional.id.as_str());
            let revision = self.presentation.next_revision();
            selection.remove_tab(&provisional.id, revision);
            if was_selected {
                next_tab_id = selection.tabs.last().map(|tab| tab.id.clone());
                selection.select(next_tab_id.clone(), revision);
            }
        }
        self.publish_launcher_presence();
        self.remove_native_tab_reservation(
            &provisional.window_id,
            &provisional.id,
            next_tab_id.as_deref(),
        );
        if let Some(tab_id) = next_tab_id {
            let _ = self.request_tab_presentation(
                tab_id.as_str(),
                NativePresentationFocus::None,
                "launch-preview-closed",
            );
        }
        true
    }

    fn take_tab_launch_preview(
        &self,
        window_id: &str,
        source_id: &str,
        tab_type: &str,
    ) -> RuntimeResult<Option<ProvisionalLaunch>> {
        let key = format!("{tab_type}:{source_id}");
        let mut state = self.state()?;
        let matches = state.provisional_launches.get(&key).is_some_and(|launch| {
            launch.window_id == window_id
                && launch.source_id == source_id
                && launch.tab_type == tab_type
        });
        if !matches {
            return Ok(None);
        }
        if state
            .provisional_launches
            .get(&key)
            .is_some_and(|launch| launch.cancelled)
        {
            return Err(RuntimeError::new(
                "LAUNCH_CANCELLED",
                "The provisional runtime tab was closed before native attachment began.",
            ));
        }
        Ok(state.provisional_launches.remove(&key).filter(|launch| {
            launch.window_id == window_id
                && launch.source_id == source_id
                && launch.tab_type == tab_type
        }))
    }

}
