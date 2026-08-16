impl SystemRuntimeExecutor {
    async fn apply_event_bound_close(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> RuntimeResult<Option<String>> {
        if effect.completion_policy != OperationCompletionPolicy::EventBound
            || effect.deadline_ms.is_some()
        {
            return Err(RuntimeError::new(
                "SYSTEM_EFFECT_COMPLETION_POLICY_INVALID",
                "Surface close effects must use event-bound completion without a deadline.",
            ));
        }
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        match effect.action {
            CoreEffectAction::EmbeddedDestroyRole { role_id } => {
                self.bind_role_close_operation(&role_id, &operation_id)?;
                if !self
                    .core
                    .core_effect_is_pending(&effect_id, &operation_id)
                    .unwrap_or(false)
                {
                    self.cancel_surface_close_operation(&operation_id);
                    self.clear_surface_close_operation(&operation_id);
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_OPERATION_CANCELLED",
                        "The close effect was cancelled before native isolation began.",
                    ));
                }
                let result = self.destroy_role_event_bound(&role_id).await;
                self.clear_surface_close_operation(&operation_id);
                result.map(|()| None)
            }
            CoreEffectAction::EmbeddedDestroyTab {
                tab_id,
                attempt_generation,
                next_active_tab_id,
            } => {
                let (attempt_is_current, completed_failed_launch_cleanup, runtime_tab_exists) = {
                    let mut state = self.state()?;
                    let attempt_is_current = launch_attempt_is_current(
                        &state,
                        &tab_id,
                        attempt_generation.as_deref(),
                    );
                    let completed = failed_launch_cleanup_has_completed(
                        &state,
                        &tab_id,
                        attempt_generation.as_deref(),
                    );
                    if completed {
                        state.retryable_failed_launches.insert(tab_id.clone());
                    }
                    (attempt_is_current, completed, state.native_resources.tabs.contains_key(&tab_id))
                };
                if !attempt_is_current || completed_failed_launch_cleanup || !runtime_tab_exists {
                    self.record_presentation_event(
                        LogLevel::Debug,
                        "tab.launch-cleanup-compensation-noop",
                        "The event-bound destroy request was already terminal or stale.",
                        "",
                        Some(&tab_id),
                        presentation_revision,
                        "compensation",
                        0,
                    );
                    return Ok(None);
                }
                self.bind_tab_close_operation(&tab_id, &operation_id)?;
                if !self
                    .core
                    .core_effect_is_pending(&effect_id, &operation_id)
                    .unwrap_or(false)
                {
                    self.cancel_surface_close_operation(&operation_id);
                    self.clear_surface_close_operation(&operation_id);
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_OPERATION_CANCELLED",
                        "The close effect was cancelled before native isolation began.",
                    ));
                }
                if self.presentation.tab_window(&tab_id).ok().flatten().is_some() {
                    let _ = self
                        .prepare_destroy_tab_presentation(
                            &tab_id,
                            next_active_tab_id.as_deref(),
                        )
                        .ok();
                }
                let result = self.destroy_tab_event_bound(&tab_id).await;
                self.clear_surface_close_operation(&operation_id);
                result?;
                if let Ok(mut state) = self.state.lock() {
                    state.launch_attempt_generations.remove(&tab_id);
                }
                Ok(None)
            }
            _ => Err(RuntimeError::new(
                "SYSTEM_EFFECT_COMPLETION_POLICY_INVALID",
                "Only native surface destroy effects can enter the close actor.",
            )),
        }
    }

    fn apply(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> RuntimeResult<Option<String>> {
        let parent_operation_id = effect.parent_operation_id.clone();
        match effect.action {
            CoreEffectAction::EmbeddedCreateTab { tab } => {
                let operation_id = effect.operation_id;
                let result = self.create_tab(*tab, &operation_id);
                let event_kind = if result.is_ok() { "attached" } else { "failed" };
                let _ = self.apply_runtime_native_event_for_operation(&operation_id, event_kind);
                result.map(|()| None)
            }
            CoreEffectAction::EmbeddedConfigureRoleSessions { role_ids } => {
                self.require_roles(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedLoadRoles { roles } => {
                self.load_roles(roles)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedInstallOverlays { role_ids } => {
                self.install_overlays(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedFocusRole {
                role_id,
                zoom_factor,
            } => {
                self.focus_role(&role_id, zoom_factor)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyRole { role_id } => {
                self.destroy_role(&role_id)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedClaimRoleSlot { tab_id, slot, role } => {
                self.claim_role_slot_surface(&tab_id, *slot, *role)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyTab {
                tab_id,
                attempt_generation,
                next_active_tab_id,
            } => {
                let (attempt_is_current, completed_failed_launch_cleanup, runtime_tab_exists) = {
                    let mut state = self.state()?;
                    let attempt_is_current = launch_attempt_is_current(
                        &state,
                        &tab_id,
                        attempt_generation.as_deref(),
                    );
                    let completed = failed_launch_cleanup_has_completed(
                        &state,
                        &tab_id,
                        attempt_generation.as_deref(),
                    );
                    if completed {
                        state.retryable_failed_launches.insert(tab_id.clone());
                    }
                    (attempt_is_current, completed, state.native_resources.tabs.contains_key(&tab_id))
                };
                if !attempt_is_current || completed_failed_launch_cleanup || !runtime_tab_exists {
                    self.record_presentation_event(
                        LogLevel::Debug,
                        "tab.launch-cleanup-compensation-noop",
                        if !attempt_is_current {
                            "The destroy request belonged to a stale launch attempt."
                        } else if completed_failed_launch_cleanup {
                            "A failed launch had already completed verified native cleanup."
                        } else {
                            "The runtime tab was already absent, so native destroy was idempotent."
                        },
                        "",
                        Some(&tab_id),
                        presentation_revision,
                        "compensation",
                        0,
                    );
                } else {
                    // A visible close already removed the tab from LiveWindowTabStore and
                    // presented its successor. A late Core owner-cleanup effect must not run
                    // a second UI preflight against the now-absent tab.
                    if self.presentation.tab_window(&tab_id).ok().flatten().is_some() {
                        let _ = self
                            .prepare_destroy_tab_presentation(
                                &tab_id,
                                next_active_tab_id.as_deref(),
                            )
                            .ok();
                    }
                    self.destroy_tab(&tab_id)?;
                    if let Ok(mut state) = self.state.lock() {
                        state.launch_attempt_generations.remove(&tab_id);
                    }
                }
                Ok(None)
            }
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                roles,
                target,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            } => {
                self.apply_runtime(
                    roles,
                    target,
                    &reveal_window_ids,
                    &focus_window_ids,
                    focus_tab_id.as_deref(),
                    RuntimeEffectCorrelation {
                        parent_operation_id,
                        presentation_revision,
                    },
                )?;
                Ok(None)
            }
            CoreEffectAction::RoleBrowserDataClearSession {
                role_id,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => self.clear_role_browser_data_contract(
                &role_id,
                &webview2_user_data_dir,
                &webkit_data_store_identifier,
            ),
            CoreEffectAction::ChromeProfileImportSnapshot {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => self.snapshot_role_session_contract(
                &transaction_id,
                RoleSessionContractTarget::new(
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                ),
                replace_existing,
            ),
            CoreEffectAction::ChromeProfileImportApply {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => self.apply_role_session_contract(
                transaction_id,
                RoleSessionContractTarget::new(
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                ),
                replace_existing,
            ),
            CoreEffectAction::ChromeProfileImportVerify {
                role_id,
                verification_url,
                authenticated_path,
                login_path,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => self.verify_role_session_contract(
                RoleSessionContractTarget::new(
                    &role_id,
                    &verification_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                ),
                &authenticated_path,
                &login_path,
            ),
            CoreEffectAction::ChromeProfileImportRollback {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => self.rollback_role_session_contract(
                &transaction_id,
                RoleSessionContractTarget::new(
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                ),
            ),
            CoreEffectAction::ChromeProfileImportCommit { transaction_id } => {
                self.commit_role_session_contract(&transaction_id)
            }
            CoreEffectAction::OverlayOpenMacroPage { role_id } => {
                let request = json!({ "roleId": role_id });
                {
                    self.state()?.pending_macro_page_request = Some(request.clone());
                }
                let operation_id =
                    self.request_main_window_show(true, "overlay-open-macro-page")?;
                self.observe_main_window_presentation(operation_id);
                let dispatch_app = self.app.clone();
                let window_app = dispatch_app.clone();
                dispatch_app
                    .run_on_main_thread(move || {
                        let _ = window_app.emit("rion://macro-page-request", request);
                    })
                    .map_err(RuntimeError::tauri)?;
                Ok(None)
            }
            CoreEffectAction::OverlayCopyCoordinate { coordinate } => {
                crate::native_shell::copy_text(&format!(
                    "X: {}px ({}%), Y: {}px ({}%), Anchor: {}, ReferenceViewport: {}x{}px, CSS: X {}px, Y {}px, Viewport: {}x{}px, Zoom: {}%",
                    coordinate.x_reference_px,
                    coordinate.x_percent,
                    coordinate.y_reference_px,
                    coordinate.y_percent,
                    coordinate.anchor,
                    coordinate.reference_viewport_width_px,
                    coordinate.reference_viewport_height_px,
                    coordinate.x_px,
                    coordinate.y_px,
                    coordinate.viewport_width_px,
                    coordinate.viewport_height_px,
                    format_page_zoom_percent(coordinate.applied_page_zoom)
                ))
                .map_err(|message| RuntimeError::new("SHELL_CLIPBOARD_FAILED", message))?;
                Ok(None)
            }
            CoreEffectAction::BrowserAction { request } => self.browser_action(*request),
        }
    }

    fn browser_action(&self, request: BrowserActionRequest) -> RuntimeResult<Option<String>> {
        if request.request_id.is_empty() || request.role_id.is_empty() {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_INVALID",
                "Browser action identifiers are required.",
            ));
        }
        if !matches!(request.intent.as_str(), "normal" | "cleanup") {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_INVALID",
                "Browser action intent is invalid.",
            ));
        }
        let started = Instant::now();
        let diagnostic = browser_action_diagnostic_context(&request.action);
        let native_stage = match &request.action {
            BrowserAction::Focus => "inputFocus",
            BrowserAction::Key { .. } => "inputKey",
            BrowserAction::Click { .. } => "inputClick",
        };
        let request_id = request.request_id.clone();
        let role_id = request.role_id.clone();
        let input_epoch = request.input_epoch;
        let intent = request.intent.clone();
        let scheduled_at_ms = request.scheduled_at_ms;
        let deadline_ms = request.deadline_ms;
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let mut native_operation = NativeOperationContext::new(
            NativeOperationSubsystem::Input,
            "browserAction",
            Duration::from_millis(deadline_ms.saturating_sub(now_ms))
                .min(PLATFORM_CALLBACK_TIMEOUT),
        )
        .with_completion_scope(if native_stage == "inputFocus" {
            SystemRuntimeOperationCompletionScope::InputReady
        } else {
            SystemRuntimeOperationCompletionScope::NativeSubmission
        })
        .with_role(&role_id);
        let result = (|| {
            let context = self.input_dispatch_context(&request)?;
            native_operation.surface_generation = Some(context.surface_generation);
            self.with_input_context_lane(&context, || match request.action {
                BrowserAction::Focus => {
                    // Native key and mouse delivery targets the role WebView directly. Focus is
                    // therefore an event-fenced page-readiness check, not permission to blur the
                    // game canvas or replace the foreground role's AppKit first responder.
                    self.wait_for_role_input_focus(&role_id, &context)
                        .map(|()| None)
                }
                BrowserAction::Key {
                    phase,
                    key,
                    code,
                    modifiers,
                    owner_id,
                    suppress_overlay_shortcut: _,
                } => {
                    let code = code.filter(|value| !value.is_empty()).unwrap_or(key);
                    self.dispatch_key_action_in_lane(
                        &role_id,
                        &phase,
                        &code,
                        &modifiers,
                        &owner_id,
                        &context,
                    )?;
                    Ok(None)
                }
                BrowserAction::Click {
                    anchor,
                    unit,
                    x,
                    y,
                    button,
                } => {
                    let click = ClickActionDispatch {
                        anchor: anchor.as_deref(),
                        unit: &unit,
                        x,
                        y,
                        button: &button,
                    };
                    self.dispatch_click_action_in_lane(&role_id, &click, &context)?;
                    Ok(None)
                }
            })
        })();
        self.record_macro_browser_action_result(
            &request_id,
            &role_id,
            input_epoch,
            &intent,
            scheduled_at_ms,
            deadline_ms,
            diagnostic,
            started,
            &result,
        );
        let receipt = match result.as_ref() {
            Ok(_) => NativeOperationReceipt::applied(native_operation, native_stage),
            Err(error)
                if matches!(error.code, "BROWSER_ACTION_STALE" | "BROWSER_ACTION_DEADLINE") =>
            {
                NativeOperationReceipt::with_status(
                    native_operation,
                    native_stage,
                    NativeOperationStatus::Superseded,
                    Some(error.code),
                )
            }
            Err(error) if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" => {
                NativeOperationReceipt::with_status(
                    native_operation,
                    native_stage,
                    NativeOperationStatus::Indeterminate,
                    Some(error.code),
                )
            }
            Err(error) => NativeOperationReceipt::with_status(
                native_operation,
                native_stage,
                NativeOperationStatus::Failed,
                Some(error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn dispatch_key_action_in_lane(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        context.ensure_current()?;
        let webview = self.role_webview_for_input(role_id, context)?;
        let modifier_codes = resolve_modifier_codes(modifiers, cfg!(target_os = "macos"))?;
        let transition =
            self.prepare_key_transition(role_id, phase, code, modifier_codes, owner_id)?;
        let mut executed = Vec::new();
        let dispatch_result: RuntimeResult<()> = transition.effects.iter().try_for_each(|effect| {
            context.ensure_current()?;
            self.dispatch_guarded_macro_key_effect(role_id, &webview, effect, context)?;
            executed.push(effect.clone());
            Ok(())
        });
        match dispatch_result {
            Ok(()) => {
                if let Err(error) = self.complete_key_transition(&transition, true) {
                    self.compensate_key_prefix(role_id, &webview, &executed, context);
                    let _ = self.complete_key_transition(&transition, false);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                    self.quarantine_role_input(role_id, &error);
                }
                self.compensate_key_prefix(role_id, &webview, &executed, context);
                let _ = self.complete_key_transition(&transition, false);
                Err(error)
            }
        }
    }

    fn with_role_input_lane<T>(
        &self,
        role_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let lane = self.role_input_lane(role_id)?;
        let _guard = lane.sequence.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input lane is unavailable.",
            )
        })?;
        operation()
    }

    fn role_input_lane(&self, role_id: &str) -> RuntimeResult<Arc<RoleInputDispatchLane>> {
        let mut lanes = self.input_dispatch_lanes.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input coordinator is unavailable.",
            )
        })?;
        Ok(Arc::clone(
            lanes.entry(role_id.to_owned()).or_default(),
        ))
    }

    fn input_dispatch_context(
        &self,
        request: &BrowserActionRequest,
    ) -> RuntimeResult<InputDispatchContext> {
        if request.intent == "normal" && browser_action_deadline_expired(request.deadline_ms) {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let monotonic_deadline = Instant::now()
            .checked_add(
                Duration::from_millis(request.deadline_ms.saturating_sub(now_ms))
                    .min(PLATFORM_CALLBACK_TIMEOUT),
            )
            .unwrap_or_else(Instant::now);
        let surface_generation = {
            let state = self.state()?;
            let tab_id = state.native_tab_id_for_role_surface(&request.role_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
            })?;
            if request.intent == "normal"
                && (state.close_coordinator.closing_roles.contains(&request.role_id)
                    || state
                        .close_coordinator
                        .quarantined_roles
                        .contains(&request.role_id))
            {
                return Err(RuntimeError::new(
                    "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                    "The role is closing or quarantined and cannot accept automatic input.",
                ));
            }
            state
                .native_resources.tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&request.role_id))
                .map(|surface| surface.generation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found.",
                    )
                })?
        };
        let lane = self.role_input_lane(&request.role_id)?;
        let current_epoch = lane.epoch.load(Ordering::Acquire);
        if request.input_epoch < current_epoch {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete role input epoch.",
            ));
        }
        if request.input_epoch > current_epoch {
            lane.epoch.store(request.input_epoch, Ordering::Release);
        }
        let known_generation = lane.surface_generation.load(Ordering::Acquire);
        if known_generation == 0 {
            lane.surface_generation
                .store(surface_generation, Ordering::Release);
        } else if known_generation != surface_generation {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action resolved after its System WebView surface changed.",
            ));
        }
        let context = InputDispatchContext {
            deadline: monotonic_deadline,
            input_epoch: request.input_epoch,
            intent: request.intent.clone(),
            lane,
            surface_generation,
        };
        context.ensure_current()?;
        Ok(context)
    }

    fn current_input_context(
        &self,
        role_id: &str,
        intent: &str,
    ) -> RuntimeResult<InputDispatchContext> {
        let lane = self.role_input_lane(role_id)?;
        let surface_generation = {
            let state = self.state()?;
            let tab_id = state.native_tab_id_for_role_surface(role_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
            })?;
            state
                .native_resources.tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .map(|surface| surface.generation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found.",
                    )
                })?
        };
        if lane.surface_generation.load(Ordering::Acquire) == 0 {
            lane.surface_generation
                .store(surface_generation, Ordering::Release);
        }
        let context = InputDispatchContext {
            deadline: Instant::now() + PLATFORM_CALLBACK_TIMEOUT,
            input_epoch: lane.epoch.load(Ordering::Acquire),
            intent: intent.to_owned(),
            lane,
            surface_generation,
        };
        context.ensure_current()?;
        Ok(context)
    }

    fn cleanup_input_context(&self, context: &InputDispatchContext) -> InputDispatchContext {
        InputDispatchContext {
            deadline: Instant::now() + PLATFORM_CALLBACK_TIMEOUT,
            // A navigation or close fence can advance while mouseDown/keyDown is being
            // confirmed. Cleanup is the only work allowed to adopt that newer epoch; the
            // original normal action remains permanently stale.
            input_epoch: context.lane.epoch.load(Ordering::Acquire),
            intent: "cleanup".to_owned(),
            lane: Arc::clone(&context.lane),
            surface_generation: context.surface_generation,
        }
    }

    fn role_webview_for_input(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<Webview> {
        context.ensure_current()?;
        let state = self.state()?;
        if !context.is_cleanup()
            && (state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id))
        {
            return Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                "The role is closing or quarantined and cannot accept automatic input.",
            ));
        }
        let tab_id = state.native_tab_id_for_role_surface(role_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
        })?;
        state
            .native_resources.tabs
            .get(tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .filter(|surface| surface.generation == context.surface_generation)
            .map(|surface| surface.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "BROWSER_ACTION_STALE",
                    "The System WebView surface changed before input dispatch.",
                )
            })
    }

    fn compensate_key_prefix(
        &self,
        role_id: &str,
        webview: &Webview,
        executed: &[EmbeddedKeyEffectRecord],
        context: &InputDispatchContext,
    ) {
        let cleanup = self.cleanup_input_context(context);
        for effect in key_prefix_compensation(executed) {
            if let Err(error) =
                self.dispatch_guarded_macro_key_effect(role_id, webview, &effect, &cleanup)
            {
                self.quarantine_role_input(role_id, &error);
                break;
            }
        }
    }

    fn dispatch_click_action_in_lane(
        &self,
        role_id: &str,
        click: &ClickActionDispatch<'_>,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview_for_input(role_id, context)?;
        let (viewport, applied_page_zoom) = if click.unit == "reference-px" {
            let zoom_before_viewport = platform_page_zoom(&webview)?;
            context.ensure_current()?;
            let viewport = self.devtools_viewport(&webview)?;
            context.ensure_current()?;
            let zoom_after_viewport = platform_page_zoom(&webview)?;
            context.ensure_current()?;
            if (zoom_before_viewport - zoom_after_viewport).abs() > 1e-9 {
                return Err(RuntimeError::new(
                    "BROWSER_ACTION_STALE",
                    "The page zoom changed while the reference-pixel click was resolved.",
                ));
            }
            (viewport, zoom_after_viewport)
        } else {
            let viewport = self.devtools_viewport(&webview)?;
            context.ensure_current()?;
            (viewport, 1.0)
        };
        let point = resolve_click_point(
            click.anchor,
            click.unit,
            click.x,
            click.y,
            viewport,
            applied_page_zoom,
        )?;
        let button = validate_mouse_button(click.button)?;
        self.record_macro_click_resolution(
            role_id,
            webview.label(),
            click,
            viewport,
            point,
            context,
        );
        match dispatch_mouse_click_sequence(
            &webview,
            viewport,
            point,
            button,
            context,
            || self.cleanup_input_context(context),
        ) {
            Ok(diagnostics) => {
                self.record_macro_click_submission(
                    role_id,
                    webview.label(),
                    context,
                    diagnostics,
                    true,
                    None,
                    None,
                );
            }
            Err(error) => {
                self.record_macro_click_submission(
                    role_id,
                    webview.label(),
                    context,
                    error.diagnostics,
                    error.down_confirmed,
                    Some(error.action.code),
                    error.cleanup.as_ref().map(|cleanup| cleanup.code),
                );
                if let Some(cleanup_error) = error.cleanup.as_ref() {
                    self.quarantine_role_input(role_id, cleanup_error);
                } else if error.down_confirmed {
                    self.quarantine_role_input(role_id, &error.action);
                }
                return Err(error.action);
            }
        }
        Ok(())
    }

    fn devtools_viewport(&self, webview: &Webview) -> RuntimeResult<ViewportSize> {
        if let Ok(result) = call_system_devtools(webview, "Page.getLayoutMetrics", &json!({}))
            && let Some(viewport) = parse_devtools_viewport(&result)
        {
            return Ok(viewport);
        }
        let result = self.evaluate_webview(
            webview,
            "({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) })",
        )?;
        parse_evaluated_viewport(&result).ok_or_else(|| {
            RuntimeError::new(
                "BROWSER_VIEWPORT_UNAVAILABLE",
                "System WebView viewport size is unavailable.",
            )
        })
    }

    fn prepare_key_transition(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: Vec<String>,
        owner_id: &str,
    ) -> RuntimeResult<EmbeddedKeyTransitionRecord> {
        self.core
            .prepare_embedded_key_transition(
                role_id,
                phase,
                code,
                &modifier_codes,
                owner_id,
            )
            .map_err(RuntimeError::core)
    }

    fn complete_key_transition(
        &self,
        transition: &EmbeddedKeyTransitionRecord,
        succeeded: bool,
    ) -> RuntimeResult<()> {
        let Some(transition_id) = &transition.transition_id else {
            return Ok(());
        };
        self.core
            .complete_embedded_key_transition(transition_id, succeeded)
            .map_err(RuntimeError::core)
    }

    fn reassert_role_keys(&self, role_id: &str, _webview: &Webview) -> RuntimeResult<()> {
        if !cfg!(windows) {
            return Ok(());
        }
        let context = self.current_input_context(role_id, "normal")?;
        self.with_input_context_lane(&context, || {
            self.reassert_role_keys_in_lane(role_id, &context)
        })
    }

    fn reassert_role_keys_in_lane(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        self.reassert_role_keys_matching_in_lane(role_id, context, |_| true)
    }

    fn reassert_role_keys_matching_in_lane(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
        should_dispatch: impl Fn(&str) -> bool,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview_for_input(role_id, context)?;
        let transition = self
            .core
            .reassert_embedded_keys(role_id)
            .map_err(RuntimeError::core)?;
        let mut executed = Vec::new();
        let result: RuntimeResult<()> = transition
            .effects
            .iter()
            .filter(|effect| should_dispatch(&effect.code))
            .try_for_each(|effect| {
                self.dispatch_guarded_macro_key_effect(role_id, &webview, effect, context)?;
                executed.push(effect.clone());
                Ok(())
            });
        if let Err(error) = result {
            let cleanup = self.cleanup_input_context(context);
            for effect in release_reasserted_key_effects(&executed) {
                if let Err(cleanup_error) =
                    self.dispatch_guarded_macro_key_effect(
                        role_id,
                        &webview,
                        &effect,
                        &cleanup,
                    )
                {
                    self.quarantine_role_input(role_id, &cleanup_error);
                    break;
                }
            }
            if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                self.quarantine_role_input(role_id, &error);
            }
            return Err(error);
        }
        Ok(())
    }

    fn clear_role_keys(&self, role_id: &str) {
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::EmbeddedKeysClear { role_id })
                .await;
        });
    }
}

fn format_page_zoom_percent(zoom: f64) -> String {
    format!("{:.2}", zoom * 100.0)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}
