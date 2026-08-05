impl LiveWindowTabStore {
    fn commit(
        &self,
        input: LiveTopologyCommitInput,
    ) -> Result<LiveTopologyCommitReceipt, String> {
        if input.commit_id.is_empty()
            || !matches!(input.source, "appKit" | "html" | "restore" | "command")
        {
            return Err("The live topology commit identity or source is invalid.".to_owned());
        }
        let _commit = self
            .commit_gate
            .lock()
            .map_err(|_| "The live topology commit lane is unavailable.".to_owned())?;
        if input.windows.is_empty() {
            return Ok(LiveTopologyCommitReceipt {
                revision: self.next_revision.load(Ordering::Acquire),
                status: LiveTopologyCommitStatus::Superseded,
                window_ids: Vec::new(),
            });
        }

        let mut commits = input.windows;
        commits.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        let coordinators = {
            let mut windows = self
                .windows
                .lock()
                .map_err(|_| "The live topology registry is unavailable.".to_owned())?;
            commits
                .iter()
                .map(|commit| {
                    let coordinator = windows
                        .entry(commit.window_id.clone())
                        .or_insert_with(|| Arc::new(Mutex::new(LiveWindowRecord::default())));
                    (commit.window_id.clone(), Arc::clone(coordinator))
                })
                .collect::<Vec<_>>()
        };

        let mut states = Vec::with_capacity(coordinators.len());
        for (_, coordinator) in &coordinators {
            states.push(
                coordinator
                    .lock()
                    .map_err(|_| "A live topology window is unavailable.".to_owned())?,
            );
        }
        let stale = commits.iter().zip(states.iter()).any(|(commit, state)| {
            commit.window_generation < state.window_generation
                || (commit.window_generation == state.window_generation
                    && commit.ui_sequence > 0
                    && commit.ui_sequence <= state.ui_sequence)
        });
        if stale {
            return Ok(LiveTopologyCommitReceipt {
                revision: self.next_revision.load(Ordering::Acquire),
                status: LiveTopologyCommitStatus::Superseded,
                window_ids: commits
                    .into_iter()
                    .map(|commit| commit.window_id)
                    .collect(),
            });
        }

        let mut owner_by_tab = HashMap::<String, String>::new();
        for commit in &commits {
            for tab in &commit.tabs {
                let replace = commit.window_id == input.primary_window_id
                    || !owner_by_tab.contains_key(&tab.id);
                if replace {
                    owner_by_tab.insert(tab.id.clone(), commit.window_id.clone());
                }
            }
        }
        let revision = self
            .next_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        for (commit, state) in commits.iter_mut().zip(states.iter_mut()) {
            commit.tabs.retain(|tab| {
                owner_by_tab.get(&tab.id).map(String::as_str) == Some(commit.window_id.as_str())
            });
            let tab_ids = commit
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<HashSet<_>>();
            commit.hidden_tab_ids.retain(|tab_id| tab_ids.contains(tab_id.as_str()));
            let active_tab_id = commit
                .active_tab_id
                .take()
                .filter(|tab_id| {
                    tab_ids.contains(tab_id.as_str()) && !commit.hidden_tab_ids.contains(tab_id)
                })
                .or_else(|| {
                    commit
                        .tabs
                        .iter()
                        .find(|tab| !commit.hidden_tab_ids.contains(&tab.id))
                        .map(|tab| tab.id.clone())
                });
            let aliases = std::mem::take(&mut state.aliases);
            let persisted_name = state.persisted_name.clone();
            let placement = state.placement.clone();
            let target_display = state.target_display.clone();
            **state = LiveWindowRecord {
                aliases,
                hidden_tab_ids: std::mem::take(&mut commit.hidden_tab_ids),
                persisted_name,
                placement,
                revision,
                selected_tab_id: active_tab_id,
                tabs: std::mem::take(&mut commit.tabs),
                target_display,
                ui_sequence: commit.ui_sequence,
                window_generation: commit.window_generation,
                window_id: commit.window_id.clone(),
            };
        }
        drop(states);
        Ok(LiveTopologyCommitReceipt {
            revision,
            status: LiveTopologyCommitStatus::Applied,
            window_ids: commits
                .into_iter()
                .map(|commit| commit.window_id)
                .collect(),
        })
    }

    fn commit_placement(
        &self,
        input: LiveWindowPlacementCommitInput,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let _commit = self
            .commit_gate
            .lock()
            .map_err(|_| "The live placement commit lane is unavailable.".to_owned())?;
        let coordinator = {
            let mut windows = self
                .windows
                .lock()
                .map_err(|_| "The live topology registry is unavailable.".to_owned())?;
            Arc::clone(
                windows
                    .entry(input.window_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(LiveWindowRecord::default()))),
            )
        };
        let mut live = coordinator
            .lock()
            .map_err(|_| "The live window placement is unavailable.".to_owned())?;
        if input.window_generation < live.window_generation
            || (input.window_generation == live.window_generation
                && input.ui_sequence <= live.ui_sequence)
        {
            return Ok(LiveWindowPlacementCommitReceipt {
                revision: live.revision,
                status: LiveTopologyCommitStatus::Superseded,
            });
        }
        let revision = self
            .next_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        live.placement = Some(input.placement);
        live.revision = revision;
        live.target_display = Some(input.target_display);
        live.ui_sequence = input.ui_sequence;
        live.window_generation = input.window_generation;
        live.window_id = input.window_id;
        Ok(LiveWindowPlacementCommitReceipt {
            revision,
            status: LiveTopologyCommitStatus::Applied,
        })
    }
}

impl PresentationRegistry {
    fn snapshot_live_window(&self, window_id: &str) -> Result<LiveWindowRecord, String> {
        self.coordinator(window_id)?
            .lock()
            .map(|live| live.clone())
            .map_err(|_| "The live runtime window is unavailable.".to_owned())
    }

    fn commit_live_window_record(
        &self,
        source: &'static str,
        window_id: &str,
        live: &LiveWindowRecord,
    ) -> Result<LiveTopologyCommitReceipt, String> {
        self.commit_live_topology(LiveTopologyCommitInput {
            commit_id: uuid::Uuid::new_v4().to_string(),
            source,
            primary_window_id: window_id.to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: live.selected_tab_id.clone(),
                hidden_tab_ids: live.hidden_tab_ids.clone(),
                tabs: live.tabs.clone(),
                ui_sequence: live.ui_sequence.saturating_add(1).max(1),
                window_generation: live.window_generation,
                window_id: window_id.to_owned(),
            }],
        })
    }

    fn commit_live_selection(
        &self,
        source: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
    ) -> Result<(LiveWindowRecord, LiveWindowRecord, u64), String> {
        let before = self
            .existing(window_id)
            .and_then(|live| live.lock().ok().map(|live| live.clone()))
            .ok_or_else(|| "The live runtime window is unavailable.".to_owned())?;
        if tab_id.is_some_and(|tab_id| !before.contains_tab(tab_id)) {
            return Err("The requested tab is no longer in live topology.".to_owned());
        }
        let mut after = before.clone();
        after.select(tab_id.map(str::to_owned), 0);
        let receipt = self.commit_live_window_record(source, window_id, &after)?;
        if receipt.status == LiveTopologyCommitStatus::Superseded {
            return Err("The tab selection was superseded by newer live topology.".to_owned());
        }
        after.revision = receipt.revision;
        after.ui_sequence = before.ui_sequence.saturating_add(1).max(1);
        Ok((before, after, receipt.revision))
    }

    fn commit_live_tab_removal(
        &self,
        source: &'static str,
        window_id: &str,
        tab_id: &str,
    ) -> Result<(Option<String>, u64), String> {
        let Some(mut next) = self
            .existing(window_id)
            .and_then(|live| live.lock().ok().map(|live| live.clone()))
        else {
            return Ok((None, self.current_revision()));
        };
        if !next.contains_tab(tab_id) {
            return Ok((next.selected_tab_id, next.revision));
        }
        let was_selected = next.selected_tab_id.as_deref() == Some(tab_id);
        next.remove_tab(tab_id, 0);
        if was_selected {
            let successor = next.tabs.last().map(|tab| tab.id.clone());
            next.select(successor, 0);
        }
        let receipt = self.commit_live_window_record(source, window_id, &next)?;
        Ok((next.selected_tab_id, receipt.revision))
    }

    fn commit_live_topology(
        &self,
        input: LiveTopologyCommitInput,
    ) -> Result<LiveTopologyCommitReceipt, String> {
        let receipt = self.live.commit(input)?;
        if receipt.status == LiveTopologyCommitStatus::Applied {
            self.projection
                .membership_requested_revision
                .fetch_max(receipt.revision, Ordering::AcqRel);
            // This is deliberately a non-blocking fast path. A busy native
            // follower must never hold up the AppKit/HTML live commit.
            let _ = self.try_follow_live_projection_membership();
        }
        Ok(receipt)
    }

    fn projection_membership_needs_follow(&self) -> bool {
        self.projection
            .membership_applied_revision
            .load(Ordering::Acquire)
            < self
                .projection
                .membership_requested_revision
                .load(Ordering::Acquire)
    }

    fn try_follow_live_projection_membership(&self) -> bool {
        let requested_revision = self
            .projection
            .membership_requested_revision
            .load(Ordering::Acquire);
        if requested_revision
            <= self
                .projection
                .membership_applied_revision
                .load(Ordering::Acquire)
        {
            return true;
        }
        let live_windows = match self.live.windows.try_lock() {
            Ok(windows) => windows
                .iter()
                .map(|(window_id, live)| (window_id.clone(), Arc::clone(live)))
                .collect::<Vec<_>>(),
            Err(_) => return false,
        };
        let mut owner_by_tab = HashMap::<String, String>::new();
        let mut live_window_ids = Vec::with_capacity(live_windows.len());
        for (window_id, live) in &live_windows {
            let live = match live.try_lock() {
                Ok(live) => live,
                Err(_) => return false,
            };
            live_window_ids.push(window_id.clone());
            for tab in &live.tabs {
                owner_by_tab.insert(tab.id.clone(), window_id.clone());
            }
        }
        let projection_windows = {
            let mut projections = match self.projection.windows.try_lock() {
                Ok(projections) => projections,
                Err(_) => return false,
            };
            for window_id in live_window_ids {
                projections
                    .entry(window_id)
                    .or_insert_with(|| Arc::new(Mutex::new(NativeTabProjectionState::default())));
            }
            let mut windows = projections
                .iter()
                .map(|(window_id, projection)| (window_id.clone(), Arc::clone(projection)))
                .collect::<Vec<_>>();
            windows.sort_by(|left, right| left.0.cmp(&right.0));
            windows
        };
        let mut projection_guards = Vec::with_capacity(projection_windows.len());
        for (_, projection) in &projection_windows {
            match projection.try_lock() {
                Ok(projection) => projection_guards.push(projection),
                Err(_) => return false,
            }
        }
        let mut surface_owners = match self.surface_owners.try_lock() {
            Ok(owners) => owners,
            Err(_) => return false,
        };
        let mut bindings_by_tab = HashMap::<String, Vec<SurfacePresentationBinding>>::new();
        for projection in &mut projection_guards {
            for (tab_id, bindings) in std::mem::take(&mut projection.surface_bindings) {
                bindings_by_tab.entry(tab_id).or_default().extend(bindings);
            }
        }
        for (tab_id, bindings) in bindings_by_tab {
            let Some(window_id) = owner_by_tab.get(&tab_id) else {
                continue;
            };
            let Some(index) = projection_windows
                .iter()
                .position(|(candidate, _)| candidate == window_id)
            else {
                continue;
            };
            let owner_revision = self
                .next_surface_owner_revision
                .fetch_add(1, Ordering::AcqRel)
                .saturating_add(1);
            for binding in &bindings {
                surface_owners.insert(
                    binding.webview.label().to_owned(),
                    SurfacePresentationOwner {
                        instance_id: binding.instance_id.clone(),
                        revision: owner_revision,
                        window_id: window_id.clone(),
                    },
                );
            }
            projection_guards[index]
                .surface_bindings
                .insert(tab_id, bindings);
        }
        self.projection
            .membership_applied_revision
            .fetch_max(requested_revision, Ordering::AcqRel);
        true
    }
}

impl SystemRuntimeExecutor {
    fn schedule_live_projection_membership_follow(&self) {
        if !self.presentation.projection_membership_needs_follow()
            || self
                .presentation
                .projection
                .membership_retry_running
                .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Some(runtime) = self.self_weak.get().cloned() else {
            self.presentation
                .projection
                .membership_retry_running
                .store(false, Ordering::Release);
            return;
        };
        let presentation = Arc::clone(&self.presentation);
        let spawn = thread::Builder::new()
            .name("rion-live-projection-membership".to_owned())
            .spawn(move || {
                let mut failure_count = 0_u32;
                loop {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    if !runtime.presentation.projection_membership_needs_follow()
                        || runtime
                            .presentation
                            .try_follow_live_projection_membership()
                    {
                        runtime
                            .presentation
                            .projection
                            .membership_retry_running
                            .store(false, Ordering::Release);
                        if runtime.presentation.projection_membership_needs_follow() {
                            runtime.schedule_live_projection_membership_follow();
                        }
                        return;
                    }
                    thread::sleep(tab_move_retry_delay(failure_count));
                    failure_count = failure_count.saturating_add(1);
                }
            });
        if spawn.is_err() {
            presentation
                .projection
                .membership_retry_running
                .store(false, Ordering::Release);
        }
    }

    fn resolve_live_tab_window_id(&self, tab_id: &str) -> RuntimeResult<String> {
        self.presentation
            .tab_window(tab_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "The runtime tab is no longer in live topology.",
                )
            })
    }

    fn live_tab_ids_for_window(&self, window_id: &str) -> Vec<String> {
        self.presentation
            .existing(window_id)
            .and_then(|live| live.lock().ok().map(|live| live.all_tab_ids()))
            .unwrap_or_default()
    }

    fn update_live_window_target(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        advance_revision: bool,
    ) -> Result<u64, String> {
        let target_display = self
            .window_state_persistence
            .cached_target_display(&target.window_id, target.display_id)
            .unwrap_or(DisplayTargetRecord {
                id: target.display_id,
                fingerprint: None,
            });
        let placement = GameWindowPlacementRecord {
            normal_bounds: target.bounds.clone(),
            saved_work_area: target.work_area.clone(),
            presentation: target.presentation.clone(),
        };
        let live = self.presentation.coordinator(&target.window_id)?;
        if advance_revision {
            let (window_generation, ui_sequence) = live
                .lock()
                .map(|live| (live.window_generation, live.ui_sequence.saturating_add(1).max(1)))
                .map_err(|_| "Live runtime window state is unavailable.".to_owned())?;
            let receipt = self.presentation.live.commit_placement(
                LiveWindowPlacementCommitInput {
                    placement,
                    target_display,
                    ui_sequence,
                    window_generation,
                    window_id: target.window_id.clone(),
                },
            )?;
            if receipt.status == LiveTopologyCommitStatus::Superseded {
                return Ok(receipt.revision);
            }
            return Ok(receipt.revision);
        }
        let mut live = live
            .lock()
            .map_err(|_| "Live runtime window state is unavailable.".to_owned())?;
        live.target_display = Some(target_display);
        live.placement = Some(placement);
        Ok(live.revision)
    }

    fn set_live_window_persisted_name(
        &self,
        window_id: &str,
        name: Option<String>,
    ) -> Result<(), String> {
        let Some(live) = self.presentation.existing(window_id) else {
            return Ok(());
        };
        live.lock()
            .map_err(|_| "Live runtime window state is unavailable.".to_owned())?
            .persisted_name = name;
        Ok(())
    }
}
