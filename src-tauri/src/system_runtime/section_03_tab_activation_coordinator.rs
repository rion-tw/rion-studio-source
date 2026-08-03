#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TabActivationComponentStatus {
    Pending,
    Applied,
    Superseded,
    Failed,
    Indeterminate,
}

#[derive(Clone)]
struct TabActivationTransaction {
    chrome: TabActivationComponentStatus,
    context: NativeOperationContext,
    core: TabActivationComponentStatus,
    presentation: TabActivationComponentStatus,
}

#[derive(Default)]
struct TabActivationCoordinatorState {
    active_by_window: HashMap<String, String>,
    transactions: HashMap<String, TabActivationTransaction>,
}

#[derive(Default)]
struct TabActivationCoordinator {
    state: Mutex<TabActivationCoordinatorState>,
}

impl TabActivationCoordinator {
    fn accept(
        &self,
        context: NativeOperationContext,
        core_required: bool,
    ) -> Result<Option<NativeOperationContext>, &'static str> {
        let window_id = context
            .window_id
            .clone()
            .ok_or("TAB_ACTIVATION_WINDOW_REQUIRED")?;
        let operation_id = context.operation_id.clone();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TAB_ACTIVATION_COORDINATOR_UNAVAILABLE")?;
        let superseded = state
            .active_by_window
            .insert(window_id, operation_id.clone())
            .and_then(|previous_id| state.transactions.remove(&previous_id))
            .map(|previous| previous.context);
        state.transactions.insert(
            operation_id,
            TabActivationTransaction {
                chrome: TabActivationComponentStatus::Pending,
                context,
                core: if core_required {
                    TabActivationComponentStatus::Pending
                } else {
                    TabActivationComponentStatus::Applied
                },
                presentation: TabActivationComponentStatus::Pending,
            },
        );
        Ok(superseded)
    }

    fn record_chrome(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
    ) -> Option<NativeOperationReceipt> {
        self.record_component(operation_id, status, |transaction| &mut transaction.chrome)
    }

    fn record_core(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
    ) -> Option<NativeOperationReceipt> {
        self.record_component(operation_id, status, |transaction| &mut transaction.core)
    }

    fn record_presentation(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
    ) -> Option<NativeOperationReceipt> {
        self.record_component(operation_id, status, |transaction| {
            &mut transaction.presentation
        })
    }

    fn record_component(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
        component: impl FnOnce(&mut TabActivationTransaction) -> &mut TabActivationComponentStatus,
    ) -> Option<NativeOperationReceipt> {
        let mut state = self.state.lock().ok()?;
        let transaction = state.transactions.get_mut(operation_id)?;
        let component_status = component(transaction);
        if *component_status != TabActivationComponentStatus::Pending {
            return None;
        }
        *component_status = status;
        let terminal = Self::terminal_receipt(transaction)?;
        let window_id = transaction.context.window_id.clone();
        state.transactions.remove(operation_id);
        if let Some(window_id) = window_id
            && state
                .active_by_window
                .get(&window_id)
                .is_some_and(|active| active == operation_id)
        {
            state.active_by_window.remove(&window_id);
        }
        Some(terminal)
    }

    fn terminal_receipt(
        transaction: &TabActivationTransaction,
    ) -> Option<NativeOperationReceipt> {
        let components = [
            transaction.presentation,
            transaction.chrome,
            transaction.core,
        ];
        if components.contains(&TabActivationComponentStatus::Pending) {
            return None;
        }
        if components.contains(&TabActivationComponentStatus::Indeterminate) {
            return Some(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "tabActivationIndeterminate",
                NativeOperationStatus::Indeterminate,
                Some("TAB_ACTIVATION_INDETERMINATE"),
            ));
        }
        if transaction.presentation == TabActivationComponentStatus::Failed {
            return Some(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "tabActivationPresentationFailed",
                NativeOperationStatus::Failed,
                Some("TAB_ACTIVATION_PRESENTATION_FAILED"),
            ));
        }
        if components.contains(&TabActivationComponentStatus::Superseded) {
            return Some(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "tabActivationSuperseded",
                NativeOperationStatus::Superseded,
                None,
            ));
        }
        if transaction.chrome == TabActivationComponentStatus::Failed {
            return Some(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "tabActivationChromeDegraded",
                NativeOperationStatus::Degraded,
                Some("TAB_ACTIVATION_CHROME_NOT_CONFIRMED"),
            ));
        }
        if transaction.core == TabActivationComponentStatus::Failed {
            return Some(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "tabActivationStateCommitDegraded",
                NativeOperationStatus::Degraded,
                Some("TAB_ACTIVATION_STATE_COMMIT_FAILED"),
            ));
        }
        Some(NativeOperationReceipt::applied(
            transaction.context.clone(),
            "tabActivationConverged",
        ))
    }
}

fn tab_activation_component_status(
    receipt: &NativeOperationReceipt,
) -> TabActivationComponentStatus {
    match receipt.status {
        NativeOperationStatus::Applied | NativeOperationStatus::Degraded => {
            TabActivationComponentStatus::Applied
        }
        NativeOperationStatus::Superseded | NativeOperationStatus::Cancelled => {
            TabActivationComponentStatus::Superseded
        }
        NativeOperationStatus::Failed => TabActivationComponentStatus::Failed,
        NativeOperationStatus::Indeterminate => TabActivationComponentStatus::Indeterminate,
    }
}

impl SystemRuntimeExecutor {
    fn accept_tab_activation(
        &self,
        window_id: &str,
        tab_id: &str,
        revision: u64,
        trigger: &'static str,
        core_required: bool,
    ) -> Result<NativeOperationContext, String> {
        let window_generation = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.display_hosts.get(window_id).map(|host| host.generation))
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
        let context = NativeOperationContext::new(
            NativeOperationSubsystem::TabActivation,
            trigger,
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope("tabActivationConverged")
        .with_revision(revision)
        .with_window(window_id)
        .with_window_generation(window_generation)
        .with_lifecycle_epoch(self.lifecycle_epoch())
        .with_tab(tab_id);
        self.operations
            .register(context.clone())
            .map_err(str::to_owned)?;
        match self.tab_activations.accept(context.clone(), core_required) {
            Ok(superseded) => {
                if let Some(superseded) = superseded {
                    self.operations.complete(NativeOperationReceipt::with_status(
                        superseded,
                        "tabActivationSuperseded",
                        NativeOperationStatus::Superseded,
                        None,
                    ));
                }
            }
            Err(code) => {
                self.operations.complete(NativeOperationReceipt::with_status(
                    context.clone(),
                    "tabActivationCoordinatorFailed",
                    NativeOperationStatus::Failed,
                    Some(code),
                ));
            }
        }
        Ok(context)
    }

    fn finish_tab_activation_component(
        &self,
        receipt: Option<NativeOperationReceipt>,
    ) {
        if let Some(receipt) = receipt {
            self.operations.complete(receipt);
        }
    }

    fn finish_tab_activation_chrome(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
    ) {
        self.finish_tab_activation_component(
            self.tab_activations.record_chrome(operation_id, status),
        );
    }

    pub(crate) fn finish_tab_activation_core(
        &self,
        operation_id: &str,
        status: TabActivationComponentStatus,
    ) {
        self.finish_tab_activation_component(
            self.tab_activations.record_core(operation_id, status),
        );
    }

    fn track_tab_activation_presentation(
        &self,
        activation_operation_id: String,
        presentation_operation_id: String,
    ) {
        let operations = Arc::clone(&self.operations);
        let activations = Arc::clone(&self.tab_activations);
        let worker_operations = Arc::clone(&operations);
        let worker_activation_id = activation_operation_id.clone();
        let worker = thread::Builder::new()
            .name(format!("rion-tab-activation-{activation_operation_id}"))
            .spawn(move || {
                let status = worker_operations
                    .wait(&presentation_operation_id)
                    .map(|receipt| tab_activation_component_status(&receipt))
                    .unwrap_or(TabActivationComponentStatus::Indeterminate);
                if let Some(receipt) =
                    activations.record_presentation(&worker_activation_id, status)
                {
                    worker_operations.complete(receipt);
                }
            });
        if worker.is_err() {
            self.finish_tab_activation_component(self.tab_activations.record_presentation(
                &activation_operation_id,
                TabActivationComponentStatus::Indeterminate,
            ));
        }
    }
}
