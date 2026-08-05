impl SystemRuntimeExecutor {
    pub(crate) fn live_tab_window_id(&self, tab_id: &str) -> Option<String> {
        self.presentation.tab_window(tab_id).ok().flatten()
    }

    /// Commits a non-drag topology action to the same live authority used by
    /// AppKit/HTML gestures. Core and SQLite are deliberately absent: callers
    /// enqueue those sinks only after this method returns.
    pub(crate) fn commit_live_tab_mutation_intent(
        self: &Arc<Self>,
        mutation_kind: &str,
        tab_id: &str,
        target: Option<&EmbeddedLaunchTargetRecord>,
        before_tab_id: Option<&str>,
    ) -> Result<(), String> {
        match mutation_kind {
            "reorder" => {
                let window_id = self
                    .presentation
                    .tab_window(tab_id)?
                    .ok_or_else(|| "Runtime tab is no longer in the live topology.".to_owned())?;
                let mut ordered = self
                    .presentation
                    .existing(&window_id)
                    .and_then(|live| live.lock().ok().map(|live| live.tab_ids()))
                    .ok_or_else(|| "Live runtime window state is unavailable.".to_owned())?;
                ordered.retain(|candidate| candidate != tab_id);
                let insertion = match before_tab_id {
                    Some(before) => ordered
                        .iter()
                        .position(|candidate| candidate == before)
                        .ok_or_else(|| {
                            "The reorder target is outside the live source window.".to_owned()
                        })?,
                    None => ordered.len(),
                };
                ordered.insert(insertion, tab_id.to_owned());
                self.preview_tab_drag_order_exact(&window_id, &ordered, true)
            }
            "move" | "moveToNewWindow" => {
                let target = target
                    .ok_or_else(|| "A live tab move requires a target window.".to_owned())?;
                let source_window_id = self
                    .presentation
                    .tab_window(tab_id)?
                    .ok_or_else(|| "Runtime tab is no longer in the live topology.".to_owned())?;
                if self.window_for_id(&target.window_id).is_none() {
                    let title = self
                        .presentation
                        .tab(&source_window_id, tab_id)
                        .map(|tab| tab.title)
                        .unwrap_or_else(|| RION_STUDIO_APP_NAME.to_owned());
                    self.prepare_provisional_game_window(target, &title)?;
                    self.position_provisional_game_window(target)?;
                }
                let mut ordered = self
                    .presentation
                    .existing(&target.window_id)
                    .and_then(|live| live.lock().ok().map(|live| live.tab_ids()))
                    .unwrap_or_default();
                ordered.retain(|candidate| candidate != tab_id);
                let insertion = match before_tab_id {
                    Some(before) => ordered
                        .iter()
                        .position(|candidate| candidate == before)
                        .ok_or_else(|| {
                            "The move target is outside the live destination window.".to_owned()
                        })?,
                    None => ordered.len(),
                };
                ordered.insert(insertion, tab_id.to_owned());
                self.commit_live_tab_drag_destination(
                    &source_window_id,
                    &target.window_id,
                    tab_id,
                    &ordered,
                )?;
                if let Err(error) = self.provisionally_move_tab_with_visibility_inner(
                    tab_id,
                    &target.window_id,
                    true,
                    false,
                ) {
                    eprintln!(
                        "Live tab surface move will retry without rolling back topology: tab={tab_id} target={} error={error}",
                        target.window_id
                    );
                    self.schedule_tab_surface_move_retry(
                        tab_id.to_owned(),
                        target.window_id.clone(),
                    );
                } else if source_window_id != target.window_id {
                    self.discard_provisional_game_window(&source_window_id);
                }
                Ok(())
            }
            "hide" => self.commit_live_tab_hide_intent(tab_id),
            _ => Err("The live tab mutation kind is unsupported.".to_owned()),
        }
    }

    fn commit_live_tab_hide_intent(&self, tab_id: &str) -> Result<(), String> {
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer in the live topology.".to_owned())?;
        let window = self
            .window_for_id(&window_id)
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
        let coordinator = self
            .presentation
            .existing(&window_id)
            .ok_or_else(|| "Live runtime window state is unavailable.".to_owned())?;
        let revision = self.presentation.next_revision();
        let (previous_tab_id, previous_surfaces, next_tab_id, next_surfaces) = {
            let mut live = coordinator
                .lock()
                .map_err(|_| "Live runtime window state is unavailable.".to_owned())?;
            if live.tab_is_hidden(tab_id) {
                return Ok(());
            }
            let previous_tab_id = live.selected_tab_id.clone();
            let previous_surfaces = live.surfaces(previous_tab_id.as_deref());
            let next_tab_id = if previous_tab_id.as_deref() == Some(tab_id) {
                successor_tab_after_close(&live.tab_ids(), tab_id, |_| true)
            } else {
                previous_tab_id.clone()
            };
            live.set_tab_hidden(tab_id, true, revision);
            if previous_tab_id.as_deref() == Some(tab_id) {
                live.select(next_tab_id.clone(), revision);
            }
            let next_surfaces = live.surfaces(next_tab_id.as_deref());
            (
                previous_tab_id,
                previous_surfaces,
                next_tab_id,
                next_surfaces,
            )
        };
        if let Err(error) = self.try_remove_native_tab_reservation(
            &window_id,
            tab_id,
            next_tab_id.as_deref(),
        ) {
            eprintln!(
                "Hidden native tab chrome remains pending without live rollback: tab={tab_id} window={window_id} error={}",
                error.message
            );
        }
        self.apply_native_active_style(
            &window_id,
            next_tab_id.as_deref(),
            revision,
            "tab-hide-live",
        );
        self.dispatch_native_presentation(
            window_id.clone(),
            next_tab_id.clone(),
            revision,
            "tab-hide-live",
            Instant::now(),
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces.clone(),
            next_surfaces.first().cloned(),
            next_tab_id.is_none().then_some(false),
            NativePresentationFocus::ContentOnly,
            None,
        );
        self.schedule_live_window_state_persistence(&window_id);
        Ok(())
    }

    /// Accepts the complete order reported by the visible tab strip. This is the hot-path
    /// commit between AppKit/HTML gesture handling and latest-wins persistence: it only locks
    /// LiveWindowTabState briefly and never calls Core, SQLite, or a native readback.
    pub(crate) fn commit_live_tab_order_intent(
        &self,
        window_id: &str,
        ordered_tab_ids: &[String],
    ) -> Result<bool, String> {
        let Some(coordinator) = self.presentation.existing(window_id) else {
            return Ok(false);
        };
        let changed = {
            let mut state = coordinator
                .lock()
                .map_err(|_| "Runtime tab presentation state is unavailable.".to_owned())?;
            let previous = state.tab_ids();
            if previous.len() != ordered_tab_ids.len()
                || previous.iter().collect::<HashSet<_>>()
                    != ordered_tab_ids.iter().collect::<HashSet<_>>()
            {
                // During a cross-window hover AppKit may already show the dragged tab while
                // ownership is still transferring. That intent belongs to the terminal move,
                // so it is not an error and must not mutate either window's live topology yet.
                return Ok(false);
            }
            if previous == ordered_tab_ids {
                false
            } else {
                let revision = self.presentation.next_revision();
                state.reorder_known_tabs(ordered_tab_ids);
                state.revision = revision;
                true
            }
        };
        if changed {
            self.schedule_live_window_state_persistence(window_id);
        }
        Ok(true)
    }

    pub(crate) fn preview_tab_drag_order_exact(
        &self,
        window_id: &str,
        ordered_tab_ids: &[String],
        project_native_order: bool,
    ) -> Result<(), String> {
        let coordinator = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime tab presentation window was not found.".to_owned())?;
        let ordered = {
            let mut state = coordinator
                .lock()
                .map_err(|_| "Runtime tab presentation state is unavailable.".to_owned())?;
            let previous = state.tab_ids();
            if previous.len() != ordered_tab_ids.len()
                || previous.iter().collect::<HashSet<_>>()
                    != ordered_tab_ids.iter().collect::<HashSet<_>>()
            {
                return Err("Live tab order does not match the presentation window.".to_owned());
            }
            if previous == ordered_tab_ids {
                return Ok(());
            }
            let revision = self.presentation.next_revision();
            state.reorder_known_tabs(ordered_tab_ids);
            state.revision = revision;
            ordered_tab_ids.to_vec()
        };
        self.schedule_live_window_state_persistence(window_id);
        if project_native_order
            && let Err(error) = self.reorder_native_tabs(window_id, &ordered)
        {
            eprintln!(
                "Native tab order projection will reconcile from live topology: window={window_id} error={}",
                error.message
            );
        }
        Ok(())
    }

    pub(crate) fn commit_live_tab_drag_destination(
        &self,
        _source_window_id: &str,
        target_window_id: &str,
        tab_id: &str,
        ordered_tab_ids: &[String],
    ) -> Result<(), String> {
        let Some(actual_source_window_id) = self.presentation.tab_window(tab_id)? else {
            return Ok(());
        };
        if actual_source_window_id == target_window_id {
            if !self.commit_live_tab_order_intent(target_window_id, ordered_tab_ids)? {
                return Err("Live tab order changed before the drag completed.".to_owned());
            }
            let _ = self.request_tab_presentation(
                tab_id,
                NativePresentationFocus::None,
                "tab-drag-live-commit",
            );
            return Ok(());
        }
        let tab = self
            .presentation
            .tab(&actual_source_window_id, tab_id)
            .ok_or_else(|| "Dragged tab presentation changed during the final commit.".to_owned())?;
        let selected_before = self.presentation.selected_tabs();
        let revision = self.presentation.next_revision();
        self.presentation.move_tab(
            tab_id,
            &actual_source_window_id,
            target_window_id,
            revision,
        )?;
        self.preview_tab_drag_order_exact(target_window_id, ordered_tab_ids, false)?;
        let selected_after = self.presentation.selected_tabs();
        #[cfg(any(windows, target_os = "macos"))]
        let workspace_template = tab.workspace_template.as_deref();
        #[cfg(not(any(windows, target_os = "macos")))]
        let workspace_template: Option<&str> = None;
        if let Err(error) = self.relocate_native_tab_reservation(
            &actual_source_window_id,
            target_window_id,
            tab_id,
            &tab.title,
            &tab.tab_type,
            workspace_template,
            selected_after
                .get(&actual_source_window_id)
                .map(String::as_str),
            selected_before.get(target_window_id).map(String::as_str),
            revision,
        ) {
            eprintln!(
                "Live tab chrome projection will retry after drag commit: tab={tab_id} source={actual_source_window_id} target={target_window_id} error={}",
                error.message
            );
            self.schedule_native_tab_drag_chrome_retry(
                actual_source_window_id.clone(),
                target_window_id.to_owned(),
                tab.clone(),
                selected_after.get(&actual_source_window_id).cloned(),
                selected_before.get(target_window_id).cloned(),
                revision,
            );
        }
        self.apply_native_active_style(
            &actual_source_window_id,
            selected_after
                .get(&actual_source_window_id)
                .map(String::as_str),
            revision,
            "tab-drag-live-source",
        );
        self.apply_native_active_style(
            target_window_id,
            selected_after.get(target_window_id).map(String::as_str),
            revision,
            "tab-drag-live-target",
        );
        self.publish_launcher_presence();
        self.schedule_live_window_state_persistence(&actual_source_window_id);
        self.schedule_live_window_state_persistence(target_window_id);
        Ok(())
    }

    fn schedule_native_tab_drag_chrome_retry(
        &self,
        source_window_id: String,
        target_window_id: String,
        tab: TabPresentation,
        source_active_tab_id: Option<String>,
        target_active_before: Option<String>,
        revision: u64,
    ) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-chrome-move-{}", tab.id))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    let delay = tab_move_retry_delay(failure_count);
                    thread::sleep(delay);
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    if runtime.presentation.tab_window(&tab.id).ok().flatten().as_deref()
                        != Some(target_window_id.as_str())
                    {
                        return;
                    }
                    #[cfg(any(windows, target_os = "macos"))]
                    let workspace_template = tab.workspace_template.as_deref();
                    #[cfg(not(any(windows, target_os = "macos")))]
                    let workspace_template: Option<&str> = None;
                    match runtime.relocate_native_tab_reservation(
                        &source_window_id,
                        &target_window_id,
                        &tab.id,
                        &tab.title,
                        &tab.tab_type,
                        workspace_template,
                        source_active_tab_id.as_deref(),
                        target_active_before.as_deref(),
                        revision,
                    ) {
                        Ok(()) => {
                            runtime.apply_native_active_style(
                                &target_window_id,
                                Some(&tab.id),
                                revision,
                                "tab-drag-chrome-retry",
                            );
                            return;
                        }
                        Err(error) => {
                            failure_count = failure_count.saturating_add(1);
                            eprintln!(
                                "Live tab chrome move remains pending: tab={} target={} attempt={} error={}",
                                tab.id, target_window_id, failure_count, error.message
                            );
                        }
                    }
                }
            });
    }

    pub(crate) fn schedule_tab_surface_move_retry(
        self: &Arc<Self>,
        tab_id: String,
        target_window_id: String,
    ) {
        let runtime = Arc::downgrade(self);
        let _ = thread::Builder::new()
            .name(format!("rion-tab-surface-move-{tab_id}"))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    thread::sleep(tab_move_retry_delay(failure_count));
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    if runtime
                        .presentation
                        .tab_window(&tab_id)
                        .ok()
                        .flatten()
                        .as_deref()
                        != Some(target_window_id.as_str())
                    {
                        return;
                    }
                    let physical_source_window_id = runtime.tab_window_id(&tab_id);
                    if physical_source_window_id.as_deref() == Some(target_window_id.as_str()) {
                        return;
                    }
                    match runtime.provisionally_move_tab(&tab_id, &target_window_id) {
                        Ok(()) => {
                            runtime.schedule_live_window_state_persistence(&target_window_id);
                            if let Some(source_window_id) = physical_source_window_id
                                .filter(|source_window_id| source_window_id != &target_window_id)
                            {
                                runtime.discard_provisional_game_window(&source_window_id);
                            }
                            return;
                        }
                        Err(error) => {
                            failure_count = failure_count.saturating_add(1);
                            eprintln!(
                                "Tab surface move retry remains pending: tab={tab_id} target={target_window_id} attempt={failure_count} error={error}"
                            );
                        }
                    }
                }
            });
    }
}

fn tab_move_retry_delay(failure_count: u32) -> Duration {
    match failure_count {
        0 => Duration::from_millis(50),
        1 => Duration::from_millis(250),
        2 => Duration::from_secs(1),
        3 => Duration::from_secs(5),
        _ => Duration::from_secs(30),
    }
}
