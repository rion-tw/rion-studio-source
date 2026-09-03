struct RoleBrowserDataClearCommandState {
    accepting: bool,
    active: std::collections::HashSet<u64>,
    next_id: u64,
}

impl Default for RoleBrowserDataClearCommandState {
    fn default() -> Self {
        Self {
            accepting: true,
            active: std::collections::HashSet::new(),
            next_id: 0,
        }
    }
}

#[derive(Default)]
struct RoleBrowserDataClearCommandCoordinator {
    changed: std::sync::Condvar,
    state: std::sync::Mutex<RoleBrowserDataClearCommandState>,
}

struct RoleBrowserDataClearCommandPermit {
    command_id: u64,
    coordinator: Arc<RoleBrowserDataClearCommandCoordinator>,
}

impl RoleBrowserDataClearCommandCoordinator {
    fn admit(
        self: &Arc<Self>,
    ) -> CoreResult<RoleBrowserDataClearCommandPermit> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("role browser-data clear command lock poisoned".to_owned())
        })?;
        if !state.accepting {
            return Err(CoreError::ShuttingDown);
        }
        state.next_id = state.next_id.checked_add(1).ok_or_else(|| {
            CoreError::Internal("role browser-data clear command sequence exhausted".to_owned())
        })?;
        let command_id = state.next_id;
        state.active.insert(command_id);
        Ok(RoleBrowserDataClearCommandPermit {
            command_id,
            coordinator: Arc::clone(self),
        })
    }

    fn begin_drain(&self) -> CoreResult<()> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("role browser-data clear command lock poisoned".to_owned())
        })?;
        state.accepting = false;
        self.changed.notify_all();
        Ok(())
    }

    fn wait_until(&self, deadline: Instant) -> CoreResult<bool> {
        let mut state = self.state.lock().map_err(|_| {
            CoreError::Internal("role browser-data clear command lock poisoned".to_owned())
        })?;
        if state.accepting {
            return Err(CoreError::Domain {
                code: "ROLE_BROWSER_DATA_CLEAR_DRAIN_NOT_STARTED",
                message: "Role browser-data clear command drain has not started.".to_owned(),
            });
        }
        while !state.active.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return Ok(false);
            }
            let (next_state, timed_out) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| {
                    CoreError::Internal(
                        "role browser-data clear command lock poisoned".to_owned(),
                    )
                })?;
            state = next_state;
            if timed_out.timed_out() && !state.active.is_empty() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn is_idle(&self) -> CoreResult<bool> {
        let state = self.state.lock().map_err(|_| {
            CoreError::Internal("role browser-data clear command lock poisoned".to_owned())
        })?;
        Ok(state.active.is_empty())
    }

    fn terminal(&self, command_id: u64) {
        if let Ok(mut state) = self.state.lock()
            && state.active.remove(&command_id)
        {
            self.changed.notify_all();
        }
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.active.len())
            .unwrap_or(usize::MAX)
    }

    #[cfg(test)]
    fn poison_state_lock_for_test(&self) {
        let _state = self.state.lock().unwrap();
        panic!("poison the Role browser-data clear command lock");
    }
}

impl Drop for RoleBrowserDataClearCommandPermit {
    fn drop(&mut self) {
        self.coordinator.terminal(self.command_id);
    }
}

impl AppCore {
    /// Stops accepting new Role browser-data clear commands. Call this before
    /// native shutdown begins so a command cannot enter after the native clear
    /// executor has started draining.
    pub fn begin_role_browser_data_clear_command_drain(&self) -> CoreResult<()> {
        self.role_browser_data_clear_commands.begin_drain()
    }

    /// Waits only for accepted clear command workers to reach their exact Core
    /// domain terminal. `false` means the supplied external liveness boundary
    /// elapsed; it never means that reset, rollback, or cleanup succeeded.
    pub fn wait_for_role_browser_data_clear_command_drain(
        &self,
        deadline: Instant,
    ) -> CoreResult<bool> {
        self.role_browser_data_clear_commands.wait_until(deadline)
    }
}
