#[derive(Clone)]
struct NavigationInputFence {
    role_id: String,
    input_epoch: u64,
    surface_generation: u64,
    baseline_document_id: Option<String>,
    page_finished: bool,
}

#[derive(Clone)]
struct RoleInputFence {
    input_epoch: u64,
    navigation_operation: Option<NativeOperationContext>,
    reason: String,
    started_at: Instant,
    drained: bool,
    surface_generation: u64,
    recovery_scheduled: bool,
    reconciling: bool,
    resuming: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInstanceReadback {
    document_id: Option<String>,
    ready_state: String,
    protocol: String,
}
