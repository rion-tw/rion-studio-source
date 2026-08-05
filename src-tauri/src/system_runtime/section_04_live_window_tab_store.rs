impl LiveWindowTabStore {
    fn commit(
        &self,
        input: LiveTopologyCommitInput,
    ) -> Result<LiveTopologyCommitReceipt, String> {
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
                        .or_insert_with(|| Arc::new(Mutex::new(LiveWindowTabState::default())));
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
        let bindings_by_tab = states
            .iter()
            .flat_map(|state| {
                state
                    .projection
                    .surface_bindings
                    .iter()
                    .map(|(tab_id, bindings)| (tab_id.clone(), bindings.clone()))
            })
            .collect::<HashMap<_, _>>();
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
            let aliases = std::mem::take(&mut state.live.aliases);
            let persisted_name = state.live.persisted_name.clone();
            let placement = state.live.placement.clone();
            let target_display = state.live.target_display.clone();
            state.live = LiveWindowRecord {
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
            state.projection.host_visibility = state.selected_tab_id.is_some();
            let live_tab_ids = state
                .tabs
                .iter()
                .map(|tab| tab.id.clone())
                .collect::<HashSet<_>>();
            state
                .projection
                .surface_bindings
                .retain(|tab_id, _| live_tab_ids.contains(tab_id));
            for tab_id in live_tab_ids {
                if let Some(bindings) = bindings_by_tab.get(&tab_id) {
                    state
                        .projection
                        .surface_bindings
                        .insert(tab_id, bindings.clone());
                }
            }
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
}

impl SystemRuntimeExecutor {
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
        let live = self.presentation.coordinator(&target.window_id)?;
        let mut live = live
            .lock()
            .map_err(|_| "Live runtime window state is unavailable.".to_owned())?;
        live.target_display = Some(
            self.window_state_persistence
                .cached_target_display(&target.window_id, target.display_id)
                .unwrap_or(DisplayTargetRecord {
                    id: target.display_id,
                    fingerprint: None,
                }),
        );
        live.placement = Some(GameWindowPlacementRecord {
            normal_bounds: target.bounds.clone(),
            saved_work_area: target.work_area.clone(),
            presentation: target.presentation.clone(),
        });
        if advance_revision {
            live.revision = self.presentation.next_revision();
        }
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
