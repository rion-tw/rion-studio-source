use super::*;

/// Tauri-side effect executor.
///
/// This type owns native delivery machinery, diagnostics, and handle registries.
/// Logical runtime state belongs to `AppCore`'s `RuntimeKernel`; executor methods
/// may only mutate it through typed intents and must never derive ownership from
/// native handles.
pub struct SystemRuntimeExecutor {
    pub(super) app: AppHandle,
    pub(super) close_effect_senders: OnceLock<Vec<mpsc::SyncSender<ConcurrentRuntimeWork>>>,
    pub(super) configuration: RuntimeWebViewConfiguration,
    pub(super) core: Arc<AppCore>,
    pub(super) critical_activity_sequence: AtomicU64,
    pub(super) effect_sender: OnceLock<Sender<SystemRuntimeWork>>,
    pub(super) lifecycle_sender: OnceLock<Sender<ApplicationLifecycleSignal>>,
    pub(super) diagnostics: Mutex<RuntimeDiagnosticsState>,
    pub(super) health: RuntimeHealth,
    pub(super) focus_broker: Arc<NativeFocusBroker>,
    pub(super) language: Mutex<String>,
    pub(super) resolved_theme: Mutex<String>,
    pub(super) last_performance_diagnostics: Mutex<Option<BrowserPerformanceDiagnosticsRecord>>,
    pub(super) launch_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    pub(super) input_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    pub(super) input_effect_lanes: Mutex<HashMap<String, mpsc::SyncSender<ConcurrentRuntimeWork>>>,
    pub(super) last_critical_activity: Mutex<Instant>,
    pub(super) main_window_actor: Arc<MainWindowActor>,
    pub(super) application_lifecycle: Arc<ApplicationLifecycleCoordinator>,
    pub(super) input_dispatch_lanes: Mutex<HashMap<String, Arc<RoleInputDispatchLane>>>,
    pub(super) input_readiness: InputReadinessRegistry,
    pub(super) native_creation_lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(super) native_creation_slots: NativeCreationGate,
    pub(super) operations: Arc<NativeOperationRegistry>,
    pub(super) native_window_mutations: Arc<NativeWindowMutationRegistry>,
    pub(super) optional_hydration_sender: OnceLock<mpsc::SyncSender<OptionalHydrationWork>>,
    pub(super) optional_idle_changed: Condvar,
    pub(super) pending_window_activation: Mutex<Option<PendingWindowActivation>>,
    pub(super) presentation: Arc<PresentationRegistry>,
    pub(super) projection_metadata: RwLock<RuntimeProjectionMetadata>,
    pub(super) surface_recoveries: SurfaceRecoveryRegistry,
    #[cfg(windows)]
    pub(super) tab_chrome_changed: Condvar,
    pub(super) tab_close_changed: Condvar,
    pub(super) tab_drag_intents: Arc<TabDragIntentCoordinator>,
    pub(super) tab_mutations: Arc<TabMutationCoordinator>,
    #[cfg(windows)]
    pub(super) tab_chrome_projections: Arc<TabChromeProjectionCoordinator>,
    pub(super) prewarm_state: AtomicU8,
    pub(super) retiring_tab_senders: OnceLock<Vec<mpsc::Sender<RetiringTabCleanup>>>,
    pub(super) restore_persist_requested: AtomicU64,
    pub(super) restore_persist_running: AtomicBool,
    pub(super) restore_persist_changed: Condvar,
    pub(super) restore_persist_signal: Mutex<()>,
    pub(super) runtime_projection: RevisionedJsonProjection,
    pub(super) runtime_surface_sequence: AtomicU64,
    pub(super) shortcut_modifier_handoffs: Mutex<HashMap<String, RuntimeShortcutModifierHandoff>>,
    pub(super) self_weak: OnceLock<std::sync::Weak<SystemRuntimeExecutor>>,
    pub(super) shutdown_operation: OnceLock<NativeOperationContext>,
    pub(super) shutdown_state: Arc<AtomicU8>,
    pub(super) state: Mutex<RuntimeState>,
    pub(super) window_state_persistence: WindowStatePersistCoordinator,
    pub(super) user_data_dir: PathBuf,
}

pub(super) struct RuntimeHealth(pub(super) AtomicBool);

impl RuntimeHealth {
    pub(super) fn new() -> Self {
        Self(AtomicBool::new(true))
    }

    pub(super) fn is_healthy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(super) fn mark_unhealthy(&self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(super) enum SystemRuntimeWork {
    Effect {
        action_name: &'static str,
        effect: Box<CoreEffectRequest>,
        presentation_revision: u64,
        persist_runtime: bool,
    },
    RecoverSurface {
        allowed: bool,
        reason: String,
        transaction: Box<SurfaceRecoveryTransaction>,
    },
}

pub(super) struct ConcurrentRuntimeWork {
    pub(super) action_name: &'static str,
    pub(super) effect: CoreEffectRequest,
    pub(super) persist_runtime: bool,
    pub(super) presentation_revision: u64,
}

pub(super) struct OptionalHydrationWork {
    pub(super) tab_id: String,
}
