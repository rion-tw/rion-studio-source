const TAB_SELECTION_COMMIT_DEBOUNCE: Duration = Duration::from_millis(150);
const TAB_SELECTION_COMMIT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const TAB_SELECTION_COMMIT_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone, Default)]
struct TabSelectionCommitCoordinator {
    next_generation: Arc<AtomicU64>,
    workers: Arc<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
}

struct TabSelectionCommitWorker {
    generation: u64,
    sender: tokio::sync::watch::Sender<TabSelectionCommitRequest>,
}

#[derive(Clone)]
struct TabSelectionCommitRequest {
    activation_operation_id: Option<String>,
    app: AppHandle,
    core: Arc<AppCore>,
    runtime: Arc<SystemRuntimeExecutor>,
    tab_id: String,
    window_id: String,
    selection_revision: u64,
}

impl TabSelectionCommitCoordinator {
    fn request(&self, request: TabSelectionCommitRequest) -> Result<(), String> {
        let window_id = request.window_id.clone();
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| "tab selection commit coordinator lock poisoned".to_owned())?;
        if let Some(worker) = workers.get(&window_id)
            && worker.sender.send(request.clone()).is_ok()
        {
            return Ok(());
        }
        let (sender, receiver) = tokio::sync::watch::channel(request);
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        workers.insert(
            window_id.clone(),
            TabSelectionCommitWorker { generation, sender },
        );
        tauri::async_runtime::spawn(run_tab_selection_commit_worker(
            receiver,
            Arc::downgrade(&self.workers),
            window_id,
            generation,
        ));
        Ok(())
    }
}

async fn run_tab_selection_commit_worker(
    mut receiver: tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
    workers: std::sync::Weak<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
    window_id: String,
    generation: u64,
) {
    loop {
        let request = receiver.borrow_and_update().clone();
        tokio::time::sleep(TAB_SELECTION_COMMIT_DEBOUNCE).await;
        match receiver.has_changed() {
            Ok(true) => {
                finish_tab_selection_commit(
                    &request,
                    TabActivationComponentStatus::Superseded,
                );
                continue;
            }
            Ok(false) => {}
            Err(_) => {
                if retire_tab_selection_commit_worker(
                    &workers,
                    &window_id,
                    generation,
                    &receiver,
                ) {
                    return;
                }
                continue;
            }
        }
        if !request.runtime.tab_selection_is_desired(
            &request.window_id,
            &request.tab_id,
            request.selection_revision,
        ) {
            finish_tab_selection_commit(
                &request,
                TabActivationComponentStatus::Superseded,
            );
            if !wait_for_tab_selection_commit_request(&mut receiver).await {
                if retire_tab_selection_commit_worker(
                    &workers,
                    &window_id,
                    generation,
                    &receiver,
                ) {
                    return;
                }
                continue;
            }
            continue;
        }
        let command = || CoreCommand::EmbeddedTabActivateConditional {
            tab_id: request.tab_id.clone(),
            window_id: request.window_id.clone(),
            selection_revision: request.selection_revision,
        };
        let mut result = Arc::clone(&request.core).invoke_async(command()).await;
        if !tab_selection_commit_matches(&result, &request)
            && !receiver.has_changed().unwrap_or(false)
        {
            tokio::time::sleep(TAB_SELECTION_COMMIT_RETRY_DELAY).await;
            if !receiver.has_changed().unwrap_or(false)
                && request.runtime.tab_selection_is_desired(
                    &request.window_id,
                    &request.tab_id,
                    request.selection_revision,
                )
            {
                result = Arc::clone(&request.core).invoke_async(command()).await;
            }
        }
        let changed = receiver.has_changed().unwrap_or(false);
        let desired = request.runtime.tab_selection_is_desired(
            &request.window_id,
            &request.tab_id,
            request.selection_revision,
        );
        if changed || !desired {
            finish_tab_selection_commit(
                &request,
                TabActivationComponentStatus::Superseded,
            );
        } else if tab_selection_commit_matches(&result, &request) {
            finish_tab_selection_commit(&request, TabActivationComponentStatus::Applied);
        } else {
            request.runtime.reconcile_tab_activation(&request.window_id);
            let error = result
                .err()
                .map(|error| error.payload())
                .unwrap_or_else(|| {
                    shell_error(
                        "TAB_ACTIVATION_STATE_COMMIT_FAILED",
                        "The active tab metadata did not converge after retrying.",
                    )
                });
            reveal_shell_error(&request.app, error);
            finish_tab_selection_commit(&request, TabActivationComponentStatus::Failed);
        }
        if !wait_for_tab_selection_commit_request(&mut receiver).await
            && retire_tab_selection_commit_worker(
                &workers,
                &window_id,
                generation,
                &receiver,
            )
        {
            return;
        }
    }
}

fn tab_selection_commit_matches(
    result: &Result<Value, rion_core::CoreError>,
    request: &TabSelectionCommitRequest,
) -> bool {
    result.as_ref().ok().is_some_and(|snapshot| {
        snapshot
            .get("windows")
            .and_then(Value::as_array)
            .and_then(|windows| {
                windows.iter().find(|window| {
                    window.get("windowId").and_then(Value::as_str)
                        == Some(request.window_id.as_str())
                })
            })
            .and_then(|window| window.get("activeTabId"))
            .and_then(Value::as_str)
            == Some(request.tab_id.as_str())
    })
}

fn finish_tab_selection_commit(
    request: &TabSelectionCommitRequest,
    status: TabActivationComponentStatus,
) {
    if let Some(operation_id) = request.activation_operation_id.as_deref() {
        request
            .runtime
            .finish_tab_activation_core(operation_id, status);
    }
}

async fn wait_for_tab_selection_commit_request(
    receiver: &mut tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
) -> bool {
    matches!(
        tokio::time::timeout(TAB_SELECTION_COMMIT_IDLE_TIMEOUT, receiver.changed()).await,
        Ok(Ok(()))
    )
}

fn retire_tab_selection_commit_worker(
    workers: &std::sync::Weak<Mutex<HashMap<String, TabSelectionCommitWorker>>>,
    window_id: &str,
    generation: u64,
    receiver: &tokio::sync::watch::Receiver<TabSelectionCommitRequest>,
) -> bool {
    let Some(workers) = workers.upgrade() else {
        return true;
    };
    let Ok(mut workers) = workers.lock() else {
        return true;
    };
    if !workers
        .get(window_id)
        .is_some_and(|worker| worker.generation == generation)
    {
        return true;
    }
    // request() holds this same map lock while publishing. Recheck the receiver only after
    // acquiring it so an activation arriving on the idle-timeout boundary is either consumed by
    // this worker or observes the removed entry and creates a replacement worker.
    if receiver.has_changed().unwrap_or(false) {
        return false;
    }
    workers.remove(window_id);
    true
}
