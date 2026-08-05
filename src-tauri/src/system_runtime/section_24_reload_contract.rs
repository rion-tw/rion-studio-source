struct PendingReloadNavigation {
    input_epoch: u64,
    navigation: Arc<NavigationTracker>,
    operation: NativeOperationContext,
    role_id: String,
    surface_generation: u64,
    webview_label: String,
}

fn aggregate_reload_status(statuses: &[NativeOperationStatus]) -> NativeOperationStatus {
    if statuses.is_empty() || statuses.iter().all(|status| *status == NativeOperationStatus::Failed)
    {
        NativeOperationStatus::Failed
    } else if statuses
        .iter()
        .all(|status| *status == NativeOperationStatus::Superseded)
    {
        NativeOperationStatus::Superseded
    } else if statuses
        .iter()
        .all(|status| *status == NativeOperationStatus::Applied)
    {
        NativeOperationStatus::Applied
    } else if statuses.contains(&NativeOperationStatus::Indeterminate) {
        NativeOperationStatus::Indeterminate
    } else {
        NativeOperationStatus::Degraded
    }
}

impl SystemRuntimeExecutor {
    fn reload_tab_contract(self: &Arc<Self>, tab_id: &str) -> RuntimeResult<String> {
        self.require_runtime_accepting()?;
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let targets = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            tab
                .roles
                .iter()
                .map(|(role_id, role)| {
                    (
                        role_id.clone(),
                        role.webview.clone(),
                        Arc::clone(&role.navigation),
                        role.generation,
                    )
                })
                .collect::<Vec<_>>()
        };
        if targets.is_empty() {
            return Err(RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime tab has no role surface.",
            ));
        }

        let aggregate_operation = NativeOperationContext::new(
            NativeOperationSubsystem::Navigation,
            "reloadTab",
            NAVIGATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::InputReady)
        .with_tab(tab_id)
        .with_window(&window_id);
        let aggregate_operation_id = aggregate_operation.operation_id.clone();
        self.operations
            .register(aggregate_operation.clone())
            .map_err(|code| RuntimeError::new(code, "The native operation registry is full."))?;
        self.operations
            .mark_in_flight(&aggregate_operation.operation_id);
        let mut pending = Vec::with_capacity(targets.len());
        let mut immediate_statuses = Vec::new();
        let mut controlled_labels = Vec::new();
        let mut immediate_errors = Vec::new();

        for (role_id, webview, navigation, generation) in targets {
            let label = webview.label().to_owned();
            let operation = NativeOperationContext::new(
                NativeOperationSubsystem::Navigation,
                "reloadRole",
                NAVIGATION_TIMEOUT,
            )
            .with_role(&role_id)
            .with_tab(tab_id)
            .with_window(&window_id)
            .with_surface_generation(generation);
            let setup = (|| -> RuntimeResult<u64> {
                let epoch = self.begin_navigation_input_fence(
                    &label,
                    &role_id,
                    NavigationInputFenceSource::ControlledReload,
                )?;
                self.begin_controlled_navigation(&label)?;
                controlled_labels.push(label.clone());
                navigation.begin_operation(&operation).map_err(|message| {
                    RuntimeError::new("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE", message)
                })?;
                webview.reload().map_err(RuntimeError::tauri)?;
                Ok(epoch)
            })();
            match setup {
                Ok(input_epoch) => pending.push(PendingReloadNavigation {
                    input_epoch,
                    navigation,
                    operation,
                    role_id,
                    surface_generation: generation,
                    webview_label: label,
                }),
                Err(error) => {
                    navigation.reset();
                    self.discard_role_navigation_input_fences(&role_id, "reload-submit-failed");
                    immediate_statuses.push(NativeOperationStatus::Failed);
                    immediate_errors.push(error.message.clone());
                    self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                        operation,
                        "reloadSubmitFailed",
                        NativeOperationStatus::Failed,
                        Some(error.code),
                    ));
                }
            }
        }

        if pending.is_empty() {
            self.finish_controlled_navigations(&controlled_labels);
            self.operations.complete(NativeOperationReceipt::with_status(
                aggregate_operation,
                "reloadTabFailed",
                NativeOperationStatus::Failed,
                Some("SYSTEM_RELOAD_PARTIAL_FAILURE"),
            ));
            let _ = immediate_errors;
            return Ok(aggregate_operation_id);
        }

        let runtime = Arc::clone(self);
        let tab_id = tab_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let mut statuses = immediate_statuses;
            for reload in &pending {
                let receipt = reload
                    .navigation
                    .wait_operation_async(reload.operation.clone())
                    .await;
                let page_status = receipt.status;
                runtime.record_native_operation_receipt(receipt);
                if page_status != NativeOperationStatus::Applied {
                    statuses.push(page_status);
                    continue;
                }
                statuses.push(
                    runtime
                        .wait_reload_input_ready(
                            &reload.role_id,
                            reload.input_epoch,
                            reload.surface_generation,
                            reload.operation.deadline,
                        )
                        .await,
                );
            }
            runtime.finish_controlled_navigations(&controlled_labels);
            let status = aggregate_reload_status(&statuses);
            let failure_code = match status {
                NativeOperationStatus::Applied => None,
                NativeOperationStatus::Superseded => Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                NativeOperationStatus::Indeterminate => {
                    Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE")
                }
                _ => Some("SYSTEM_RELOAD_PARTIAL_FAILURE"),
            };
            runtime.operations.complete(NativeOperationReceipt::with_status(
                aggregate_operation,
                if status == NativeOperationStatus::Applied {
                    "navigationInputReloadReady"
                } else {
                    "navigationInputReloadIncomplete"
                },
                status,
                failure_code,
            ));
            if matches!(
                status,
                NativeOperationStatus::Failed | NativeOperationStatus::Indeterminate
            ) {
                let _ = runtime.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": failure_code.unwrap_or("SYSTEM_RELOAD_PARTIAL_FAILURE"),
                        "message": "The System WebView tab reload did not reach input-ready state.",
                        "tabId": tab_id
                    }),
                );
            }
            for reload in pending {
                if status != NativeOperationStatus::Applied {
                    runtime.reconcile_navigation_input_fence(
                        &reload.webview_label,
                        &reload.role_id,
                        reload.input_epoch,
                        reload.surface_generation,
                    );
                }
            }
        });
        Ok(aggregate_operation_id)
    }

    async fn wait_reload_input_ready(
        &self,
        role_id: &str,
        input_epoch: u64,
        surface_generation: u64,
        deadline: Instant,
    ) -> NativeOperationStatus {
        loop {
            let readiness = match self.state.lock() {
                Ok(state) => {
                    let current_generation = state.role_tabs.get(role_id).and_then(|tab_id| {
                        state
                            .tabs
                            .get(tab_id)
                            .and_then(|tab| tab.roles.get(role_id))
                            .map(|role| role.generation)
                    });
                    if current_generation != Some(surface_generation) {
                        Some(NativeOperationStatus::Superseded)
                    } else if state.last_input_ready_epochs.get(role_id).copied()
                        == Some(input_epoch)
                    {
                        Some(NativeOperationStatus::Applied)
                    } else if state
                        .role_input_fences
                        .get(role_id)
                        .is_some_and(|fence| fence.input_epoch == input_epoch)
                    {
                        None
                    } else {
                        Some(NativeOperationStatus::Superseded)
                    }
                }
                Err(_) => Some(NativeOperationStatus::Indeterminate),
            };
            if let Some(status) = readiness {
                return status;
            }
            if Instant::now() >= deadline {
                return NativeOperationStatus::Failed;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
