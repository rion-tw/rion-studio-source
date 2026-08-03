struct NativeCreationGate {
    active: Mutex<usize>,
    changed: Condvar,
    limit: usize,
}

impl NativeCreationGate {
    fn new(limit: usize) -> Self {
        Self {
            active: Mutex::new(0),
            changed: Condvar::new(),
            limit,
        }
    }

    fn acquire(&self) -> RuntimeResult<NativeCreationPermit<'_>> {
        let mut active = self.active.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                "The native surface creation gate is unavailable.",
            )
        })?;
        while *active >= self.limit {
            active = self.changed.wait(active).map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                    "The native surface creation gate is unavailable.",
                )
            })?;
        }
        *active += 1;
        Ok(NativeCreationPermit { gate: self })
    }

    fn wait_for_idle(&self, deadline: Instant) -> bool {
        let Ok(mut active) = self.active.lock() else {
            return false;
        };
        while *active > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, timeout)) = self.changed.wait_timeout(active, remaining) else {
                return false;
            };
            active = next;
            if timeout.timed_out() && *active > 0 {
                return false;
            }
        }
        true
    }
}

struct NativeCreationPermit<'a> {
    gate: &'a NativeCreationGate,
}

impl Drop for NativeCreationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.gate.active.lock() {
            *active = active.saturating_sub(1);
            self.gate.changed.notify_one();
        }
    }
}
