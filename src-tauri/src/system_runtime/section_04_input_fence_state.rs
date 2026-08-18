#[derive(Clone)]
struct MainFrameNavigationInputFence {
    role_id: String,
    input_epoch: u64,
    surface_generation: u64,
    baseline_document_id: Option<String>,
    page_finished: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NavigationInputFenceSource {
    MainFrame,
    ControlledReload,
}

impl NavigationInputFenceSource {
    const fn trigger(self) -> &'static str {
        match self {
            Self::MainFrame => "mainFrameNavigationInputFence",
            Self::ControlledReload => "controlledReloadInputFence",
        }
    }

    const fn reason(self) -> &'static str {
        match self {
            Self::MainFrame => "main-frame-navigation",
            Self::ControlledReload => "controlled-reload",
        }
    }
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
    restart_required: bool,
    macro_recovery_id: Option<String>,
    pending_macro_restart_count: u32,
    resuming: bool,
}

#[derive(Clone)]
struct MacroInputRecoveryRuntimeState {
    evidence: MacroInputRecoveryEvidence,
    input_epoch: u64,
    pending_macro_restart_count: u32,
    recovery_id: String,
    surface_generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacroInputRecoveryEvidence {
    CleanupConfirmed,
    DocumentReplacementPending,
    DocumentReplaced,
    Unproven,
}

impl MacroInputRecoveryEvidence {
    const fn permits_in_place_resume(self) -> bool {
        matches!(self, Self::CleanupConfirmed | Self::DocumentReplaced)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInstanceReadback {
    document_id: Option<String>,
    ready_state: String,
    protocol: String,
}
