use std::collections::HashMap;

use super::{ManagedSurface, RuntimeDisplayHost, RuntimeTab};

/// Owns only non-serializable native handles and their last applied projection metadata.
///
/// Logical membership, role ownership, relaunch eligibility, and persisted settings live in
/// `RuntimeKernel` and must never be inferred from this registry. `RuntimeState` exposes the
/// registry only through the explicit `native_resources` field so every handle lookup remains
/// visible during review and source-hygiene audits.
#[derive(Default)]
pub(super) struct NativeResourceRegistry {
    pub(super) display_hosts: HashMap<String, RuntimeDisplayHost>,
    pub(super) retired_surface_registry: HashMap<String, ManagedSurface>,
    pub(super) surface_registry: HashMap<String, ManagedSurface>,
    pub(super) tabs: HashMap<String, RuntimeTab>,
}
