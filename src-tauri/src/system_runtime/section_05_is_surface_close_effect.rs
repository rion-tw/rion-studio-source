fn is_surface_close_effect(action: &CoreEffectAction) -> bool {
    matches!(
        action,
        CoreEffectAction::EmbeddedDestroyRole { .. } | CoreEffectAction::EmbeddedDestroyTab { .. }
    )
}

const CLOSE_EFFECT_SHARD_COUNT: usize = 2;

fn close_effect_shard_index(scope: &str, shard_count: usize) -> usize {
    debug_assert!(shard_count > 0);
    scope.bytes().fold(0_usize, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(usize::from(byte))
    }) % shard_count
}

fn close_effect_scope_key(
    action: &CoreEffectAction,
    resolved_role_tab_id: Option<&str>,
) -> Option<String> {
    match action {
        CoreEffectAction::EmbeddedDestroyTab { tab_id, .. } => Some(tab_id.clone()),
        CoreEffectAction::EmbeddedDestroyRole { role_id } => Some(
            resolved_role_tab_id
                .map(str::to_owned)
                .unwrap_or_else(|| format!("retired-role:{role_id}")),
        ),
        _ => None,
    }
}

impl SystemRuntimeExecutor {
    fn close_effect_scope(&self, action: &CoreEffectAction) -> Option<String> {
        let resolved_role_tab_id = match action {
            CoreEffectAction::EmbeddedDestroyRole { role_id } => self
                .state
                .lock()
                .ok()
                .and_then(|state| state.native_tab_id_for_role_surface(role_id).cloned()),
            _ => None,
        };
        close_effect_scope_key(action, resolved_role_tab_id.as_deref())
    }
}

fn is_independent_tab_launch_effect(action: &CoreEffectAction) -> bool {
    matches!(
        action,
        CoreEffectAction::EmbeddedCreateTab { .. }
            | CoreEffectAction::EmbeddedConfigureRoleSessions { .. }
            | CoreEffectAction::EmbeddedLoadRoles { .. }
            | CoreEffectAction::EmbeddedInstallOverlays { .. }
            | CoreEffectAction::EmbeddedFocusRole { .. }
    )
}

fn is_browser_action_effect(action: &CoreEffectAction) -> bool {
    matches!(action, CoreEffectAction::BrowserAction { .. })
}

fn marks_optional_hydration_critical_activity(action: &CoreEffectAction) -> bool {
    is_surface_close_effect(action) || is_independent_tab_launch_effect(action)
}

fn optional_hydration_is_admitted(shutdown_state: RuntimeShutdownState) -> bool {
    shutdown_state == RuntimeShutdownState::Accepting
}

fn browser_action_deadline_expired(deadline_ms: u64) -> bool {
    chrono::Utc::now().timestamp_millis().max(0) as u64 > deadline_ms
}

fn run_serial_runtime_work_loop<T>(receiver: Receiver<T>, mut execute: impl FnMut(T)) {
    while let Ok(work) = receiver.recv() {
        execute(work);
    }
}

fn native_effect_scope(effect: &CoreEffectRequest) -> String {
    fn collect(value: &Value, fields: &mut Vec<String>, seen: &mut HashSet<String>) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if matches!(key.as_str(), "roleId" | "tabId" | "windowId")
                        && let Some(identifier) = value.as_str()
                    {
                        let field = format!("{key}={identifier}");
                        if seen.insert(field.clone()) {
                            fields.push(field);
                        }
                    }
                    if fields.len() < 12 {
                        collect(value, fields, seen);
                    }
                }
            }
            Value::Array(values) => {
                for value in values.iter().take(12) {
                    collect(value, fields, seen);
                }
            }
            _ => {}
        }
    }

    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(value) = serde_json::to_value(&effect.action) {
        collect(&value, &mut fields, &mut seen);
    }
    if fields.is_empty() {
        "scope=none".to_owned()
    } else {
        fields.join(", ")
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_presentation_event(
    core: Arc<AppCore>,
    level: LogLevel,
    event: &'static str,
    message: &'static str,
    window_id: String,
    tab_id: Option<String>,
    revision: u64,
    trigger: &'static str,
    elapsed_ms: u64,
    launch_preview_id: Option<String>,
    error: Option<LogErrorDetails>,
    diagnostic: Option<RuntimeErrorDiagnostic>,
) {
    let mut context = json!({
        "elapsedMs": elapsed_ms,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "revision": revision,
        "tabId": tab_id,
        "trigger": trigger,
        "windowId": window_id,
    });
    if let Some(launch_preview_id) = launch_preview_id
        && let Some(context) = context.as_object_mut()
    {
        context.insert(
            "launchPreviewId".to_owned(),
            Value::String(launch_preview_id),
        );
    }
    if event.starts_with("tab.launch-auto-retry")
        && let Some(context) = context.as_object_mut()
    {
        context.insert("retryAttempt".to_owned(), Value::from(1));
        context.insert(
            "retryDelayMs".to_owned(),
            Value::from(WINDOWS_ROLE_SETUP_RETRY_DELAY.as_millis() as u64),
        );
    }
    if let Some(diagnostic) = diagnostic
        && let Some(context) = context.as_object_mut()
    {
        context.insert(
            "setupStage".to_owned(),
            Value::String(diagnostic.setup_stage.to_owned()),
        );
        if let Some(native_code) = diagnostic.native_code {
            context.insert("nativeCode".to_owned(), Value::String(native_code));
        }
    }
    if let Some(error) = error.as_ref()
        && let Some(context) = context.as_object_mut()
        && error.name != "CORE_OPERATION_COMPENSATION_FAILED"
    {
        context.insert(
            "rootCauseCode".to_owned(),
            Value::String(error.name.clone()),
        );
    }
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level,
                    source: LogSource::Browser,
                    event: event.to_owned(),
                    message: message.to_owned(),
                    context_raw_json: serde_json::to_string(&context).ok(),
                    error,
                }],
            })
            .await;
    });
}

fn presentation_surface_labels(surfaces: &[Webview]) -> HashSet<String> {
    surfaces
        .iter()
        .map(|surface| surface.label().to_owned())
        .collect()
}

fn current_runtime_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

fn native_creation_limit(platform: &str) -> usize {
    if platform == "windows" { 1 } else { 2 }
}

fn automatic_role_setup_retry_allowed(
    platform: &str,
    completed_retries: u8,
    error_code: &str,
    release_verified: bool,
) -> bool {
    platform == "windows"
        && completed_retries == 0
        && error_code == "SYSTEM_ROLE_SETUP_FAILED"
        && release_verified
}

fn native_surface_mutation_is_current(
    owners: &HashMap<String, SurfacePresentationOwner>,
    expected_tokens: &HashMap<String, SurfacePresentationOwner>,
    surface_label: &str,
    window_id: &str,
    window_generation: u64,
) -> bool {
    let Some(expected_owner) = expected_tokens.get(surface_label) else {
        return false;
    };
    owners.get(surface_label).is_some_and(|owner| {
        expected_owner.window_id == window_id
            && expected_owner.window_generation == window_generation
            && owner == expected_owner
            && owner.window_id == window_id
            && owner.window_generation == window_generation
    })
}

fn native_presentation_intent_is_current(
    live_revision: u64,
    live_tab_id: &Option<String>,
    projection_surface_identities: &HashSet<(String, u64)>,
    request_revision: u64,
    request_tab_id: &Option<String>,
    request_surface_identities: &HashSet<(String, u64)>,
) -> bool {
    live_revision == request_revision
        && live_tab_id == request_tab_id
        && projection_surface_identities == request_surface_identities
}

#[cfg(test)]
fn native_presentation_changed(
    previous_tab_id: &Option<String>,
    next_tab_id: &Option<String>,
    previous_labels: &HashSet<String>,
    next_labels: &HashSet<String>,
) -> bool {
    previous_tab_id != next_tab_id || previous_labels != next_labels
}

fn native_presentation_mutation_plan(
    previous_tab_id: &Option<String>,
    next_tab_id: &Option<String>,
    previous_surface_identities: &HashSet<(String, u64)>,
    next_surface_identities: &HashSet<(String, u64)>,
    window: NativeWindowPresentationTransition,
) -> NativePresentationMutationPlan {
    let presentation_changed =
        previous_tab_id != next_tab_id || previous_surface_identities != next_surface_identities;
    let focus_allowed = window.requested_visibility != Some(false);
    let apply_content_focus = focus_allowed && window.focus.focuses_content();
    let apply_window_focus = focus_allowed && window.focus.focuses_window();
    NativePresentationMutationPlan {
        apply_content_focus,
        apply_window_focus,
        presentation_changed,
        requires_ui_thread: presentation_changed
            || window
                .requested_visibility
                .is_some_and(|visible| Some(visible) != window.previous_visibility)
            || window.mode.is_some()
            || apply_content_focus
            || apply_window_focus,
    }
}

fn native_presentation_host_visibility(
    tab_id: Option<&str>,
    requested_visibility: Option<bool>,
) -> bool {
    requested_visibility.unwrap_or(tab_id.is_some())
}

fn native_window_foreground_show_should_apply(
    requested_visibility: Option<bool>,
    apply_window_focus: bool,
    defer_window_focus_until_reveal: bool,
) -> bool {
    requested_visibility == Some(true)
        && apply_window_focus
        && !defer_window_focus_until_reveal
}

fn native_presentation_native_work_is_current(
    shutdown_state: &AtomicU8,
    application_lifecycle: &ApplicationLifecycleCoordinator,
    expected_lifecycle_epoch: u64,
    actor_liveness: &AtomicBool,
) -> bool {
    RuntimeShutdownState::from_raw(shutdown_state.load(Ordering::Acquire))
        == RuntimeShutdownState::Accepting
        && application_lifecycle.accepts_native_work()
        && application_lifecycle.epoch() == expected_lifecycle_epoch
        && actor_liveness.load(Ordering::Acquire)
}

fn native_window_restore_required(
    apply_window_focus: bool,
    window_was_minimized: Option<bool>,
) -> bool {
    apply_window_focus && window_was_minimized == Some(true)
}

fn native_window_focus_should_apply(
    presentation_current: bool,
    ordered_window_control: bool,
    focus_requested: bool,
    focus_current: bool,
) -> bool {
    focus_requested && focus_current && (presentation_current || ordered_window_control)
}

fn presentation_owner_identities(
    surfaces: &[Webview],
    tokens: &HashMap<String, SurfacePresentationOwner>,
) -> HashSet<(String, u64)> {
    surfaces
        .iter()
        .map(|surface| {
            (
                surface.label().to_owned(),
                tokens
                    .get(surface.label())
                    .map(|owner| owner.owner_epoch)
                    .unwrap_or_default(),
            )
        })
        .collect()
}

fn apply_native_presentation_batch(
    request: &NativePresentationRequest,
    previous_tab_id: &Option<String>,
    previous_surface_identities: &HashSet<(String, u64)>,
    previous_surfaces: Vec<Webview>,
    previous_window_visibility: Option<bool>,
) -> NativePresentationOutcome {
    let mutation_lane = match request.native_window_mutations.lane(&request.window_id) {
        Ok(lane) => lane,
        Err(error) => return failed_native_presentation_outcome(error.message),
    };
    let _mutation_guard = match mutation_lane.lock_until(request.operation.required_deadline()) {
        Ok(guard) => guard,
        Err(_) => {
            return failed_native_presentation_outcome(
                "The native window mutation lane is unavailable.".to_owned(),
            );
        }
    };
    if !native_presentation_native_work_is_current(
        &request.shutdown_state,
        &request.application_lifecycle,
        request.expected_lifecycle_epoch,
        &request.actor_liveness,
    ) {
        return NativePresentationOutcome {
            applied: false,
            presentation_applied: false,
            focus_applied: false,
            focus_superseded: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: 0,
            main_thread_ms: 0,
            no_op: false,
            planned_surface_mutation_count: 0,
            shown_surface_count: 0,
            show_ms: 0,
            skipped_surface_count: 0,
            visibility_errors: Vec::new(),
            webview_focus_ms: 0,
            window_focused_after: None,
            window_focus_applied: false,
            window_focus_ms: 0,
            window_restore_applied: false,
            window_visible_after: None,
            window_visibility_ms: 0,
            window_was_minimized: None,
        };
    }
    let previous_labels = presentation_surface_labels(&previous_surfaces);
    let next_labels = presentation_surface_labels(&request.next_surfaces);
    let planned_surface_mutation_count = previous_labels.difference(&next_labels).count()
        + next_labels.difference(&previous_labels).count();
    let ordered_window_control =
        request.window_mode.is_some() || request.window_visibility.is_some();
    let next_surface_mutation_identities =
        presentation_owner_identities(&request.next_surfaces, &request.surface_owner_tokens);
    let mutation_plan = native_presentation_mutation_plan(
        previous_tab_id,
        &request.tab_id,
        previous_surface_identities,
        &next_surface_mutation_identities,
        NativeWindowPresentationTransition::new(
            previous_window_visibility,
            request.window_visibility,
            request.window_mode,
            request.focus,
        ),
    );
    let desired_intent = request.desired_projection.read().ok().and_then(|projection| {
        let desired = projection.as_ref()?;
        (desired.window_generation == request.window_generation).then(|| {
            (
                desired.window_revision,
                desired
                    .tabs
                    .iter()
                    .find(|tab| tab.selected)
                    .map(|tab| tab.tab_id.clone()),
                request
                    .coordinator
                    .lock()
                    .ok()
                    .map(|projection| projection.surface_identities(request.tab_id.as_deref()))
                    .unwrap_or_default(),
            )
        })
    });
    let still_desired = desired_intent
        .is_some_and(|(live_revision, live_tab_id, projection_surface_identities)| {
            native_presentation_intent_is_current(
                live_revision,
                &live_tab_id,
                &projection_surface_identities,
                request.revision,
                &request.tab_id,
                &request.next_surface_identities,
            )
        });
    if (!still_desired && !ordered_window_control) || !mutation_plan.requires_ui_thread {
        let applied = still_desired || ordered_window_control;
        return NativePresentationOutcome {
            applied,
            presentation_applied: still_desired,
            focus_applied: false,
            focus_superseded: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: applied,
            planned_surface_mutation_count: 0,
            shown_surface_count: 0,
            show_ms: 0,
            skipped_surface_count: 0,
            visibility_errors: Vec::new(),
            webview_focus_ms: 0,
            window_focused_after: None,
            window_focus_applied: false,
            window_focus_ms: 0,
            window_restore_applied: false,
            window_visible_after: None,
            window_visibility_ms: 0,
            window_was_minimized: None,
        };
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let coordinator = Arc::clone(&request.coordinator);
    let desired_projection = Arc::clone(&request.desired_projection);
    let requested_at = request.requested_at;
    let revision = request.revision;
    let tab_id = request.tab_id.clone();
    let next_surfaces = request.next_surfaces.clone();
    let next_surface_identities = request.next_surface_identities.clone();
    let surface_owner_tokens = request.surface_owner_tokens.clone();
    let surface_owners = Arc::clone(&request.surface_owners);
    let active_webview = request.active_webview.clone();
    let window = request.window.clone();
    let window_generation = request.window_generation;
    let window_id = request.window_id.clone();
    let window_mode = request.window_mode;
    let window_visibility = request.window_visibility;
    let mutation_plan = mutation_plan.clone();
    let planned_surface_mutation_count = if mutation_plan.presentation_changed {
        planned_surface_mutation_count
    } else {
        0
    };
    let defer_window_focus_until_reveal = request.defer_window_focus_until_reveal;
    let requested_focus = request.focus;
    let focus_broker = Arc::clone(&request.focus_broker);
    let focus_lease = request.focus_lease.clone();
    let shutdown_state = Arc::clone(&request.shutdown_state);
    let application_lifecycle = Arc::clone(&request.application_lifecycle);
    let expected_lifecycle_epoch = request.expected_lifecycle_epoch;
    let actor_liveness = Arc::clone(&request.actor_liveness);
    let task = move || {
        let main_started_at = Instant::now();
        let main_queue_wait_ms = requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if !native_presentation_native_work_is_current(
            &shutdown_state,
            &application_lifecycle,
            expected_lifecycle_epoch,
            &actor_liveness,
        ) {
            let _ = sender.send(NativePresentationOutcome {
                applied: false,
                presentation_applied: false,
                focus_applied: false,
                focus_superseded: false,
                hidden_surface_count: 0,
                hide_ms: 0,
                main_queue_wait_ms,
                main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128)
                    as u64,
                no_op: false,
                planned_surface_mutation_count: 0,
                shown_surface_count: 0,
                show_ms: 0,
                skipped_surface_count: 0,
                visibility_errors: Vec::new(),
                webview_focus_ms: 0,
                window_focused_after: None,
                window_focus_applied: false,
                window_focus_ms: 0,
                window_restore_applied: false,
                window_visible_after: None,
                window_visibility_ms: 0,
                window_was_minimized: None,
            });
            return;
        }
        let desired_intent = desired_projection.read().ok().and_then(|projection| {
            let desired = projection.as_ref()?;
            (desired.window_generation == window_generation).then(|| {
                (
                    desired.window_revision,
                    desired
                        .tabs
                        .iter()
                        .find(|tab| tab.selected)
                        .map(|tab| tab.tab_id.clone()),
                    coordinator
                        .lock()
                        .ok()
                        .map(|projection| projection.surface_identities(tab_id.as_deref()))
                        .unwrap_or_default(),
                )
            })
        });
        let presentation_current = desired_intent
            .is_some_and(
                |(live_revision, live_tab_id, projection_surface_identities)| {
                native_presentation_intent_is_current(
                    live_revision,
                    &live_tab_id,
                    &projection_surface_identities,
                    revision,
                    &tab_id,
                    &next_surface_identities,
                )
            },
            );
        if !presentation_current && !ordered_window_control {
            let _ = sender.send(NativePresentationOutcome {
                applied: false,
                presentation_applied: false,
                focus_applied: false,
                focus_superseded: false,
                hidden_surface_count: 0,
                hide_ms: 0,
                main_queue_wait_ms,
                main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                no_op: false,
                planned_surface_mutation_count: 0,
                shown_surface_count: 0,
                show_ms: 0,
                skipped_surface_count: 0,
                visibility_errors: Vec::new(),
                webview_focus_ms: 0,
                window_focused_after: None,
                window_focus_applied: false,
                window_focus_ms: 0,
                window_restore_applied: false,
                window_visible_after: None,
                window_visibility_ms: 0,
                window_was_minimized: None,
            });
            return;
        }
        let mut visibility_errors = Vec::new();
        let mut hidden_surface_count = 0;
        let mut skipped_surface_count = 0_usize;
        let mut shown_surface_count = 0;
        let surface_owners = surface_owners.lock().ok().map(|owners| owners.clone());
        if presentation_current && mutation_plan.presentation_changed && surface_owners.is_none() {
            visibility_errors.push("The native surface ownership fence is unavailable.".to_owned());
        }
        let hide_started_at = Instant::now();
        if presentation_current
            && mutation_plan.presentation_changed
            && let Some(surface_owners) = surface_owners.as_ref()
        {
            for surface in previous_surfaces {
                if next_labels.contains(surface.label()) {
                    continue;
                }
                if !native_surface_mutation_is_current(
                    surface_owners,
                    &surface_owner_tokens,
                    surface.label(),
                    &window_id,
                    window_generation,
                ) {
                    skipped_surface_count = skipped_surface_count.saturating_add(1);
                    continue;
                }
                match surface.hide() {
                    Ok(()) => hidden_surface_count += 1,
                    Err(error) => visibility_errors.push(error.to_string()),
                }
            }
        }
        let hide_ms = hide_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let show_started_at = Instant::now();
        if presentation_current
            && mutation_plan.presentation_changed
            && let Some(surface_owners) = surface_owners.as_ref()
        {
            for surface in &next_surfaces {
                if previous_labels.contains(surface.label()) {
                    continue;
                }
                if !native_surface_mutation_is_current(
                    surface_owners,
                    &surface_owner_tokens,
                    surface.label(),
                    &window_id,
                    window_generation,
                ) {
                    skipped_surface_count = skipped_surface_count.saturating_add(1);
                    continue;
                }
                match surface.show() {
                    Ok(()) => shown_surface_count += 1,
                    Err(error) => visibility_errors.push(error.to_string()),
                }
            }
        }
        let show_ms = show_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;

        let focus_guard = focus_lease
            .as_ref()
            .map(|lease| focus_broker.begin_mutation(lease));
        let focus_guard = match focus_guard {
            Some(Ok(guard)) => guard,
            Some(Err(code)) => {
                visibility_errors.push(code.to_owned());
                None
            }
            None => None,
        };
        let focus_current = focus_lease.is_none() || focus_guard.is_some();
        let focus_submission_current = defer_window_focus_until_reveal
            || focus_lease
                .as_ref()
                .is_none_or(|lease| focus_broker.mark_submitted(lease));
        let apply_window_focus = native_window_focus_should_apply(
            presentation_current && skipped_surface_count == 0,
            ordered_window_control,
            mutation_plan.apply_window_focus,
            focus_current && focus_submission_current,
        ) && !defer_window_focus_until_reveal;
        let apply_foreground_show = native_window_foreground_show_should_apply(
            window_visibility,
            apply_window_focus,
            defer_window_focus_until_reveal,
        );
        let window_focus_still_current = || {
            focus_lease
                .as_ref()
                .is_none_or(|lease| focus_broker.is_current(lease))
        };
        let window_was_minimized = (apply_window_focus && window_focus_still_current())
            .then(|| window.is_minimized().ok())
            .flatten();
        let mut window_restore_applied = false;
        if native_window_restore_required(
            apply_window_focus && window_focus_still_current(),
            window_was_minimized,
        ) {
            match request_platform_window_restore(&window) {
                Ok(()) => window_restore_applied = true,
                Err(error) => visibility_errors.push(error),
            }
        }
        let mut window_foreground_show_applied = false;
        let mut window_focus_applied = false;
        let mut window_focus_ms = 0_u64;

        let window_visibility_started_at = Instant::now();
        if let Some(visible) = window_visibility {
            if visible {
                if apply_foreground_show && window_focus_still_current() {
                    let focus_started_at = Instant::now();
                    match request_platform_window_show_foreground(&window) {
                        Ok(()) => {
                            window_foreground_show_applied = true;
                            window_focus_applied = true;
                        }
                        Err(error) => {
                            visibility_errors.push(error.message);
                            if let Err(show_error) = request_platform_window_show(&window) {
                                visibility_errors.push(show_error.message);
                            }
                        }
                    }
                    window_focus_ms = window_focus_ms.saturating_add(
                        focus_started_at
                            .elapsed()
                            .as_millis()
                            .min(u64::MAX as u128) as u64,
                    );
                } else if let Err(error) = request_platform_window_show(&window) {
                    visibility_errors.push(error.message);
                }
            } else if let Err(error) = request_platform_window_hide(&window) {
                visibility_errors.push(error.message);
            }
        }
        let window_visibility_ms = window_visibility_started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;

        if let Some(window_mode) = window_mode {
            let mode_result: Result<(), String> = match window_mode {
                NativeWindowMode::Fullscreen => {
                    request_platform_window_set_fullscreen(&window, true)
                }
                NativeWindowMode::Maximized => {
                    request_platform_window_set_maximized(&window, true)
                }
                NativeWindowMode::Minimized => {
                    request_platform_window_minimize(&window)
                }
                NativeWindowMode::ToggleFullscreen => {
                    request_platform_window_toggle_fullscreen(&window)
                }
                NativeWindowMode::ToggleMaximized => {
                    request_platform_window_toggle_maximized(&window)
                }
            };
            if let Err(error) = mode_result {
                visibility_errors.push(error);
            }
        }

        #[cfg(windows)]
        if matches!(window_mode, Some(NativeWindowMode::Minimized)) {
            // Windows game-window minimize is an owning-thread queue
            // submission. Do not synchronously query focus or visibility from
            // this callback before SIZE_MINIMIZED has run; the UI loop cannot
            // process that authoritative event until this callback returns.
            let mutations_complete = visibility_errors.is_empty() && skipped_surface_count == 0;
            let presentation_applied = presentation_current && mutations_complete;
            let applied = (presentation_current || ordered_window_control) && mutations_complete;
            let _ = sender.send(NativePresentationOutcome {
                applied,
                presentation_applied,
                focus_applied: false,
                focus_superseded: false,
                hidden_surface_count,
                hide_ms,
                main_queue_wait_ms,
                main_thread_ms: main_started_at
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
                no_op: false,
                planned_surface_mutation_count,
                shown_surface_count,
                show_ms,
                skipped_surface_count,
                visibility_errors,
                webview_focus_ms: 0,
                window_focused_after: None,
                window_focus_applied: false,
                window_focus_ms,
                window_restore_applied,
                window_visible_after: None,
                window_visibility_ms,
                window_was_minimized,
            });
            return;
        }

        let mut focus_applied = false;
        let window_focus_started_at = Instant::now();
        if apply_window_focus
            && window_focus_still_current()
            && !window_foreground_show_applied
            && matches!(platform_window_is_focused(&window), Ok(false))
        {
            match window.set_focus() {
                Ok(()) => window_focus_applied = true,
                Err(error) => visibility_errors.push(error.to_string()),
            }
        }
        window_focus_ms = window_focus_ms.saturating_add(
            window_focus_started_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        );
        let webview_focus_started_at = Instant::now();
        if presentation_current
            && skipped_surface_count == 0
            && mutation_plan.apply_content_focus
            && focus_current
            && focus_submission_current
            && !defer_window_focus_until_reveal
            && window_focus_still_current()
            && matches!(platform_window_is_focused(&window), Ok(true))
            && let Some(webview) = active_webview
        {
            match webview.set_focus() {
                Ok(()) => focus_applied = true,
                Err(error) => visibility_errors.push(error.to_string()),
            }
        }
        let webview_focus_ms = webview_focus_started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let window_focused_after = if defer_window_focus_until_reveal {
            None
        } else {
            platform_window_is_focused(&window).ok()
        };
        // A retirement hide is intentionally submission-based. Synchronous
        // visibility readback can marshal behind slow WebView2/AppKit teardown
        // and would recreate the last-tab loading delay.
        let window_visible_after = if window_visibility == Some(false)
            || (cfg!(windows) && window_visibility == Some(true))
        {
            None
        } else {
            window.is_visible().ok()
        };
        let focus_superseded = focus_lease.as_ref().is_some_and(|lease| {
            if !focus_broker.is_current(lease)
                || (requested_focus != NativePresentationFocus::None
                    && window_focused_after == Some(false))
            {
                true
            } else {
                let focus_confirmed = match requested_focus {
                    NativePresentationFocus::None => true,
                    NativePresentationFocus::ContentOnly => focus_applied,
                    NativePresentationFocus::WindowAndContent => {
                        window_focused_after == Some(true)
                    }
                };
                if visibility_errors.is_empty() && focus_confirmed {
                    let _ = focus_broker.confirm(lease);
                }
                false
            }
        });
        let mutations_complete = visibility_errors.is_empty() && skipped_surface_count == 0;
        let presentation_applied = presentation_current && mutations_complete;
        let applied = (presentation_current || ordered_window_control)
            && mutations_complete
            && !focus_superseded;
        let _ = sender.send(NativePresentationOutcome {
            applied,
            presentation_applied,
            focus_applied,
            focus_superseded,
            hidden_surface_count,
            hide_ms,
            main_queue_wait_ms,
            main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            no_op: false,
            planned_surface_mutation_count,
            shown_surface_count,
            show_ms,
            skipped_surface_count,
            visibility_errors,
            webview_focus_ms,
            window_focused_after,
            window_focus_applied,
            window_focus_ms,
            window_restore_applied,
            window_visible_after,
            window_visibility_ms,
            window_was_minimized,
        });
    };
    #[cfg(target_os = "macos")]
    let scheduling = crate::runtime_tabs_macos::run_on_appkit_tracking_main(task);
    #[cfg(not(target_os = "macos"))]
    let scheduling = request
        .window
        .run_on_main_thread(task)
        .map_err(|error| error.to_string());
    if let Err(error) = scheduling {
        return NativePresentationOutcome {
            applied: false,
            presentation_applied: false,
            focus_applied: false,
            focus_superseded: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: false,
            planned_surface_mutation_count: 0,
            shown_surface_count: 0,
            show_ms: 0,
            skipped_surface_count: 0,
            visibility_errors: vec![error.to_string()],
            webview_focus_ms: 0,
            window_focused_after: None,
            window_focus_applied: false,
            window_focus_ms: 0,
            window_restore_applied: false,
            window_visible_after: None,
            window_visibility_ms: 0,
            window_was_minimized: None,
        };
    }
    receiver
        .recv()
        .unwrap_or_else(|_| NativePresentationOutcome {
            applied: false,
            presentation_applied: false,
            focus_applied: false,
            focus_superseded: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: false,
            planned_surface_mutation_count: 0,
            shown_surface_count: 0,
            show_ms: 0,
            skipped_surface_count: 0,
            visibility_errors: vec![
                "The native presentation callback was disconnected.".to_owned(),
            ],
            webview_focus_ms: 0,
            window_focused_after: None,
            window_focus_applied: false,
            window_focus_ms: 0,
            window_restore_applied: false,
            window_visible_after: None,
            window_visibility_ms: 0,
            window_was_minimized: None,
        })
}
