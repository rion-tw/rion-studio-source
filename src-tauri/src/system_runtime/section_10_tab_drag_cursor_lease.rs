#[derive(Clone, Debug, PartialEq, Eq)]
struct TabDragCursorLease {
    session_id: String,
    window_generation: u64,
}

fn tab_drag_cursor_lease_matches(
    lease: &TabDragCursorLease,
    session_id: &str,
    window_generation: u64,
) -> bool {
    lease.session_id == session_id && lease.window_generation == window_generation
}

#[cfg(any(target_os = "macos", test))]
fn tab_drag_cursor_release_allowed(
    lease: Option<&TabDragCursorLease>,
    session_id: &str,
    window_generation: u64,
) -> bool {
    lease.is_none_or(|lease| {
        tab_drag_cursor_lease_matches(lease, session_id, window_generation)
    })
}

fn set_tab_drag_window_interaction(
    window: &Window,
    pointer_passthrough: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::runtime_tabs_macos::set_appkit_window_interaction(
            window,
            pointer_passthrough,
            false,
        )
    }
    #[cfg(windows)]
    {
        request_platform_window_set_ignore_cursor_events(window, pointer_passthrough)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        window
            .set_ignore_cursor_events(pointer_passthrough)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl SystemRuntimeExecutor {
    fn reassert_tab_drag_pointer_passthrough_if_leased(
        &self,
        window_id: &str,
        window_generation: u64,
        window: &Window,
    ) -> Result<(), String> {
        let leased = self.state.lock().ok().is_some_and(|state| {
            state
                .tab_drag_cursor_leases
                .get(window_id)
                .is_some_and(|lease| lease.window_generation == window_generation)
        });
        if leased {
            set_tab_drag_window_interaction(window, true)?;
        }
        Ok(())
    }

    pub(crate) fn acquire_tab_drag_cursor_lease(
        &self,
        window_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let (window, window_generation) = {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .native_resources.display_hosts
                .get(window_id)
                .ok_or_else(|| "Tab drag window was not found.".to_owned())?;
            let window = host.window.clone();
            let window_generation = host.generation;
            let already_acquired = state
                .tab_drag_cursor_leases
                .get(window_id)
                .is_some_and(|lease| {
                    tab_drag_cursor_lease_matches(lease, session_id, window_generation)
                });
            if already_acquired {
                return Ok(());
            }
            state.tab_drag_cursor_leases.insert(
                window_id.to_owned(),
                TabDragCursorLease {
                    session_id: session_id.to_owned(),
                    window_generation,
                },
            );
            (window, window_generation)
        };
        if let Err(error) = set_tab_drag_window_interaction(&window, true) {
            if let Ok(mut state) = self.state.lock()
                && state
                    .tab_drag_cursor_leases
                    .get(window_id)
                    .is_some_and(|lease| {
                        tab_drag_cursor_lease_matches(lease, session_id, window_generation)
                    })
            {
                state.tab_drag_cursor_leases.remove(window_id);
            }
            let _ = set_tab_drag_window_interaction(&window, false);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn position_tab_drag_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        session_id: &str,
    ) -> Result<(), String> {
        let (window, window_generation) = {
            let state = self.state().map_err(|error| error.message)?;
            let host = state
                .native_resources.display_hosts
                .get(&target.window_id)
                .ok_or_else(|| "Tab drag window was not found.".to_owned())?;
            let lease = state
                .tab_drag_cursor_leases
                .get(&target.window_id)
                .ok_or_else(|| "Tab drag window cursor lease was not acquired.".to_owned())?;
            if !tab_drag_cursor_lease_matches(lease, session_id, host.generation) {
                return Err("Tab drag window cursor lease is stale.".to_owned());
            }
            (host.window.clone(), host.generation)
        };
        let physical_position = physical_window_position(
            target.bounds.x,
            target.bounds.y,
            target.scale_factor,
        );
        window
            .set_position(PhysicalPosition::new(
                physical_position.0,
                physical_position.1,
            ))
            .map_err(|error| error.to_string())?;
        let mut state = self.state().map_err(|error| error.message)?;
        let lease_is_current = state
            .tab_drag_cursor_leases
            .get(&target.window_id)
            .is_some_and(|lease| {
                tab_drag_cursor_lease_matches(lease, session_id, window_generation)
            });
        let Some(host) = state
            .native_resources.display_hosts
            .get_mut(&target.window_id)
            .filter(|host| host.generation == window_generation)
        else {
            return Err("Tab drag window generation changed while it was moving.".to_owned());
        };
        if !lease_is_current {
            return Err("Tab drag window cursor lease changed while it was moving.".to_owned());
        }
        host.target = target.clone();
        Ok(())
    }

    pub(crate) fn release_tab_drag_cursor_lease(
        &self,
        window_id: &str,
        session_id: &str,
    ) -> Result<bool, String> {
        let window = {
            let mut state = self.state().map_err(|error| error.message)?;
            let Some(lease) = state.tab_drag_cursor_leases.get(window_id) else {
                return Ok(false);
            };
            if lease.session_id != session_id {
                return Ok(false);
            }
            let lease_generation = lease.window_generation;
            state.tab_drag_cursor_leases.remove(window_id);
            state
                .native_resources.display_hosts
                .get(window_id)
                .filter(|host| host.generation == lease_generation)
                .map(|host| (host.window.clone(), lease_generation))
        };
        let Some((window, lease_generation)) = window else {
            return Ok(false);
        };
        set_tab_drag_window_interaction(&window, false)?;
        self.reassert_tab_drag_pointer_passthrough_if_leased(
            window_id,
            lease_generation,
            &window,
        )?;
        Ok(true)
    }
}
