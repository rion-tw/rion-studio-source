#[derive(Default)]
struct NavigationState {
    active_native_navigation_id: Option<u64>,
    active_operation_id: Option<String>,
    failure_code: Option<String>,
    finished: bool,
    native_completion_succeeded: Option<bool>,
    owner_close_cancelled: bool,
    page_finished: bool,
    requires_native_completion: bool,
    started: bool,
}

struct NavigationTracker {
    state: Mutex<NavigationState>,
    changed: Condvar,
    async_changed: watch::Sender<u64>,
}

impl Default for NavigationTracker {
    fn default() -> Self {
        Self::new_for_platform(current_runtime_platform())
    }
}

impl NavigationTracker {
    fn new_for_platform(platform: &str) -> Self {
        let (async_changed, _) = watch::channel(0);
        Self {
            state: Mutex::new(NavigationState {
                requires_native_completion: platform == "windows",
                ..NavigationState::default()
            }),
            changed: Condvar::new(),
            async_changed,
        }
    }

    fn wake(&self) {
        if let Ok(_state) = self.state.lock() {
            self.changed.notify_all();
        }
    }

    fn reset(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active_native_navigation_id = None;
            state.active_operation_id = None;
            state.failure_code = None;
            state.finished = false;
            state.native_completion_succeeded = None;
            state.owner_close_cancelled = false;
            state.page_finished = false;
            state.started = false;
            self.changed.notify_all();
        }
        self.signal_async_changed();
    }

    fn cancel_for_owner_close(&self) -> bool {
        let cancelled = self.state.lock().ok().is_some_and(|mut state| {
            if state.finished {
                return false;
            }
            state.failure_code = Some("SYSTEM_SURFACE_RECOVERY_CANCELLED".to_owned());
            state.finished = true;
            state.owner_close_cancelled = true;
            self.changed.notify_all();
            true
        });
        if cancelled {
            self.signal_async_changed();
        }
        cancelled
    }

    fn owner_close_cancelled(&self) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| state.owner_close_cancelled)
    }

    fn has_committed_page(&self) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.finished && state.failure_code.is_none() && state.page_finished
        })
    }

    #[cfg(windows)]
    fn require_native_completion(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        state.requires_native_completion = true;
        Ok(())
    }

    fn signal_async_changed(&self) {
        self.async_changed
            .send_modify(|revision| *revision = revision.saturating_add(1));
    }

    fn page_event(&self, event: PageLoadEvent, url: &Url) {
        if !matches!(url.scheme(), "http" | "https") {
            return;
        }
        let mut terminal = false;
        if let Ok(mut state) = self.state.lock() {
            if state.finished {
                return;
            }
            match event {
                PageLoadEvent::Started => {
                    state.page_finished = false;
                    state.started = true;
                }
                // WKWebView can omit the Started callback when several child
                // views navigate together. WebView2 additionally requires its
                // exact native success result because an error page also emits
                // a Tauri Finished event for the requested HTTP(S) URL.
                PageLoadEvent::Finished => {
                    state.page_finished = true;
                    state.finished = !state.requires_native_completion
                        || state.native_completion_succeeded == Some(true);
                }
            }
            terminal = state.finished;
            self.changed.notify_all();
        }
        if terminal {
            self.signal_async_changed();
        }
    }

    #[cfg(any(windows, test))]
    fn native_navigation_started(&self, navigation_id: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.finished || !state.requires_native_completion {
            return false;
        }
        state.active_native_navigation_id = Some(navigation_id);
        state.native_completion_succeeded = None;
        state.page_finished = false;
        state.started = true;
        true
    }

    #[cfg(any(windows, test))]
    fn native_navigation_completed(
        &self,
        navigation_id: u64,
        succeeded: bool,
        failure_code: Option<&str>,
    ) -> bool {
        let mut terminal = false;
        if let Ok(mut state) = self.state.lock() {
            if state.finished
                || !state.requires_native_completion
                || state.active_native_navigation_id != Some(navigation_id)
            {
                return false;
            }
            state.native_completion_succeeded = Some(succeeded);
            if succeeded {
                state.finished = state.page_finished;
            } else {
                state.failure_code = Some(
                    failure_code
                        .unwrap_or("SYSTEM_NAVIGATION_NATIVE_FAILED")
                        .to_owned(),
                );
                state.finished = true;
            }
            terminal = state.finished;
            self.changed.notify_all();
        }
        if terminal {
            self.signal_async_changed();
        }
        terminal
    }

    fn wait(&self) -> Result<(), String> {
        self.wait_while(|| true).and_then(|completed| {
            completed
                .then_some(())
                .ok_or_else(|| "System WebView navigation was cancelled.".to_owned())
        })
    }

    fn wait_while(&self, should_continue: impl Fn() -> bool) -> Result<bool, String> {
        let deadline = Instant::now() + NAVIGATION_TIMEOUT;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        while !state.finished {
            if !should_continue() {
                return Ok(false);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("System WebView navigation timed out.".to_owned());
            }
            let (next, timeout) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
            state = next;
            if timeout.timed_out() && Instant::now() >= deadline && !state.finished {
                return Err("System WebView navigation timed out.".to_owned());
            }
        }
        if let Some(code) = state.failure_code.as_deref() {
            return Err(format!("System WebView navigation failed ({code})."));
        }
        Ok(true)
    }
}
