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
                .and_then(|state| state.role_tabs.get(role_id).cloned()),
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

fn automatic_launch_retry_is_current(state: &RuntimeState, key: &str) -> bool {
    state.automatic_launch_retries.get(key).copied() == Some(1)
        && state
            .provisional_launches
            .get(key)
            .is_some_and(|launch| !launch.cancelled)
}

fn native_surface_mutation_is_current(
    owners: &HashMap<String, SurfacePresentationOwner>,
    expected_revisions: &HashMap<String, u64>,
    surface_label: &str,
    window_id: &str,
) -> bool {
    let expected_revision = expected_revisions
        .get(surface_label)
        .copied()
        .unwrap_or_default();
    match owners.get(surface_label) {
        Some(owner) => owner.window_id == window_id && owner.revision == expected_revision,
        None => expected_revision == 0,
    }
}

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

fn native_window_restore_required(
    apply_window_focus: bool,
    window_was_minimized: Option<bool>,
) -> bool {
    apply_window_focus && window_was_minimized == Some(true)
}

fn presentation_owner_identities(
    surfaces: &[Webview],
    revisions: &HashMap<String, u64>,
) -> HashSet<(String, u64)> {
    surfaces
        .iter()
        .map(|surface| {
            (
                surface.label().to_owned(),
                revisions.get(surface.label()).copied().unwrap_or_default(),
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
    let previous_labels = presentation_surface_labels(&previous_surfaces);
    let next_labels = presentation_surface_labels(&request.next_surfaces);
    let next_surface_mutation_identities =
        presentation_owner_identities(&request.next_surfaces, &request.surface_owner_revisions);
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
    let still_desired = request.coordinator.lock().ok().is_some_and(|selection| {
        selection.revision == request.revision
            && selection.selected_tab_id == request.tab_id
            && selection.surface_identities(request.tab_id.as_deref())
                == request.next_surface_identities
    });
    if !still_desired || !mutation_plan.requires_ui_thread {
        return NativePresentationOutcome {
            applied: still_desired,
            focus_applied: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: still_desired,
            shown_surface_count: 0,
            show_ms: 0,
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
    let requested_at = request.requested_at;
    let revision = request.revision;
    let tab_id = request.tab_id.clone();
    let next_surfaces = request.next_surfaces.clone();
    let surface_owner_revisions = request.surface_owner_revisions.clone();
    let surface_owners = Arc::clone(&request.surface_owners);
    let active_webview = request.active_webview.clone();
    let window = request.window.clone();
    let window_id = request.window_id.clone();
    let window_mode = request.window_mode;
    let window_visibility = request.window_visibility;
    let mutation_plan = mutation_plan.clone();
    let scheduling = request.window.run_on_main_thread(move || {
        let main_started_at = Instant::now();
        let main_queue_wait_ms = requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let still_desired = coordinator.lock().ok().is_some_and(|selection| {
            selection.revision == revision && selection.selected_tab_id == tab_id
        });
        if !still_desired {
            let _ = sender.send(NativePresentationOutcome {
                applied: false,
                focus_applied: false,
                hidden_surface_count: 0,
                hide_ms: 0,
                main_queue_wait_ms,
                main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                no_op: false,
                shown_surface_count: 0,
                show_ms: 0,
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
        let mut shown_surface_count = 0;
        let surface_owners = surface_owners.lock().ok().map(|owners| owners.clone());
        if surface_owners.is_none() {
            visibility_errors.push("The native surface ownership fence is unavailable.".to_owned());
        }
        let hide_started_at = Instant::now();
        if mutation_plan.presentation_changed
            && let Some(surface_owners) = surface_owners.as_ref()
        {
            for surface in previous_surfaces {
                if next_labels.contains(surface.label()) {
                    continue;
                }
                if !native_surface_mutation_is_current(
                    surface_owners,
                    &surface_owner_revisions,
                    surface.label(),
                    &window_id,
                ) {
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
        if mutation_plan.presentation_changed
            && let Some(surface_owners) = surface_owners.as_ref()
        {
            for surface in &next_surfaces {
                if previous_labels.contains(surface.label()) {
                    continue;
                }
                if !native_surface_mutation_is_current(
                    surface_owners,
                    &surface_owner_revisions,
                    surface.label(),
                    &window_id,
                ) {
                    continue;
                }
                match surface.show() {
                    Ok(()) => shown_surface_count += 1,
                    Err(error) => visibility_errors.push(error.to_string()),
                }
            }
        }
        let show_ms = show_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;

        let window_was_minimized = mutation_plan
            .apply_window_focus
            .then(|| window.is_minimized().ok())
            .flatten();
        let mut window_restore_applied = false;
        if native_window_restore_required(
            mutation_plan.apply_window_focus,
            window_was_minimized,
        ) {
            match window.unminimize() {
                Ok(()) => window_restore_applied = true,
                Err(error) => visibility_errors.push(error.to_string()),
            }
        }

        let window_visibility_started_at = Instant::now();
        if let Some(visible) = window_visibility {
            if visible {
                if matches!(window.is_visible(), Ok(false))
                    && let Err(error) = window.show()
                {
                    visibility_errors.push(error.to_string());
                }
            } else if !matches!(window.is_visible(), Ok(false))
                && let Err(error) = window.hide()
            {
                visibility_errors.push(error.to_string());
            }
        }
        let window_visibility_ms = window_visibility_started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;

        if let Some(window_mode) = window_mode {
            let mode_result = match window_mode {
                NativeWindowMode::ExitFullscreen => {
                    if window.is_fullscreen().unwrap_or(false) {
                        window.set_fullscreen(false)
                    } else {
                        Ok(())
                    }
                }
                NativeWindowMode::Fullscreen => {
                    if window.is_fullscreen().unwrap_or(false) {
                        Ok(())
                    } else {
                        window.set_fullscreen(true)
                    }
                }
                NativeWindowMode::Maximized => {
                    if window.is_maximized().unwrap_or(false) {
                        Ok(())
                    } else {
                        window.maximize()
                    }
                }
            };
            if let Err(error) = mode_result {
                visibility_errors.push(error.to_string());
            }
        }

        let mut focus_applied = false;
        let mut window_focus_applied = false;
        let window_focus_started_at = Instant::now();
        if mutation_plan.apply_window_focus && matches!(window.is_focused(), Ok(false)) {
            match window.set_focus() {
                Ok(()) => window_focus_applied = true,
                Err(error) => visibility_errors.push(error.to_string()),
            }
        }
        let window_focus_ms = window_focus_started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let webview_focus_started_at = Instant::now();
        if mutation_plan.apply_content_focus
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
        let window_focused_after = window.is_focused().ok();
        let window_visible_after = window.is_visible().ok();
        let _ = sender.send(NativePresentationOutcome {
            applied: true,
            focus_applied,
            hidden_surface_count,
            hide_ms,
            main_queue_wait_ms,
            main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            no_op: false,
            shown_surface_count,
            show_ms,
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
    });
    if let Err(error) = scheduling {
        return NativePresentationOutcome {
            applied: false,
            focus_applied: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: false,
            shown_surface_count: 0,
            show_ms: 0,
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
            focus_applied: false,
            hidden_surface_count: 0,
            hide_ms: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            no_op: false,
            shown_surface_count: 0,
            show_ms: 0,
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

fn capture_presentation_batch_events(
    batch: &NativePresentationBatch,
    outcome: &NativePresentationOutcome,
    receipt: &NativePresentationReceipt,
) {
    let request = &batch.request;
    let elapsed_ms = request
        .requested_at
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let first_revision = if batch.first_revision == 0 {
        request.revision
    } else {
        batch.first_revision
    };
    let context = json!({
        "coalescedCount": batch.request_count.saturating_sub(1),
        "elapsedMs": elapsed_ms,
        "firstRevision": first_revision,
        "firstRequestAgeMs": batch.first_requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "focusApplied": outcome.focus_applied,
        "focusMode": request.focus.diagnostic_name(),
        "hideMs": outcome.hide_ms,
        "hiddenSurfaceCount": outcome.hidden_surface_count,
        "mainQueueWaitMs": outcome.main_queue_wait_ms,
        "mainThreadMs": outcome.main_thread_ms,
        "noOp": outcome.no_op,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "preCloseTransition": request.trigger.contains("close"),
        "requestCount": batch.request_count,
        "revision": request.revision,
        "receiptAppliedRevision": receipt.applied_revision,
        "receiptStatus": receipt.status.as_str(),
        "receiptSurfaceCount": receipt.surface_identities.len(),
        "showMs": outcome.show_ms,
        "shownSurfaceCount": outcome.shown_surface_count,
        "tabId": request.tab_id,
        "trigger": request.trigger,
        "visibilityErrorCount": outcome.visibility_errors.len(),
        "webViewFocusMs": outcome.webview_focus_ms,
        "windowId": request.window_id,
        "windowFocusedAfter": outcome.window_focused_after,
        "windowFocusApplied": outcome.window_focus_applied,
        "windowFocusMs": outcome.window_focus_ms,
        "windowRestoreApplied": outcome.window_restore_applied,
        "windowVisibleAfter": outcome.window_visible_after,
        "windowVisibilityMs": outcome.window_visibility_ms,
        "windowWasMinimized": outcome.window_was_minimized,
    });
    let completion_event = if !outcome.visibility_errors.is_empty() {
        "native.presentation-failed"
    } else if outcome.applied {
        "native.presentation-completed"
    } else {
        "tab.selection-superseded"
    };
    let completion_message = if !outcome.visibility_errors.is_empty() {
        "Native tab presentation encountered a platform visibility error."
    } else if outcome.applied {
        "Native tab presentation completed on the platform UI thread."
    } else {
        "A stale native tab presentation was discarded before platform mutation."
    };
    let mut entries = vec![
        LogCaptureRecord {
            level: LogLevel::Debug,
            source: LogSource::Browser,
            event: "tab.selection-coalesced".to_owned(),
            message: "Runtime tab selection requests were coalesced into one native batch."
                .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        },
        LogCaptureRecord {
            level: if outcome.visibility_errors.is_empty() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            source: LogSource::Browser,
            event: completion_event.to_owned(),
            message: completion_message.to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: (!outcome.visibility_errors.is_empty()).then(|| LogErrorDetails {
                name: "NATIVE_PRESENTATION_FAILED".to_owned(),
                message: outcome.visibility_errors.join("; "),
                stack: None,
                cause: None,
            }),
        },
    ];
    if outcome.main_queue_wait_ms > 100 || outcome.main_thread_ms > 100 {
        entries.push(LogCaptureRecord {
            level: LogLevel::Warn,
            source: LogSource::Browser,
            event: "native.event-loop-heartbeat-delayed".to_owned(),
            message: "The platform UI-thread presentation exceeded its latency budget.".to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        });
    }
    let core = Arc::clone(&request.core);
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture { entries })
            .await;
    });
}
