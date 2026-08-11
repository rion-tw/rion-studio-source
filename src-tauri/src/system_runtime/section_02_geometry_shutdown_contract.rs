#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeShutdownState {
    Accepting = 0,
    Draining = 1,
    Closed = 2,
    Indeterminate = 3,
}

impl RuntimeShutdownState {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Draining,
            2 => Self::Closed,
            3 => Self::Indeterminate,
            _ => Self::Accepting,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Accepting => "accepting",
            Self::Draining => "draining",
            Self::Closed => "closed",
            Self::Indeterminate => "indeterminate",
        }
    }
}

#[derive(Default)]
struct NativeWindowMutationRegistry {
    issue_gate: NativeWindowMutationLane,
    lanes: Mutex<HashMap<String, Arc<NativeWindowMutationLane>>>,
    latest_revisions: Mutex<HashMap<String, u64>>,
    next_revision: AtomicU64,
}

#[derive(Default)]
struct NativeWindowMutationLane {
    active: Mutex<bool>,
    changed: Condvar,
}

struct NativeWindowMutationPermit<'a> {
    lane: &'a NativeWindowMutationLane,
}

impl NativeWindowMutationLane {
    fn lock(&self) -> Result<NativeWindowMutationPermit<'_>, &'static str> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "SYSTEM_WINDOW_MUTATION_LANE_UNAVAILABLE")?;
        while *active {
            active = self
                .changed
                .wait(active)
                .map_err(|_| "SYSTEM_WINDOW_MUTATION_LANE_UNAVAILABLE")?;
        }
        *active = true;
        Ok(NativeWindowMutationPermit { lane: self })
    }

    fn lock_until(
        &self,
        deadline: Instant,
    ) -> Result<NativeWindowMutationPermit<'_>, &'static str> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "SYSTEM_DISPLAY_TOPOLOGY_LANE_UNAVAILABLE")?;
        while *active {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("SYSTEM_DISPLAY_TOPOLOGY_DEADLINE_EXCEEDED");
            }
            let (next, timeout) = self
                .changed
                .wait_timeout(active, remaining)
                .map_err(|_| "SYSTEM_DISPLAY_TOPOLOGY_LANE_UNAVAILABLE")?;
            active = next;
            if timeout.timed_out() && *active {
                return Err("SYSTEM_DISPLAY_TOPOLOGY_DEADLINE_EXCEEDED");
            }
        }
        *active = true;
        Ok(NativeWindowMutationPermit { lane: self })
    }

    #[cfg(not(windows))]
    fn is_busy(&self) -> bool {
        self.active.lock().map(|active| *active).unwrap_or(true)
    }
}

impl Drop for NativeWindowMutationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.lane.active.lock() {
            *active = false;
            self.lane.changed.notify_all();
        }
    }
}

impl NativeWindowMutationRegistry {
    fn issue(&self, window_id: &str) -> RuntimeResult<(u64, Arc<NativeWindowMutationLane>)> {
        let _guard = self.issue_gate.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_GEOMETRY_APPLY_FAILED",
                "The native window mutation issue gate is unavailable.",
            )
        })?;
        self.issue_under_gate(window_id)
    }

    fn issue_under_gate(
        &self,
        window_id: &str,
    ) -> RuntimeResult<(u64, Arc<NativeWindowMutationLane>)> {
        let revision = self
            .next_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        self.latest_revisions
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_GEOMETRY_APPLY_FAILED",
                    "The native window mutation revision registry is unavailable.",
                )
            })?
            .insert(window_id.to_owned(), revision);
        let lane = self.lane(window_id)?;
        Ok((revision, lane))
    }

    fn lane(&self, window_id: &str) -> RuntimeResult<Arc<NativeWindowMutationLane>> {
        Ok(Arc::clone(
            self.lanes
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_GEOMETRY_APPLY_FAILED",
                        "The native window mutation lane registry is unavailable.",
                    )
                })?
                .entry(window_id.to_owned())
                .or_insert_with(|| Arc::new(NativeWindowMutationLane::default())),
        ))
    }

    fn is_latest(&self, window_id: &str, revision: u64) -> bool {
        self.latest_revisions
            .lock()
            .ok()
            .and_then(|revisions| revisions.get(window_id).copied())
            == Some(revision)
    }

    #[cfg(not(windows))]
    fn is_busy(&self, window_id: &str) -> bool {
        let lane = self
            .lanes
            .lock()
            .ok()
            .and_then(|lanes| lanes.get(window_id).cloned());
        lane.is_some_and(|lane| lane.is_busy())
    }

    fn wait_for_idle(&self, deadline: Instant) -> bool {
        let mut lanes = match self.lanes.lock() {
            Ok(lanes) => lanes
                .iter()
                .map(|(window_id, lane)| (window_id.clone(), Arc::clone(lane)))
                .collect::<Vec<_>>(),
            Err(_) => return false,
        };
        lanes.sort_by(|left, right| left.0.cmp(&right.0));
        let lane_refs = lanes.iter().map(|(_, lane)| Arc::clone(lane)).collect::<Vec<_>>();
        lock_lanes_until_deadline(&lane_refs, deadline).is_ok()
    }

    fn forget(&self, window_id: &str) {
        if let Ok(mut lanes) = self.lanes.lock() {
            lanes.remove(window_id);
        }
        if let Ok(mut revisions) = self.latest_revisions.lock() {
            revisions.remove(window_id);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GeometryTransactionClassification {
    applied: bool,
    native_truth_matches: bool,
    rollback_attempted: bool,
    rollback_error_count: usize,
    superseded: bool,
}

fn geometry_transaction_status(
    classification: GeometryTransactionClassification,
) -> NativeOperationStatus {
    if classification.superseded {
        NativeOperationStatus::Superseded
    } else if classification.rollback_error_count > 0 {
        NativeOperationStatus::Indeterminate
    } else if classification.rollback_attempted || !classification.applied {
        NativeOperationStatus::Failed
    } else if !classification.native_truth_matches {
        NativeOperationStatus::Degraded
    } else {
        NativeOperationStatus::Applied
    }
}
