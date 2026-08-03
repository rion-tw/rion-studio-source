impl SystemRuntimeExecutor {
    fn execute_role_load_effect_async(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        _presentation_revision: u64,
        persist_runtime: bool,
    ) {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        let scope = native_effect_scope(&effect);
        let started = Instant::now();
        let roles = match effect.action {
            CoreEffectAction::EmbeddedLoadRoles { roles } => roles,
            _ => unreachable!("role-load async dispatch only accepts EmbeddedLoadRoles"),
        };
        let pending = match self.start_role_loads(roles) {
            Ok(pending) => pending,
            Err(error) => {
                let error_payload = rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                };
                let result = CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(error_payload.clone()),
                };
                let dispatch = self.core.dispatch_core_effect_results(vec![result]);
                let acknowledgement_status = dispatch
                    .as_ref()
                    .map(|report| effect_acknowledgement_status(report, &effect_id))
                    .unwrap_or("dispatchFailed");
                self.record_effect_outcome_failures(
                    action_name,
                    &effect_id,
                    &operation_id,
                    Some(&error_payload),
                    acknowledgement_status,
                    started.elapsed(),
                    persist_runtime,
                    &scope,
                );
                return;
            }
        };
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let lifecycle_epoch = pending
                .first()
                .map(|pending| pending.lifecycle_epoch)
                .unwrap_or_else(|| runtime.lifecycle_epoch());
            let role_ids = pending
                .iter()
                .map(|pending| pending.role_id.clone())
                .collect::<Vec<_>>();
            let mut navigation_error: Option<(&'static str, String)> = None;
            for pending_navigation in &pending {
                if navigation_error.is_some() {
                    if let Some(operation) = pending_navigation.operation.clone() {
                        pending_navigation.navigation.reset();
                        runtime.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "navigationBatchAborted",
                                NativeOperationStatus::Superseded,
                                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                            ),
                        );
                    }
                    continue;
                }
                if let Some(operation) = pending_navigation.operation.clone() {
                    let receipt = runtime
                        .wait_role_navigation_for_lifecycle(pending_navigation, operation)
                        .await;
                    let status = receipt.status;
                    let failure_code = receipt.failure_code.clone();
                    runtime.record_native_operation_receipt(receipt);
                    if status != NativeOperationStatus::Applied {
                        navigation_error = Some((
                            if status == NativeOperationStatus::Superseded {
                                "SYSTEM_NAVIGATION_SUPERSEDED"
                            } else {
                                "TAURI_NAVIGATION_FAILED"
                            },
                            failure_code.unwrap_or_else(|| {
                                "System WebView navigation did not complete.".to_owned()
                            }),
                        ));
                        continue;
                    }
                }
                runtime.record_runtime_stage(
                    format!("page-finished:{}", pending_navigation.role_id),
                    "completed",
                    started,
                );
            }
            let runtime_for_completion = Arc::clone(&runtime);
            let completion = tauri::async_runtime::spawn_blocking(move || {
                let controlled_labels = pending
                    .iter()
                    .map(|pending| pending.surface.label().to_owned())
                    .collect::<Vec<_>>();
                let result = if let Some((code, message)) = navigation_error {
                    Err(RuntimeError::new(code, message))
                } else if !runtime_for_completion
                    .application_lifecycle_epoch_matches(lifecycle_epoch)
                {
                    Err(RuntimeError::new(
                        "SYSTEM_LIFECYCLE_STALE",
                        "The role navigation was accepted before the current application lifecycle epoch.",
                    ))
                } else {
                    pending.iter().try_for_each(|pending| {
                        runtime_for_completion
                            .require_application_lifecycle_epoch(pending.lifecycle_epoch)?;
                        runtime_for_completion
                            .reassert_role_keys(&pending.role_id, &pending.surface)
                    })
                };
                runtime_for_completion.finish_controlled_navigations(&controlled_labels);
                result
            })
            .await
            .unwrap_or_else(|error| {
                Err(RuntimeError::new(
                    "TAURI_NAVIGATION_FAILED",
                    format!("Navigation completion task failed: {error}"),
                ))
            });
            let mut result = match completion {
                Ok(()) => CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: true,
                    value_json: None,
                    error: None,
                },
                Err(error) => CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(rion_core::CoreErrorPayload {
                        code: error.code.to_owned(),
                        message: error.message,
                    }),
                },
            };
            if result.ok
                && !runtime
                    .application_lifecycle_epoch_matches(lifecycle_epoch)
            {
                result = CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(rion_core::CoreErrorPayload {
                        code: "SYSTEM_LIFECYCLE_STALE".to_owned(),
                        message: "The role navigation completed after its application lifecycle epoch ended."
                            .to_owned(),
                    }),
                };
            }
            if result.ok {
                let tab_ids = runtime
                    .state
                    .lock()
                    .ok()
                    .map(|state| {
                        role_ids
                            .iter()
                            .filter_map(|role_id| state.role_tabs.get(role_id).cloned())
                            .collect::<HashSet<_>>()
                    })
                    .unwrap_or_default();
                for tab_id in tab_ids {
                    runtime.set_launch_phase(&tab_id, LaunchPhase::EssentialReady);
                    runtime.schedule_optional_hydration(&tab_id);
                }
            }
            let persistence_error = (result.ok && persist_runtime)
                .then(|| runtime.persist_restore_session(false).err())
                .flatten();
            result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
            let succeeded = result.ok;
            let error_payload = result.error.clone();
            eprintln!(
                "System WebView effect: {action_name} completed asynchronously (ok={succeeded}, elapsedMs={}).",
                started.elapsed().as_millis()
            );
            let dispatch = runtime.core.dispatch_core_effect_results(vec![result]);
            let acknowledgement_status = dispatch
                .as_ref()
                .map(|report| effect_acknowledgement_status(report, &effect_id))
                .unwrap_or("dispatchFailed");
            runtime.record_effect_outcome_failures(
                action_name,
                &effect_id,
                &operation_id,
                error_payload.as_ref(),
                acknowledgement_status,
                started.elapsed(),
                persist_runtime,
                &scope,
            );
            if dispatch.is_ok() && succeeded && persist_runtime {
                runtime.publish_projection();
            }
        });
    }
}
