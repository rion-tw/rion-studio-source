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
    lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    latest_revisions: Mutex<HashMap<String, u64>>,
    next_revision: AtomicU64,
}

impl NativeWindowMutationRegistry {
    fn issue(&self, window_id: &str) -> RuntimeResult<(u64, Arc<Mutex<()>>)> {
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

    fn lane(&self, window_id: &str) -> RuntimeResult<Arc<Mutex<()>>> {
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
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    fn is_latest(&self, window_id: &str, revision: u64) -> bool {
        self.latest_revisions
            .lock()
            .ok()
            .and_then(|revisions| revisions.get(window_id).copied())
            == Some(revision)
    }

    fn is_busy(&self, window_id: &str) -> bool {
        let lane = self
            .lanes
            .lock()
            .ok()
            .and_then(|lanes| lanes.get(window_id).cloned());
        lane.is_some_and(|lane| lane.try_lock().is_err())
    }

    fn wait_for_idle(&self, deadline: Instant) -> bool {
        loop {
            let lanes = match self.lanes.lock() {
                Ok(lanes) => lanes.values().cloned().collect::<Vec<_>>(),
                Err(_) => return false,
            };
            if lanes.iter().all(|lane| lane.try_lock().is_ok()) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(2));
        }
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
