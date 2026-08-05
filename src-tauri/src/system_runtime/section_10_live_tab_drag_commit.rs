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
                self.schedule_tab_surface_move_retry(tab_id.to_owned(), target.window_id.clone());
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
        let (previous_tab_id, previous_surfaces, next_tab_id, next_surfaces, revision) = {
            let mut live = coordinator
                .lock()
                .map_err(|_| "Live runtime window state is unavailable.".to_owned())?
                .clone();
            if live.tab_is_hidden(tab_id) {
                return Ok(());
            }
            let previous_tab_id = live.selected_tab_id.clone();
            let previous_surfaces = self
                .presentation
                .surfaces(&window_id, previous_tab_id.as_deref());
            let next_tab_id = if previous_tab_id.as_deref() == Some(tab_id) {
                successor_tab_after_close(&live.tab_ids(), tab_id, |_| true)
            } else {
                previous_tab_id.clone()
            };
            live.set_tab_hidden(tab_id, true, 0);
            if previous_tab_id.as_deref() == Some(tab_id) {
                live.select(next_tab_id.clone(), 0);
            }
            let receipt = self
                .presentation
                .commit_live_window_record("command", &window_id, &live)?;
            if receipt.status == LiveTopologyCommitStatus::Superseded {
                return Ok(());
            }
            let next_surfaces = self
                .presentation
                .surfaces(&window_id, next_tab_id.as_deref());
            (
                previous_tab_id,
                previous_surfaces,
                next_tab_id,
                next_surfaces,
                receipt.revision,
            )
        };
        self.schedule_native_tab_hide_projection(
            window_id.clone(),
            tab_id.to_owned(),
            next_tab_id.clone(),
            revision,
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

    fn schedule_native_tab_hide_projection(
        &self,
        window_id: String,
        tab_id: String,
        next_tab_id: Option<String>,
        revision: u64,
    ) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-hide-{tab_id}"))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    let still_hidden = runtime
                        .presentation
                        .existing(&window_id)
                        .and_then(|live| {
                            live.lock()
                                .ok()
                                .map(|live| live.tab_is_hidden(&tab_id))
                        })
                        .unwrap_or(false);
                    if !still_hidden {
                        return;
                    }
                    match runtime.try_remove_native_tab_reservation(
                        &window_id,
                        &tab_id,
                        next_tab_id.as_deref(),
                    ) {
                        Ok(()) => {
                            runtime.apply_native_active_style(
                                &window_id,
                                next_tab_id.as_deref(),
                                revision,
                                "tab-hide-follower",
                            );
                            return;
                        }
                        Err(error) => {
                            eprintln!(
                                "Hidden native tab follower remains pending: tab={tab_id} window={window_id} attempt={failure_count} error={}",
                                error.message
                            );
                            thread::sleep(tab_move_retry_delay(failure_count));
                            failure_count = failure_count.saturating_add(1);
                        }
                    }
                }
            });
    }

    fn schedule_native_tab_unhide_projection(
        &self,
        window_id: String,
        tab: LiveTabRecord,
        ordered_tab_ids: Vec<String>,
        revision: u64,
    ) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-unhide-{}", tab.id))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    let still_visible = runtime
                        .presentation
                        .existing(&window_id)
                        .and_then(|live| {
                            live.lock().ok().map(|live| {
                                live.contains_tab(&tab.id) && !live.tab_is_hidden(&tab.id)
                            })
                        })
                        .unwrap_or(false);
                    if !still_visible {
                        return;
                    }
                    #[cfg(any(windows, target_os = "macos"))]
                    let workspace_template = tab.workspace_template.as_deref();
                    #[cfg(not(any(windows, target_os = "macos")))]
                    let workspace_template: Option<&str> = None;
                    let result = runtime
                        .try_ensure_native_tab(
                            &window_id,
                            &tab.id,
                            &tab.title,
                            &tab.tab_type,
                            workspace_template,
                        )
                        .and_then(|()| runtime.reorder_native_tabs(&window_id, &ordered_tab_ids));
                    match result {
                        Ok(()) => {
                            let active_tab_id = runtime
                                .presentation
                                .existing(&window_id)
                                .and_then(|live| {
                                    live.lock()
                                        .ok()
                                        .and_then(|live| live.selected_tab_id.clone())
                                });
                            runtime.apply_native_active_style(
                                &window_id,
                                active_tab_id.as_deref(),
                                revision,
                                "tab-unhide-follower",
                            );
                            return;
                        }
                        Err(error) => {
                            eprintln!(
                                "Unhidden native tab follower remains pending: tab={} window={window_id} attempt={failure_count} error={}",
                                tab.id, error.message
                            );
                            thread::sleep(tab_move_retry_delay(failure_count));
                            failure_count = failure_count.saturating_add(1);
                        }
                    }
                }
            });
    }

    /// Accepts the complete order reported by the visible tab strip. This is the hot-path
    /// commit between AppKit/HTML gesture handling and latest-wins persistence: it only locks
    /// LiveWindowRecord briefly and never calls Core, SQLite, or a native readback.
    pub(crate) fn commit_live_tab_order_intent(
        &self,
        window_id: &str,
        ordered_tab_ids: &[String],
    ) -> Result<bool, String> {
        let Some(coordinator) = self.presentation.existing(window_id) else {
            return Ok(false);
        };
        let mut next = {
            let state = coordinator
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
                return Ok(true);
            }
            state.clone()
        };
        next.reorder_known_tabs(ordered_tab_ids);
        let receipt = self.presentation.commit_live_topology(LiveTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
            source: if cfg!(target_os = "macos") { "appKit" } else { "html" },
            primary_window_id: window_id.to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: next.selected_tab_id.clone(),
                hidden_tab_ids: next.hidden_tab_ids.clone(),
                tabs: next.tabs.clone(),
                ui_sequence: next.ui_sequence.saturating_add(1).max(1),
                window_generation: next.window_generation,
                window_id: window_id.to_owned(),
            }],
        })?;
        if receipt.status == LiveTopologyCommitStatus::Superseded {
            return Ok(false);
        }
        self.schedule_live_projection_membership_follow();
        for affected_window_id in &receipt.window_ids {
            self.schedule_live_window_state_persistence(affected_window_id);
        }
        Ok(true)
    }

    pub(crate) fn preview_tab_drag_order_exact(
        &self,
        window_id: &str,
        ordered_tab_ids: &[String],
        project_native_order: bool,
    ) -> Result<(), String> {
        let committed = self.commit_live_tab_order_intent(window_id, ordered_tab_ids)?;
        if committed && project_native_order {
            self.schedule_native_tab_order_projection(
                window_id.to_owned(),
                ordered_tab_ids.to_vec(),
            );
        }
        Ok(())
    }

    fn schedule_native_tab_order_projection(&self, window_id: String, ordered_tab_ids: Vec<String>) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-order-{window_id}"))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    let is_latest = runtime
                        .presentation
                        .existing(&window_id)
                        .and_then(|live| live.lock().ok().map(|live| live.tab_ids()))
                        .is_some_and(|live_order| live_order == ordered_tab_ids);
                    if !is_latest {
                        return;
                    }
                    match runtime.reorder_native_tabs(&window_id, &ordered_tab_ids) {
                        Ok(()) => return,
                        Err(error) => {
                            eprintln!(
                                "Native tab order follower remains pending: window={window_id} attempt={failure_count} error={}",
                                error.message
                            );
                            thread::sleep(tab_move_retry_delay(failure_count));
                            failure_count = failure_count.saturating_add(1);
                        }
                    }
                }
            });
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
                return Ok(());
            }
            let _ = self.request_tab_presentation(
                tab_id,
                NativePresentationFocus::None,
                "tab-drag-live-commit",
            );
            return Ok(());
        }
        let source_coordinator = self
            .presentation
            .existing(&actual_source_window_id)
            .ok_or_else(|| "The live drag source is unavailable.".to_owned())?;
        let target_coordinator = self.presentation.coordinator(target_window_id)?;
        let (mut source, mut target) = {
            let source = source_coordinator
                .lock()
                .map_err(|_| "The live drag source is unavailable.".to_owned())?
                .clone();
            let target = target_coordinator
                .lock()
                .map_err(|_| "The live drag destination is unavailable.".to_owned())?
                .clone();
            (source, target)
        };
        let source_ids_before = source.tab_ids();
        let Some(index) = source.tabs.iter().position(|tab| tab.id == tab_id) else {
            return Ok(());
        };
        let tab = source.tabs.remove(index);
        let source_was_selected = source.selected_tab_id.as_deref() == Some(tab_id);
        let source_successor = source_was_selected
            .then(|| successor_tab_after_close(&source_ids_before, tab_id, |_| true))
            .flatten();
        source.hidden_tab_ids.remove(tab_id);
        source.aliases.retain(|alias, target| alias != tab_id && target != tab_id);
        if source_was_selected {
            source.selected_tab_id = source_successor;
        }
        target.tabs.retain(|candidate| candidate.id != tab_id);
        target.hidden_tab_ids.remove(tab_id);
        target.tabs.push(tab.clone());
        target.reorder_known_tabs(ordered_tab_ids);
        if source_was_selected || target.selected_tab_id.is_none() {
            target.selected_tab_id = Some(tab_id.to_owned());
        }
        let receipt = self.presentation.commit_live_topology(LiveTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
            source: if cfg!(target_os = "macos") { "appKit" } else { "html" },
            primary_window_id: target_window_id.to_owned(),
            windows: vec![
                LiveWindowTopologyCommit {
                    active_tab_id: source.selected_tab_id.clone(),
                    hidden_tab_ids: source.hidden_tab_ids.clone(),
                    tabs: source.tabs.clone(),
                    ui_sequence: source.ui_sequence.saturating_add(1).max(1),
                    window_generation: source.window_generation,
                    window_id: actual_source_window_id.clone(),
                },
                LiveWindowTopologyCommit {
                    active_tab_id: target.selected_tab_id.clone(),
                    hidden_tab_ids: target.hidden_tab_ids.clone(),
                    tabs: target.tabs.clone(),
                    ui_sequence: target.ui_sequence.saturating_add(1).max(1),
                    window_generation: target.window_generation,
                    window_id: target_window_id.to_owned(),
                },
            ],
        })?;
        if receipt.status == LiveTopologyCommitStatus::Superseded {
            return Ok(());
        }
        let revision = receipt.revision;
        self.schedule_live_projection_membership_follow();
        let selected_after = self.presentation.selected_tabs();
        self.schedule_native_tab_drag_chrome_retry(
            actual_source_window_id.clone(),
            target_window_id.to_owned(),
            tab.clone(),
            selected_after.get(&actual_source_window_id).cloned(),
            revision,
        );
        self.publish_launcher_presence();
        for affected_window_id in &receipt.window_ids {
            self.schedule_live_window_state_persistence(affected_window_id);
        }
        Ok(())
    }

    fn schedule_native_tab_drag_chrome_retry(
        &self,
        source_window_id: String,
        target_window_id: String,
        tab: LiveTabRecord,
        source_active_tab_id: Option<String>,
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
                        revision,
                    ) {
                        Ok(()) => {
                            runtime.apply_native_active_style(
                                &source_window_id,
                                source_active_tab_id.as_deref(),
                                revision,
                                "tab-drag-chrome-source",
                            );
                            runtime.apply_native_active_style(
                                &target_window_id,
                                Some(&tab.id),
                                revision,
                                "tab-drag-chrome-retry",
                            );
                            return;
                        }
                        Err(error) => {
                            eprintln!(
                                "Live tab chrome move remains pending: tab={} target={} attempt={} error={}",
                                tab.id, target_window_id, failure_count, error.message
                            );
                            thread::sleep(tab_move_retry_delay(failure_count));
                            failure_count = failure_count.saturating_add(1);
                        }
                    }
                }
            });
    }

    pub(crate) fn schedule_tab_surface_move_retry(
        &self,
        tab_id: String,
        target_window_id: String,
    ) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-surface-move-{tab_id}"))
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
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
                    match runtime
                        .provisionally_move_tab_for_live_drag(&tab_id, &target_window_id)
                    {
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
                            eprintln!(
                                "Tab surface move retry remains pending: tab={tab_id} target={target_window_id} attempt={failure_count} error={error}"
                            );
                            thread::sleep(tab_move_retry_delay(failure_count));
                            failure_count = failure_count.saturating_add(1);
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
