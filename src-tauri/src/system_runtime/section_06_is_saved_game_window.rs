impl SystemRuntimeExecutor {
    fn is_saved_game_window(&self, window_id: &str) -> Result<bool, String> {
        match self.core.invoke(CoreCommand::GameWindowGet {
            id: window_id.to_owned(),
        }) {
            Ok(_) => Ok(true),
            Err(error) if error.payload().code == "GAME_WINDOW_NOT_FOUND" => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn new(app: AppHandle, user_data_dir: PathBuf, core: Arc<AppCore>) -> Result<Self, String> {
        let settings = core
            .invoke(CoreCommand::GameBrowserSettingsGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<GameBrowserSettingsRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        #[cfg(windows)]
        let additional_browser_arguments = rion_core::additional_browser_arguments(
            rion_platform::Platform::Windows,
            "msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        )
        .join(" ");
        let runtime_indicator_script = runtime_indicator_document_start_script()?;
        let document_start_script = [
            SYSTEM_RUNTIME_INIT_SCRIPT.to_owned(),
            RUNTIME_AUDIO_OBSERVER_SCRIPT.to_owned(),
            runtime_indicator_script,
            native_font_document_start_script(),
        ]
        .into_iter()
        .filter(|source| !source.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        let overlay_document_start_script_template =
            macro_overlay_document_start_script_template()?;
        let stored_restore_session = core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        let game_windows = core
            .invoke(CoreCommand::GameWindowsList)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                    .map_err(|error| error.to_string())
            })?;
        let saved_window_names = game_windows
            .iter()
            .map(|window| (window.id.clone(), window.name.clone()))
            .collect::<HashMap<_, _>>();
        let dormant_windows = game_windows
            .iter()
            .filter(|window| !window.tabs.is_empty())
            .map(|window| {
                let active_source_id = window.active_tab_id.as_ref().and_then(|active_tab_id| {
                    window
                        .tabs
                        .iter()
                        .find(|tab| &tab.id == active_tab_id && !tab.hidden)
                        .map(|tab| tab.source_id.clone())
                });
                RuntimeRestoreWindowRecord {
                    id: window.id.clone(),
                    target_display: window.target_display.clone(),
                    // Visibility is runtime state and intentionally is not duplicated in
                    // the lifecycle journal. All persistent windows reopen after a clean
                    // launch, including windows that were manually hidden.
                    was_visible: true,
                    active_source_id,
                    tabs: window
                        .tabs
                        .iter()
                        .map(|tab| RuntimeRestoreTabRecord {
                            tab_type: tab.tab_type.clone(),
                            source_id: tab.source_id.clone(),
                            name: tab.name.clone(),
                            role_ids: tab.role_ids.clone(),
                            hidden: tab.hidden,
                            audio_muted: tab.audio_muted,
                        })
                        .collect(),
                }
            })
            .collect::<Vec<_>>();
        let recovery_required = !stored_restore_session.clean_exit && !dormant_windows.is_empty();
        let recovery_interrupted_window_ids = if recovery_required {
            stored_restore_session.restore_in_progress_window_ids.clone()
        } else {
            Vec::new()
        };
        let recovery_session_generation = stored_restore_session.session_generation;
        let mut unclean_session = stored_restore_session;
        unclean_session.schema_version = 2;
        unclean_session.session_generation = unclean_session.session_generation.saturating_add(1);
        unclean_session.clean_exit = false;
        unclean_session.updated_at = chrono::Utc::now().to_rfc3339();
        unclean_session.restore_in_progress_window_ids.clear();
        unclean_session.windows.clear();
        core.invoke(CoreCommand::RuntimeRestoreSessionReplace {
            session: unclean_session,
        })
        .map_err(|error| error.to_string())?;

        set_application_lifecycle_epoch(0);
        let operations = Arc::new(NativeOperationRegistry::default());
        NativeOperationRegistry::start_deadline_worker(&operations)?;
        let application_lifecycle = Arc::new(ApplicationLifecycleCoordinator::new());
        let focus_broker = Arc::new(NativeFocusBroker::default());
        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| "The main Tauri window is unavailable.".to_owned())?;
        let main_window_actor = MainWindowActor::start(
            app.clone(),
            main_window,
            Arc::clone(&operations),
            Arc::clone(&focus_broker),
        )?;
        Ok(Self {
            app,
            close_effect_senders: OnceLock::new(),
            configuration: RuntimeWebViewConfiguration {
                #[cfg(windows)]
                additional_browser_arguments,
                document_start_script,
                macos_high_refresh_rate: settings.performance.macos_high_refresh_rate,
                overlay_document_start_script_template,
            },
            core,
            critical_activity_sequence: AtomicU64::new(0),
            effect_sender: OnceLock::new(),
            lifecycle_sender: OnceLock::new(),
            diagnostics: Mutex::new(RuntimeDiagnosticsState::default()),
            health: RuntimeHealth::new(),
            focus_broker,
            language: Mutex::new("en".to_owned()),
            resolved_theme: Mutex::new("light".to_owned()),
            last_performance_diagnostics: Mutex::new(None),
            launch_effect_sender: OnceLock::new(),
            input_effect_sender: OnceLock::new(),
            input_effect_lanes: Mutex::new(HashMap::new()),
            last_critical_activity: Mutex::new(Instant::now()),
            main_window_actor,
            application_lifecycle,
            input_dispatch_lanes: Mutex::new(HashMap::new()),
            native_creation_lanes: Mutex::new(HashMap::new()),
            native_creation_slots: NativeCreationGate::new(native_creation_limit(
                current_runtime_platform(),
            )),
            operations,
            native_window_mutations: Arc::new(NativeWindowMutationRegistry::default()),
            optional_hydration_sender: OnceLock::new(),
            presentation: Arc::new(PresentationRegistry::default()),
            surface_recoveries: SurfaceRecoveryRegistry::default(),
            tab_activations: Arc::new(TabActivationCoordinator::default()),
            tab_mutations: Arc::new(TabMutationCoordinator::default()),
            #[cfg(windows)]
            tab_chrome_projections: Arc::new(TabChromeProjectionCoordinator::default()),
            prewarm_state: AtomicU8::new(0),
            restore_persist_requested: AtomicU64::new(0),
            restore_persist_running: AtomicBool::new(false),
            runtime_projection: RevisionedJsonProjection::default(),
            shortcut_modifier_handoffs: Mutex::new(HashMap::new()),
            shutdown_operation: OnceLock::new(),
            shutdown_state: Arc::new(AtomicU8::new(RuntimeShutdownState::Accepting as u8)),
            state: Mutex::new(RuntimeState {
                dormant_windows,
                recovery_interrupted_window_ids,
                recovery_required,
                recovery_session_generation,
                saved_window_names,
                ..RuntimeState::default()
            }),
            user_data_dir,
        })
    }

    pub fn start_effect_executor(self: &Arc<Self>) -> Result<(), String> {
        self.start_application_lifecycle_actor()?;
        let (sender, receiver) = mpsc::channel();
        self.effect_sender
            .set(sender)
            .map_err(|_| "The System WebView effect executor was already started.".to_owned())?;
        let runtime = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("rion-tauri-core-effects".to_owned())
            .spawn(move || {
                run_serial_runtime_work_loop(receiver, |work| {
                    if let Some(runtime) = runtime.upgrade() {
                        runtime.execute_serial_work(work);
                    }
                });
            })
            .map_err(|error| error.to_string())?;

        // Close/isolation has a dedicated lane. A slow launch or page-load waiter must never
        // consume the workers that take game content offline.
        let mut close_senders: Vec<mpsc::SyncSender<ConcurrentRuntimeWork>> =
            Vec::with_capacity(CLOSE_EFFECT_SHARD_COUNT);
        for index in 0..CLOSE_EFFECT_SHARD_COUNT {
            let (sender, receiver) = mpsc::sync_channel(32);
            close_senders.push(sender);
            let runtime = Arc::downgrade(self);
            std::thread::Builder::new()
                .name(format!("rion-native-close-{index}"))
                .spawn(move || {
                    while let Ok(work) = receiver.recv() {
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.execute_effect_work(
                            work.action_name,
                            work.effect,
                            work.presentation_revision,
                            work.persist_runtime,
                        );
                    }
                })
                .map_err(|error| error.to_string())?;
        }
        self.close_effect_senders
            .set(close_senders)
            .map_err(|_| "The close System WebView executor was already started.".to_owned())?;

        // Launch work is bounded separately. Navigation completion is handed to Tokio and no
        // longer occupies one of these workers for the 40 second page-load timeout.
        let (launch_sender, launch_receiver) = mpsc::sync_channel(64);
        self.launch_effect_sender
            .set(launch_sender)
            .map_err(|_| "The launch System WebView executor was already started.".to_owned())?;
        let launch_receiver = Arc::new(Mutex::new(launch_receiver));
        for index in 0..4 {
            let runtime = Arc::downgrade(self);
            let receiver = Arc::clone(&launch_receiver);
            std::thread::Builder::new()
                .name(format!("rion-native-launch-{index}"))
                .spawn(move || {
                    loop {
                        let work = {
                            let Ok(receiver) = receiver.lock() else {
                                return;
                            };
                            receiver.recv()
                        };
                        let Ok(work) = work else {
                            return;
                        };
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.execute_effect_work(
                            work.action_name,
                            work.effect,
                            work.presentation_revision,
                            work.persist_runtime,
                        );
                    }
                })
                .map_err(|error| error.to_string())?;
        }

        let (optional_sender, optional_receiver) = mpsc::sync_channel(32);
        self.optional_hydration_sender
            .set(optional_sender)
            .map_err(|_| "The optional hydration executor was already started.".to_owned())?;
        let optional_receiver = Arc::new(Mutex::new(optional_receiver));
        for index in 0..2 {
            let runtime = Arc::downgrade(self);
            let receiver = Arc::clone(&optional_receiver);
            std::thread::Builder::new()
                .name(format!("rion-native-idle-{index}"))
                .spawn(move || {
                    loop {
                        let work = {
                            let Ok(receiver) = receiver.lock() else {
                                return;
                            };
                            receiver.recv()
                        };
                        let Ok(work) = work else {
                            return;
                        };
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.wait_for_optional_idle();
                        runtime.hydrate_tab_optional(&work.tab_id);
                    }
                })
                .map_err(|error| error.to_string())?;
        }

        let (input_sender, input_receiver) = mpsc::sync_channel(128);
        self.input_effect_sender
            .set(input_sender)
            .map_err(|_| "The browser input effect executor was already started.".to_owned())?;
        let runtime = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("rion-native-input-dispatch".to_owned())
            .spawn(move || {
                while let Ok(work) = input_receiver.recv() {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    runtime.dispatch_role_input_work(work);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn dispatch_role_input_work(self: &Arc<Self>, work: ConcurrentRuntimeWork) {
        let role_id = match &work.effect.action {
            CoreEffectAction::BrowserAction { request } => request.role_id.clone(),
            _ => {
                self.reject_input_work(work, "A non-input effect entered the role input lane.");
                return;
            }
        };
        let sender = self.input_effect_lanes.lock().ok().and_then(|mut lanes| {
            if let Some(sender) = lanes.get(&role_id) {
                return Some(sender.clone());
            }
            let (sender, receiver) = mpsc::sync_channel::<ConcurrentRuntimeWork>(32);
            let runtime = Arc::downgrade(self);
            let sequence = ROLE_INPUT_WORKER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            if std::thread::Builder::new()
                .name(format!("rion-native-role-input-{sequence}"))
                .spawn(move || {
                    while let Ok(work) = receiver.recv() {
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.execute_effect_work(
                            work.action_name,
                            work.effect,
                            work.presentation_revision,
                            work.persist_runtime,
                        );
                    }
                })
                .is_err()
            {
                return None;
            }
            lanes.insert(role_id.clone(), sender.clone());
            Some(sender)
        });
        let Some(sender) = sender else {
            self.reject_input_work(work, "The per-role input executor could not be started.");
            return;
        };
        if let Err(error) = sender.try_send(work) {
            let work = match error {
                mpsc::TrySendError::Full(work) | mpsc::TrySendError::Disconnected(work) => work,
            };
            self.reject_input_work(work, "The per-role input queue is full or stopped.");
        }
    }

    fn reject_input_work(&self, work: ConcurrentRuntimeWork, message: &str) {
        let _ = self.core.dispatch_core_effect_results(vec![CoreEffectResult {
            effect_id: work.effect.effect_id,
            operation_id: work.effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(rion_core::CoreErrorPayload {
                code: "SYSTEM_TRUSTED_INPUT_QUEUE_UNAVAILABLE".to_owned(),
                message: message.to_owned(),
            }),
        }]);
    }

    pub fn enqueue_effect(
        self: &Arc<Self>,
        effect: CoreEffectRequest,
        action_name: &'static str,
        persist_runtime: bool,
    ) -> Result<(), String> {
        let shutdown_accepting = RuntimeShutdownState::from_raw(
            self.shutdown_state.load(Ordering::Acquire),
        ) == RuntimeShutdownState::Accepting;
        let lifecycle_accepting = self.application_lifecycle.accepts_native_work();
        if (!shutdown_accepting || !lifecycle_accepting)
            && !is_surface_close_effect(&effect.action)
        {
            let (code, message) = if shutdown_accepting {
                (
                    "SYSTEM_RUNTIME_SUSPENDED",
                    "The System WebView runtime is suspended and rejected new native work.",
                )
            } else {
                (
                    "SYSTEM_RUNTIME_SHUTTING_DOWN",
                    "The System WebView runtime is shutting down and rejected new native work.",
                )
            };
            return self
                .core
                .dispatch_core_effect_results(vec![CoreEffectResult {
                    effect_id: effect.effect_id,
                    operation_id: effect.operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(rion_core::CoreErrorPayload {
                        code: code.to_owned(),
                        message: message.to_owned(),
                    }),
                }])
                .map(|_| ())
                .map_err(|error| error.to_string());
        }
        let presentation_revision = self.presentation.current_revision();
        if is_surface_close_effect(&effect.action)
            || is_independent_tab_launch_effect(&effect.action)
            || is_browser_action_effect(&effect.action)
        {
            let input_effect = is_browser_action_effect(&effect.action);
            self.mark_critical_activity();
            let effect_id = effect.effect_id.clone();
            let operation_id = effect.operation_id.clone();
            let sender = if is_surface_close_effect(&effect.action) {
                self.close_effect_senders.get().and_then(|senders| {
                    self.close_effect_scope(&effect.action).and_then(|scope| {
                        senders.get(close_effect_shard_index(&scope, senders.len()))
                    })
                })
            } else if is_browser_action_effect(&effect.action) {
                self.input_effect_sender.get()
            } else {
                self.launch_effect_sender.get()
            };
            let enqueue = sender
                .ok_or_else(|| "The concurrent System WebView executor is unavailable.".to_owned())
                .and_then(|sender| {
                    sender
                        .try_send(ConcurrentRuntimeWork {
                            action_name,
                            effect,
                            persist_runtime,
                            presentation_revision,
                        })
                        .map_err(|error| {
                            format!(
                                "The concurrent native effect queue is full or stopped: {error}"
                            )
                        })
                });
            return enqueue.or_else(|error| {
                    let (code, message) = if input_effect {
                        (
                            "SYSTEM_TRUSTED_INPUT_QUEUE_UNAVAILABLE",
                            "The native input dispatcher could not accept work",
                        )
                    } else {
                        (
                            "SYSTEM_SURFACE_CLOSE_WORKER_FAILED",
                            "The native surface close or launch worker could not accept work",
                        )
                    };
                    self.core
                        .dispatch_core_effect_results(vec![CoreEffectResult {
                            effect_id,
                            operation_id,
                            ok: false,
                            value_json: None,
                            error: Some(rion_core::CoreErrorPayload {
                                code: code.to_owned(),
                                message: format!("{message}: {error}"),
                            }),
                        }])
                        .map(|_| ())
                        .map_err(|dispatch_error| dispatch_error.to_string())
                });
        }
        self.effect_sender
            .get()
            .ok_or_else(|| "The System WebView effect executor is unavailable.".to_owned())?
            .send(SystemRuntimeWork::Effect {
                action_name,
                effect: Box::new(effect),
                presentation_revision,
                persist_runtime,
            })
            .map_err(|_| "The System WebView effect executor stopped unexpectedly.".to_owned())
    }

    fn mark_critical_activity(&self) {
        self.critical_activity_sequence
            .fetch_add(1, Ordering::AcqRel);
        if let Ok(mut last_activity) = self.last_critical_activity.lock() {
            *last_activity = Instant::now();
        }
    }

    fn set_launch_phase(&self, tab_id: &str, phase: LaunchPhase) {
        let (window_id, changed) = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| {
                let window_id = state.tabs.get(tab_id)?.window_id.clone();
                let changed = state.launch_phases.insert(tab_id.to_owned(), phase) != Some(phase);
                Some((window_id, changed))
            })
            .unwrap_or((String::new(), false));
        if !window_id.is_empty()
            && let Some(presentation) = self.presentation.existing(&window_id)
            && let Ok(mut presentation) = presentation.lock()
        {
            presentation.update_phase(
                tab_id,
                match phase {
                    LaunchPhase::Attaching => TabPresentationPhase::Attaching,
                    LaunchPhase::Navigating => TabPresentationPhase::Loading,
                    LaunchPhase::EssentialReady
                    | LaunchPhase::OptionalHydrating
                    | LaunchPhase::Ready => TabPresentationPhase::Ready,
                    LaunchPhase::Degraded => TabPresentationPhase::Degraded,
                },
            );
        }
        if changed {
            self.record_runtime_stage(
                format!("launch-phase:{tab_id}:{}", phase.as_str()),
                "completed",
                Instant::now(),
            );
        }
    }

    #[cfg(target_os = "macos")]
    pub fn schedule_webview_prewarm(self: &Arc<Self>) {
        // A standalone hidden Tauri WebviewWindow creates and tears down another
        // TaoWindow but cannot donate its controller to a role launch. Avoid adding
        // that unrelated native event lifecycle on macOS; launch remains fully lazy
        // until prewarming can be implemented as a windowless WKWebView actor.
        self.prewarm_state.store(3, Ordering::Release);
        self.record_runtime_stage("runtime-prewarm", "skipped", Instant::now());
    }

    #[cfg(not(target_os = "macos"))]
    pub fn schedule_webview_prewarm(self: &Arc<Self>) {
        if self
            .prewarm_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let runtime = Arc::downgrade(self);
        let activity_sequence = self.critical_activity_sequence.load(Ordering::Acquire);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let Some(runtime) = runtime.upgrade() else {
                return;
            };
            if runtime.critical_activity_sequence.load(Ordering::Acquire) != activity_sequence {
                runtime.prewarm_state.store(3, Ordering::Release);
                return;
            }
            let worker_runtime = Arc::clone(&runtime);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                worker_runtime.prewarm_webview_once(activity_sequence)
            })
            .await
            .unwrap_or_else(|error| Err(format!("WebView prewarm worker failed: {error}")));
            runtime.prewarm_state.store(2, Ordering::Release);
            runtime.record_runtime_stage(
                "runtime-prewarm",
                if outcome.is_ok() {
                    "completed"
                } else {
                    "degraded"
                },
                Instant::now(),
            );
        });
    }

    #[cfg(not(target_os = "macos"))]
    fn prewarm_webview_once(&self, activity_sequence: u64) -> Result<(), String> {
        if self.critical_activity_sequence.load(Ordering::Acquire) != activity_sequence {
            return Ok(());
        }
        let prewarm_dir = self.user_data_dir.join("runtime-prewarm");
        fs::create_dir_all(&prewarm_dir).map_err(|error| error.to_string())?;
        let blank: Url = "about:blank"
            .parse()
            .map_err(|error| format!("Invalid prewarm URL: {error}"))?;
        let label = format!("rion-runtime-prewarm-{}", uuid::Uuid::new_v4());
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let builder = WebviewWindowBuilder::new(&self.app, label, WebviewUrl::External(blank))
            .visible(false)
            .inner_size(1.0, 1.0)
            .data_directory(prewarm_dir)
            .data_store_identifier(
                *uuid::Uuid::parse_str("21bcf8cb-1ff0-4bd0-b56e-861fbdef3b70")
                    .expect("the prewarm data-store UUID is valid")
                    .as_bytes(),
            )
            .on_page_load(move |_webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = ready_sender.try_send(());
                }
            });
        let window = builder.build().map_err(|error| error.to_string())?;
        let _ = ready_receiver.recv_timeout(Duration::from_secs(2));
        window.close().map_err(|error| error.to_string())
    }

    fn wait_for_optional_idle(&self) {
        loop {
            let launch_busy = self.state.lock().ok().is_some_and(|state| {
                state
                    .launch_phases
                    .values()
                    .any(|phase| phase.blocks_optional_idle())
            });
            if launch_busy {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            let remaining = self
                .last_critical_activity
                .lock()
                .ok()
                .map(|last_activity| {
                    OPTIONAL_HYDRATION_IDLE_INTERVAL.saturating_sub(last_activity.elapsed())
                })
                .unwrap_or_default();
            if remaining.is_zero() {
                return;
            }
            std::thread::sleep(remaining.min(Duration::from_millis(50)));
        }
    }

    pub(crate) fn wait_for_shell_idle(&self) {
        self.wait_for_optional_idle();
    }

    fn schedule_optional_hydration(&self, tab_id: &str) {
        if let Some(sender) = self.optional_hydration_sender.get() {
            let _ = sender.try_send(OptionalHydrationWork {
                tab_id: tab_id.to_owned(),
            });
        }
    }

    fn hydrate_tab_optional(&self, tab_id: &str) {
        self.set_launch_phase(tab_id, LaunchPhase::OptionalHydrating);
        let mut degraded = false;
        let surfaces = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state.tabs.get(tab_id).map(|tab| {
                    tab.roles
                        .iter()
                        .map(|(role_id, surface)| {
                            (role_id.clone(), surface.generation, surface.webview.clone())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .unwrap_or_default();
        for (role_id, generation, webview) in surfaces {
            self.wait_for_optional_idle();
            let current = self.state.lock().ok().is_some_and(|state| {
                !state.close_coordinator.closing_tabs.contains(tab_id)
                    && !state.close_coordinator.closing_roles.contains(&role_id)
                    && state.role_tabs.get(&role_id).is_some_and(|current_tab_id| {
                        current_tab_id == tab_id
                            && state.tabs.get(tab_id).is_some_and(|tab| {
                                tab.roles.get(&role_id).is_some_and(|surface| {
                                    surface.generation == generation
                                        && surface.webview.label() == webview.label()
                                })
                            })
                    })
            });
            if !current {
                continue;
            }
            let shortcut_status = install_role_zoom_shortcut_handler(&webview, self.app.clone());
            degraded |= shortcut_status.is_err();
            self.record_runtime_stage(
                format!("optional-hydration:{tab_id}:{role_id}"),
                if shortcut_status.is_ok() {
                    "completed"
                } else {
                    "degraded"
                },
                Instant::now(),
            );
        }
        self.wait_for_optional_idle();
        if let Err(error) = self.hydrate_tab_dividers(tab_id) {
            degraded = true;
            self.record_runtime_stage(
                format!("optional-dividers:{tab_id}:{}", error.code),
                "degraded",
                Instant::now(),
            );
        }
        self.set_launch_phase(
            tab_id,
            if degraded {
                LaunchPhase::Degraded
            } else {
                LaunchPhase::Ready
            },
        );
    }

}
