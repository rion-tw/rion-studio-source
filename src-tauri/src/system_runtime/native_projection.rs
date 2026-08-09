use super::*;

/// Native presentation binding derived from a revisioned Kernel projection.
///
/// This module owns projection delivery state only. It must not infer logical
/// membership or launch eligibility from the WebView handles it carries.
#[derive(Clone)]
pub(super) struct SurfacePresentationBinding {
    pub(super) generation: u64,
    pub(super) instance_id: String,
    pub(super) webview: Webview,
}

#[derive(Clone, Default)]
pub(super) struct NativeTabProjectionState {
    pub(super) applied_tab_id: Option<String>,
    pub(super) applied_revision: u64,
    pub(super) host_visibility: bool,
    pub(super) in_flight: bool,
    pub(super) scheduled: bool,
    pub(super) surface_bindings: HashMap<String, Vec<SurfacePresentationBinding>>,
}

/// Forward-only cache of full desired projections and their applied native state.
///
/// `desired_windows` is populated exclusively from `RuntimeKernel::snapshot`.
/// `windows` contains adapter delivery bookkeeping and is never a logical state
/// authority.
#[derive(Default)]
pub(super) struct NativeTabProjectionStore {
    pub(super) desired_windows:
        Mutex<HashMap<String, Arc<RwLock<Option<RuntimeNativeProjection>>>>>,
    pub(super) membership_applied_revision: AtomicU64,
    pub(super) membership_requested_revision: AtomicU64,
    pub(super) membership_retry_running: AtomicBool,
    pub(super) windows: Mutex<HashMap<String, Arc<Mutex<NativeTabProjectionState>>>>,
}
