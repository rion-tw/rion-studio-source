fn accept_navigation_input_operation(
    registry: &NativeOperationRegistry,
    operation: &NativeOperationContext,
) -> RuntimeResult<()> {
    if let Err(code) = registry.register(operation.clone()) {
        registry.record_untracked(NativeOperationReceipt::with_status(
            operation.clone(),
            "navigationInputFenceRejected",
            NativeOperationStatus::Failed,
            Some(code),
        ));
        return Err(RuntimeError::new(
            code,
            "The main-frame navigation was rejected before input state changed.",
        ));
    }
    if registry.mark_in_flight(&operation.operation_id) {
        return Ok(());
    }
    registry.record_untracked(NativeOperationReceipt::with_status(
        operation.clone(),
        "navigationInputFenceRejected",
        NativeOperationStatus::Failed,
        Some("SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE"),
    ));
    Err(RuntimeError::new(
        "SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE",
        "The main-frame navigation operation could not enter the in-flight state.",
    ))
}

fn update_main_frame_navigation_input_fences(
    tickets: &mut HashMap<String, MainFrameNavigationInputFence>,
    webview_label: &str,
    role_id: &str,
    input_epoch: u64,
    surface_generation: u64,
    baseline_document_id: Option<String>,
) {
    for ticket in tickets
        .values_mut()
        .filter(|ticket| ticket.role_id == role_id)
    {
        ticket.input_epoch = input_epoch;
    }
    tickets.insert(
        webview_label.to_owned(),
        MainFrameNavigationInputFence {
            role_id: role_id.to_owned(),
            input_epoch,
            surface_generation,
            baseline_document_id,
            page_finished: false,
        },
    );
}

fn navigation_requires_input_fence(controlled: bool, role_closing: bool) -> bool {
    !controlled && !role_closing
}

fn claim_input_fence_restart_required(
    fences: &mut HashMap<String, RoleInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> Option<u64> {
    let fence = fences.get_mut(role_id)?;
    if fence.input_epoch != input_epoch || fence.recovery_scheduled || fence.restart_required {
        return None;
    }
    fence.restart_required = true;
    fence.resuming = false;
    Some(fence.surface_generation)
}

fn mark_main_frame_navigation_page_finished(
    tickets: &mut HashMap<String, MainFrameNavigationInputFence>,
    webview_label: &str,
    scheme: &str,
) -> Option<(String, u64)> {
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let ticket = tickets.get_mut(webview_label)?;
    ticket.page_finished = true;
    Some((ticket.role_id.clone(), ticket.input_epoch))
}

fn main_frame_navigation_input_is_ready(
    fences: &HashMap<String, RoleInputFence>,
    tickets: &HashMap<String, MainFrameNavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> bool {
    let Some(fence) = fences.get(role_id).filter(|fence| {
        fence.input_epoch == input_epoch
            && fence.drained
            && !fence.recovery_scheduled
            && !fence.restart_required
    }) else {
        return false;
    };
    tickets
        .values()
        .filter(|ticket| ticket.role_id == role_id)
        .all(|ticket| {
            ticket.input_epoch == fence.input_epoch
                && ticket.surface_generation == fence.surface_generation
                && ticket.page_finished
        })
}

fn claim_navigation_input_resume(
    fences: &mut HashMap<String, RoleInputFence>,
    tickets: &HashMap<String, MainFrameNavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> bool {
    if !main_frame_navigation_input_is_ready(fences, tickets, role_id, input_epoch) {
        return false;
    }
    let Some(fence) = fences.get_mut(role_id) else {
        return false;
    };
    if fence.resuming {
        return false;
    }
    fence.resuming = true;
    true
}

fn main_frame_navigation_deadline_is_current(
    fences: &HashMap<String, RoleInputFence>,
    tickets: &HashMap<String, MainFrameNavigationInputFence>,
    webview_label: &str,
    role_id: &str,
    input_epoch: u64,
    surface_generation: u64,
    operation_id: &str,
) -> bool {
    let current_fence = fences.get(role_id).is_some_and(|fence| {
        fence.input_epoch == input_epoch
            && fence.surface_generation == surface_generation
            && fence
                .navigation_operation
                .as_ref()
                .is_some_and(|operation| operation.operation_id == operation_id)
            && !fence.recovery_scheduled
            && !fence.restart_required
    });
    current_fence
        && tickets.get(webview_label).is_some_and(|ticket| {
            ticket.role_id == role_id
                && ticket.input_epoch == input_epoch
                && ticket.surface_generation == surface_generation
                && !ticket.page_finished
        })
}

async fn wait_for_navigation_input_deadline(
    mut cancellation: watch::Receiver<bool>,
    timeout: Duration,
) -> bool {
    if *cancellation.borrow() {
        return false;
    }
    tokio::select! {
        _ = tokio::time::sleep(timeout) => !*cancellation.borrow(),
        _ = cancellation.changed() => false,
    }
}

fn cancel_navigation_input_deadline(fence: &mut RoleInputFence) {
    if let Some(cancellation) = fence.navigation_deadline_cancellation.take() {
        cancellation.send_replace(true);
    }
}

fn read_document_instance(webview: &Webview) -> RuntimeResult<DocumentInstanceReadback> {
    let raw = evaluate_system_webview(
        webview,
        r#"JSON.stringify({
  documentId: typeof globalThis.__rionStudioDocumentInstanceId === "string"
    ? globalThis.__rionStudioDocumentInstanceId
    : null,
  readyState: document.readyState,
  protocol: location.protocol
})"#,
    )?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_INPUT_FENCE_READBACK_INVALID",
            format!("System WebView returned invalid input-fence readback JSON: {error}"),
        )
    })?;
    let value = if let Some(nested) = value.as_str() {
        serde_json::from_str::<Value>(nested).map_err(|error| {
            RuntimeError::new(
                "SYSTEM_INPUT_FENCE_READBACK_INVALID",
                format!("System WebView returned invalid nested input-fence readback JSON: {error}"),
            )
        })?
    } else {
        value
    };
    serde_json::from_value(value).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_INPUT_FENCE_READBACK_INVALID",
            format!("System WebView returned an invalid input-fence readback: {error}"),
        )
    })
}
