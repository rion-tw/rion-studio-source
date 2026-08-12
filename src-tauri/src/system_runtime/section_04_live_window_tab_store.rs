impl LiveWindowTabStore {
    fn apply(&self, intent: RuntimeIntent) -> rion_core::CoreResult<rion_core::RuntimeCommit> {
        let _authority_guard = self
            .authority_barrier
            .as_ref()
            .map(|barrier| {
                barrier.write().map_err(|_| {
                    rion_core::CoreError::Internal(
                        "runtime authority barrier poisoned".to_owned(),
                    )
                })
            })
            .transpose()?;
        self.kernel.apply(intent)
    }

    fn commit(
        &self,
        input: LiveTopologyCommitInput,
    ) -> Result<LiveTopologyCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::CommitTopology(KernelTopologyCommitInput {
                commit_id: input.commit_id,
                source: input.source.to_owned(),
                primary_window_id: input.primary_window_id,
                windows: input
                    .windows
                    .into_iter()
                    .map(|window| KernelWindowTopologyCommit {
                        active_tab_id: window.active_tab_id,
                        hidden_tab_ids: window.hidden_tab_ids,
                        tabs: window.tabs,
                        ui_sequence: window.ui_sequence,
                        window_generation: window.window_generation,
                        window_id: window.window_id,
                    })
                    .collect(),
            }))
            .map_err(|error| error.to_string())?;
        Ok(LiveTopologyCommitReceipt {
            membership_changed: commit.membership_changed,
            revision: commit.revision,
            status: match commit.status {
                RuntimeCommitStatus::Applied => LiveTopologyCommitStatus::Applied,
                RuntimeCommitStatus::Duplicate | RuntimeCommitStatus::Superseded => {
                    LiveTopologyCommitStatus::Superseded
                }
            },
            window_ids: commit.window_ids,
        })
    }

    fn commit_placement(
        &self,
        input: LiveWindowPlacementCommitInput,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::CommitPlacement(
                KernelWindowPlacementCommitInput {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    placement: input.placement,
                    placement_sequence: input.placement_sequence,
                    source: "command".to_owned(),
                    target_display: input.target_display,
                    window_generation: input.window_generation,
                    window_id: input.window_id,
                },
            ))
            .map_err(|error| error.to_string())?;
        Ok(LiveWindowPlacementCommitReceipt {
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
        })
    }

    fn commit_tab_audio_muted(
        &self,
        expected_revision: u64,
        tab_id: &str,
        window_id: &str,
        audio_muted: bool,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::SetTabAudioMuted {
                audio_muted,
                expected_revision: Some(expected_revision),
                operation_id: uuid::Uuid::new_v4().to_string(),
                tab_id: tab_id.to_owned(),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        Ok(LiveWindowPlacementCommitReceipt {
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
        })
    }

    fn commit_role_zoom(
        &self,
        expected_revision: u64,
        tab_id: &str,
        window_id: &str,
        role_id: &str,
        browser_zoom_percent: Option<f64>,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::SetRoleZoom {
                browser_zoom_percent,
                expected_revision: Some(expected_revision),
                operation_id: uuid::Uuid::new_v4().to_string(),
                role_id: role_id.to_owned(),
                tab_id: tab_id.to_owned(),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        Ok(LiveWindowPlacementCommitReceipt {
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
        })
    }

    fn commit_tab_role_slots(
        &self,
        expected_revision: u64,
        tab_id: &str,
        window_id: &str,
        role_slots: Vec<GameWindowRoleSlotRecord>,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::ReplaceTabRoleSlots {
                expected_revision: Some(expected_revision),
                operation_id: uuid::Uuid::new_v4().to_string(),
                role_slots,
                tab_id: tab_id.to_owned(),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        Ok(LiveWindowPlacementCommitReceipt {
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
        })
    }

    fn commit_window_zoom_factor(
        &self,
        expected_revision: u64,
        window_id: &str,
        zoom_factor: f64,
    ) -> Result<LiveWindowPlacementCommitReceipt, String> {
        let commit = self
            .apply(RuntimeIntent::SetWindowZoomFactor {
                expected_revision: Some(expected_revision),
                operation_id: uuid::Uuid::new_v4().to_string(),
                window_id: window_id.to_owned(),
                zoom_factor,
            })
            .map_err(|error| error.to_string())?;
        Ok(LiveWindowPlacementCommitReceipt {
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
        })
    }
}

impl PresentationRegistry {
    fn snapshot_live_window(&self, window_id: &str) -> Result<LiveWindowRecord, String> {
        self.coordinator(window_id).map(|handle| handle.record)
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

    fn commit_live_tab_close(
        &self,
        attempt_id: &str,
        operation_id: &str,
        surface_generation: u64,
        tab_id: &str,
        window_id: &str,
        successor_tab_id: Option<&str>,
    ) -> Result<LiveTopologyCommitReceipt, String> {
        let current = self
            .existing(window_id)
            .ok_or_else(|| "The live runtime window is no longer available.".to_owned())?;
        let commit = self
            .live
            .apply(RuntimeIntent::CloseTab {
                attempt_id: Some(LaunchAttemptId::new(attempt_id)?),
                expected_revision: Some(current.revision),
                operation_id: OperationId::new(operation_id)?,
                surface_generation: RuntimeSurfaceGeneration(surface_generation),
                successor_tab_id: successor_tab_id
                    .map(RuntimeTabId::new)
                    .transpose()?,
                tab_id: RuntimeTabId::new(tab_id)?,
                window_generation: RuntimeWindowGeneration(current.window_generation),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        if commit.status == RuntimeCommitStatus::Applied && commit.membership_changed {
            self.projection
                .membership_requested_revision
                .fetch_max(commit.revision, Ordering::AcqRel);
        }
        if commit.status == RuntimeCommitStatus::Applied {
            self.refresh_desired_native_projections(&commit.window_ids)?;
        }
        Ok(LiveTopologyCommitReceipt {
            membership_changed: commit.membership_changed,
            revision: commit.revision,
            status: if commit.status == RuntimeCommitStatus::Applied {
                LiveTopologyCommitStatus::Applied
            } else {
                LiveTopologyCommitStatus::Superseded
            },
            window_ids: commit.window_ids,
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
            .ok_or_else(|| "The live runtime window is unavailable.".to_owned())?;
        if tab_id.is_some_and(|tab_id| !before.contains_tab(tab_id)) {
            return Err("The requested tab is no longer in live topology.".to_owned());
        }
        let mut after = before.record.clone();
        after.select(tab_id.map(str::to_owned), 0);
        let receipt = self.commit_live_window_record(source, window_id, &after)?;
        if receipt.status == LiveTopologyCommitStatus::Superseded {
            let current = self
                .existing(window_id)
                .ok_or_else(|| "The live runtime window is unavailable.".to_owned())?;
            let request_is_authoritative = current.selected_tab_id.as_deref() == tab_id
                && tab_id.is_none_or(|tab_id| current.contains_tab(tab_id));
            if !request_is_authoritative {
                return Err("The tab selection was superseded by newer live topology.".to_owned());
            }
            // The exact superseding membership event already carries this selection.
            // Complete from that authoritative revision without retrying a mutation
            // that could overwrite a later visible tab action.
            let current_revision = current.revision;
            return Ok((before.record, current.record, current_revision));
        }
        after.revision = receipt.revision;
        after.ui_sequence = before.ui_sequence.saturating_add(1).max(1);
        Ok((before.record, after, receipt.revision))
    }

    fn commit_live_tab_removal(
        &self,
        source: &'static str,
        window_id: &str,
        tab_id: &str,
    ) -> Result<(Option<String>, u64), String> {
        let Some(next) = self
            .existing(window_id)
        else {
            return Ok((None, self.current_revision()));
        };
        let mut next = next.record;
        if !next.contains_tab(tab_id) {
            return Ok((next.selected_tab_id, next.revision));
        }
        let was_selected = next.selected_tab_id.as_deref() == Some(tab_id);
        let successor = was_selected
            .then(|| {
                successor_tab_after_close(&next.tab_ids(), tab_id, |candidate| {
                    !next.hidden_tab_ids.contains(candidate)
                })
            })
            .flatten();
        next.remove_tab(tab_id, 0);
        if was_selected {
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
            self.refresh_desired_native_projections(&receipt.window_ids)?;
        }
        if receipt.status == LiveTopologyCommitStatus::Applied && receipt.membership_changed {
            self.projection
                .membership_requested_revision
                .fetch_max(receipt.revision, Ordering::AcqRel);
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

    fn follow_live_projection_membership(&self) -> Result<(), String> {
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
            return Ok(());
        }
        let live_windows = self.snapshot_states()?.into_iter().collect::<Vec<_>>();
        let mut owner_by_tab = HashMap::<String, (String, u64)>::new();
        let mut live_window_ids = Vec::with_capacity(live_windows.len());
        for (window_id, live) in &live_windows {
            live_window_ids.push(window_id.clone());
            for tab in &live.tabs {
                owner_by_tab.insert(
                    tab.id.clone(),
                    (window_id.clone(), live.window_generation),
                );
            }
        }
        let projection_windows = {
            let mut projections = self
                .projection
                .windows
                .lock()
                .map_err(|_| "The native projection registry is unavailable.".to_owned())?;
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
        // Surface ownership is always acquired before individual projection windows,
        // matching unbind/readback paths and making this follower safe to block on events.
        let mut surface_owners = self
            .surface_owners
            .lock()
            .map_err(|_| "The native surface ownership registry is unavailable.".to_owned())?;
        let mut projection_guards = Vec::with_capacity(projection_windows.len());
        for (_, projection) in &projection_windows {
            projection_guards.push(
                projection
                    .lock()
                    .map_err(|_| "A native projection window is unavailable.".to_owned())?,
            );
        }
        let mut moved_bindings = HashMap::<String, Vec<SurfacePresentationBinding>>::new();
        for (index, (current_window_id, _)) in projection_windows.iter().enumerate() {
            let moving_tab_ids = projection_guards[index]
                .surface_bindings
                .keys()
                .filter(|tab_id| {
                    owner_by_tab
                        .get(*tab_id)
                        .is_some_and(|(owner_window_id, _)| owner_window_id != current_window_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            for tab_id in moving_tab_ids {
                if let Some(bindings) = projection_guards[index].surface_bindings.remove(&tab_id) {
                    moved_bindings.entry(tab_id).or_default().extend(bindings);
                }
            }
        }
        for (tab_id, bindings) in moved_bindings {
            let Some((window_id, _)) = owner_by_tab.get(&tab_id) else {
                continue;
            };
            let Some(index) = projection_windows
                .iter()
                .position(|(candidate, _)| candidate == window_id)
            else {
                continue;
            };
            projection_guards[index]
                .surface_bindings
                .entry(tab_id)
                .or_default()
                .extend(bindings);
        }
        for (index, (window_id, _)) in projection_windows.iter().enumerate() {
            for (tab_id, bindings) in &projection_guards[index].surface_bindings {
                let Some((owner_window_id, window_generation)) = owner_by_tab.get(tab_id) else {
                    // Destructive isolation owns final unbind. Retain both the
                    // binding and exact token so close projection can hide it.
                    continue;
                };
                if owner_window_id != window_id {
                    continue;
                }
                for binding in bindings {
                    let label = binding.webview.label();
                    let owner_is_unchanged = surface_owners.get(label).is_some_and(|owner| {
                        surface_owner_matches_binding(
                            owner,
                            &binding.instance_id,
                            owner_window_id,
                            *window_generation,
                        )
                    });
                    if !owner_is_unchanged {
                        let owner_epoch = self
                            .next_surface_owner_revision
                            .fetch_add(1, Ordering::AcqRel)
                            .saturating_add(1);
                        surface_owners.insert(
                            label.to_owned(),
                            SurfacePresentationOwner {
                                instance_id: binding.instance_id.clone(),
                                owner_epoch,
                                window_generation: *window_generation,
                                window_id: owner_window_id.clone(),
                            },
                        );
                    }
                }
            }
        }
        self.projection
            .membership_applied_revision
            .fetch_max(requested_revision, Ordering::AcqRel);
        Ok(())
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
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let succeeded = if runtime.presentation.projection_membership_needs_follow() {
                    match runtime.presentation.follow_live_projection_membership() {
                        Ok(()) => true,
                        Err(error) => {
                            eprintln!("Live projection membership follower failed: {error}");
                            false
                        }
                    }
                } else {
                    true
                };
                runtime
                    .presentation
                    .projection
                    .membership_retry_running
                    .store(false, Ordering::Release);
                if succeeded && runtime.presentation.projection_membership_needs_follow() {
                    runtime.schedule_live_projection_membership_follow();
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
            .map(|live| live.all_tab_ids())
            .unwrap_or_default()
    }

    fn initialize_live_window_context(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        window_generation: u64,
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
        let commit = self
            .presentation
            .live
            .apply(RuntimeIntent::InitializeWindowContext(
                KernelWindowContextInitializeInput {
                operation_id: uuid::Uuid::new_v4().to_string(),
                persisted_name: target.persisted_name.clone(),
                placement,
                target_display,
                window_generation,
                window_id: target.window_id.clone(),
                },
            ))
            .map_err(|error| error.to_string())?;
        if commit.status == RuntimeCommitStatus::Superseded {
            return Err("The native window context generation was superseded.".to_owned());
        }
        self.presentation
            .refresh_desired_native_projections(std::slice::from_ref(&target.window_id))?;
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "window-context-initialized",
            Some(&target.window_id),
            Some(window_generation),
            Some(commit.revision),
            json!({
                "persistedName": target.persisted_name,
                "presentation": target.presentation,
            }),
        );
        Ok(commit.revision)
    }

    fn update_live_window_target(
        &self,
        target: &EmbeddedLaunchTargetRecord,
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
        self.presentation
            .live
            .commit_placement(LiveWindowPlacementCommitInput {
                placement,
                placement_sequence: live.placement_sequence.saturating_add(1).max(1),
                target_display,
                window_generation: live.window_generation,
                window_id: target.window_id.clone(),
            })
            .map(|receipt| receipt.revision)
    }

    fn update_live_window_target_for_generation(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        expected_generation: u64,
    ) -> Result<Option<u64>, String> {
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
        if live.window_generation != expected_generation {
            return Ok(None);
        }
        let receipt = self.presentation.live.commit_placement(
            LiveWindowPlacementCommitInput {
                placement,
                placement_sequence: live.placement_sequence.saturating_add(1).max(1),
                target_display,
                window_generation: expected_generation,
                window_id: target.window_id.clone(),
            },
        )?;
        Ok((receipt.status != LiveTopologyCommitStatus::Superseded)
            .then_some(receipt.revision))
    }

    fn set_live_window_persisted_name(
        &self,
        window_id: &str,
        name: Option<String>,
    ) -> Result<(), String> {
        if self.presentation.existing(window_id).is_none() {
            return Ok(());
        }
        self.presentation
            .live
            .apply(RuntimeIntent::SetPersistedName {
                name,
                operation_id: uuid::Uuid::new_v4().to_string(),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
