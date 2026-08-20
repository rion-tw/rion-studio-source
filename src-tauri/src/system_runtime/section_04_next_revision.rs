impl PresentationRegistry {
    fn current_revision(&self) -> u64 {
        self.live.kernel.current_revision().unwrap_or_default()
    }

    fn assign_surface_owner(
        &self,
        surface_label: &str,
        instance_id: &str,
        window_id: &str,
    ) -> Result<u64, String> {
        let owner_epoch = self
            .next_surface_owner_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let window_generation = self
            .existing(window_id)
            .map(|live| live.window_generation)
            .unwrap_or_default();
        self.surface_owners
            .lock()
            .map_err(|_| "The native surface ownership registry is unavailable.".to_owned())?
            .insert(
                surface_label.to_owned(),
                SurfacePresentationOwner {
                    instance_id: instance_id.to_owned(),
                    owner_epoch,
                    window_generation,
                    window_id: window_id.to_owned(),
                },
            );
        Ok(owner_epoch)
    }

    fn surface_owner_tokens(
        &self,
        surface_labels: &HashSet<String>,
    ) -> HashMap<String, SurfacePresentationOwner> {
        self.surface_owners
            .lock()
            .ok()
            .map(|owners| {
                surface_labels
                    .iter()
                    .filter_map(|label| {
                        owners
                            .get(label)
                            .cloned()
                            .map(|owner| (label.clone(), owner))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn coordinator(&self, window_id: &str) -> Result<LiveWindowHandle, String> {
        if let Some(handle) = self.existing(window_id) {
            return Ok(handle);
        }
        self.live.apply(RuntimeIntent::EnsureWindow {
                operation_id: uuid::Uuid::new_v4().to_string(),
                window_id: window_id.to_owned(),
            })
            .map_err(|error| error.to_string())?;
        self.refresh_desired_native_projections(&[window_id.to_owned()])?;
        self.existing(window_id)
            .ok_or_else(|| "The runtime topology window could not be created.".to_owned())
    }

    fn projection_coordinator(
        &self,
        window_id: &str,
    ) -> Result<Arc<Mutex<NativeTabProjectionState>>, String> {
        let mut windows = self
            .projection
            .windows
            .lock()
            .map_err(|_| "The native tab projection registry is unavailable.".to_owned())?;
        Ok(Arc::clone(
            windows
                .entry(window_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(NativeTabProjectionState::default()))),
        ))
    }

    fn refresh_desired_native_projections(&self, window_ids: &[String]) -> Result<(), String> {
        let snapshot = self
            .live
            .kernel
            .snapshot()
            .map_err(|error| error.to_string())?;
        let unique_window_ids = window_ids.iter().collect::<HashSet<_>>();
        for window_id in unique_window_ids {
            let desired = snapshot.native_projection(window_id);
            let projection = self.desired_projection_coordinator(window_id)?;
            let mut projection = projection.write().map_err(|_| {
                "The desired native projection registry is unavailable.".to_owned()
            })?;
            if desired.as_ref().is_none_or(|desired| {
                projection
                    .as_ref()
                    .is_none_or(|current| current.revision <= desired.revision)
            }) {
                *projection = desired;
            }
        }
        Ok(())
    }

    fn desired_projection_coordinator(
        &self,
        window_id: &str,
    ) -> Result<Arc<RwLock<Option<RuntimeNativeProjection>>>, String> {
        let mut windows = self.projection.desired_windows.lock().map_err(|_| {
            "The desired native projection registry is unavailable.".to_owned()
        })?;
        Ok(Arc::clone(
            windows
                .entry(window_id.to_owned())
                .or_insert_with(|| Arc::new(RwLock::new(None))),
        ))
    }

    fn existing(&self, window_id: &str) -> Option<LiveWindowHandle> {
        self.live.kernel.snapshot_window(window_id).ok().flatten().map(
            |record| LiveWindowHandle {
                record,
            },
        )
    }

    fn selected_tabs(&self) -> HashMap<String, String> {
        self.snapshot_states()
            .ok()
            .map(|windows| {
                windows
                    .into_iter()
                    .filter_map(|(window_id, state)| {
                        state.selected_tab_id.map(|tab_id| (window_id, tab_id))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn window_contains_tab(&self, window_id: &str, tab_id: &str) -> bool {
        self.existing(window_id)
            .map(|state| state.contains_tab(tab_id))
            .unwrap_or(false)
    }

    fn tab(&self, window_id: &str, tab_id: &str) -> Option<LiveTabRecord> {
        self.existing(window_id)
            .and_then(|state| state.tabs.iter().find(|tab| tab.id == tab_id).cloned())
    }

    fn surfaces(&self, window_id: &str, tab_id: Option<&str>) -> Vec<Webview> {
        if tab_id.is_some_and(|tab_id| !self.statuses.permits_content_surface(tab_id)) {
            return Vec::new();
        }
        self.projection_coordinator(window_id)
            .ok()
            .and_then(|projection| {
                projection
                    .lock()
                    .ok()
                    .map(|projection| projection.surfaces(tab_id))
            })
            .unwrap_or_default()
    }

    fn bind_surface(
        &self,
        window_id: &str,
        tab_id: &str,
        binding: SurfacePresentationBinding,
    ) -> bool {
        if !self.window_contains_tab(window_id, tab_id) {
            return false;
        }
        self.projection_coordinator(window_id)
            .ok()
            .and_then(|projection| {
                projection.lock().ok().map(|mut projection| {
                    projection.bind_surface(tab_id, binding);
                })
            })
            .is_some()
    }

    fn tab_window(&self, tab_id: &str) -> Result<Option<String>, String> {
        let windows = self.snapshot_states()?;
        let mut owner = None;
        for (window_id, state) in windows {
            if !state.contains_tab(tab_id) {
                continue;
            }
            if owner.is_some() {
                return Err(format!(
                    "Runtime tab {tab_id} exists in more than one presentation window."
                ));
            }
            owner = Some(window_id);
        }
        Ok(owner)
    }

    fn snapshot_states(&self) -> Result<HashMap<String, LiveWindowRecord>, String> {
        self.live
            .kernel
            .snapshot()
            .map(|snapshot| snapshot.windows)
            .map_err(|error| error.to_string())
    }

    fn tab_for_source(&self, source_id: &str, tab_type: &str) -> Option<String> {
        self.snapshot_states().ok().and_then(|windows| {
            windows.values().find_map(|window| {
                window
                    .tabs
                    .iter()
                    .find(|tab| tab.source_id == source_id && tab.tab_type == tab_type)
                    .map(|tab| tab.id.clone())
            })
        })
    }

    #[cfg(test)]
    fn tab_for_launcher_source(&self, source_id: &str, tab_type: &str) -> Option<String> {
        self.tabs_for_launcher_source(source_id, tab_type)
            .into_iter()
            .next()
    }

    fn tabs_for_launcher_source(&self, source_id: &str, tab_type: &str) -> Vec<String> {
        let Ok(states) = self.snapshot_states() else {
            return Vec::new();
        };
        let mut windows = states.into_iter().collect::<Vec<_>>();
        windows.sort_by(|left, right| left.0.cmp(&right.0));
        windows
            .into_iter()
            .flat_map(|(_, window)| window.tabs)
            .filter_map(|tab| {
                let matches = if tab_type == "workspace" {
                    tab.tab_type == "workspace" && tab.source_id == source_id
                } else {
                    tab.role_ids.iter().any(|role_id| role_id == source_id)
                        || (tab.tab_type == "role" && tab.source_id == source_id)
                };
                matches.then_some(tab.id)
            })
            .collect()
    }

    fn launcher_presence(&self) -> Result<RuntimeLauncherPresence, String> {
        let mut windows = self.snapshot_states()?.into_iter().collect::<Vec<_>>();
        windows.sort_by(|left, right| left.0.cmp(&right.0));
        let launcher_windows = windows
            .iter()
            .filter_map(|(window_id, window)| {
                if window.tabs.is_empty() {
                    return None;
                }
                let title = window.persisted_name.clone().or_else(|| {
                    window
                        .selected_tab_id
                        .as_deref()
                        .and_then(|active_tab_id| {
                            window
                                .tabs
                                .iter()
                                .find(|tab| tab.id == active_tab_id)
                        })
                        .or_else(|| window.tabs.first())
                        .map(|tab| tab.title.clone())
                });
                Some(RuntimeLauncherPresenceWindow {
                    persisted: window.persisted_name.is_some(),
                    title: title.unwrap_or_else(|| RION_STUDIO_APP_NAME.to_owned()),
                    window_id: window_id.clone(),
                })
            })
            .collect::<Vec<_>>();
        let mut tabs = windows
            .into_iter()
            .flat_map(|(_, window)| {
                window
                    .tabs
                    .into_iter()
                    .map(|tab| RuntimeLauncherPresenceTab {
                        role_ids: tab.role_ids,
                        source_id: tab.source_id,
                        tab_id: tab.id,
                        tab_type: tab.tab_type,
                    })
            })
            .collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.tab_id.cmp(&right.tab_id));
        Ok(RuntimeLauncherPresence {
            tabs,
            windows: launcher_windows,
        })
    }

    fn actor(
        &self,
        window_id: &str,
        window_generation: u64,
    ) -> Result<Arc<NativeWindowActor>, String> {
        let mut actors = self
            .actors
            .lock()
            .map_err(|_| "The native window actor registry is unavailable.".to_owned())?;
        if let Some(actor) = actors.get(window_id)
            && actor.matches_generation(window_generation)
        {
            return Ok(Arc::clone(actor));
        }
        if let Some(stale) = actors.remove(window_id) {
            stale.stop();
        }
        let actor = NativeWindowActor::start(window_id, window_generation)?;
        actors.insert(window_id.to_owned(), Arc::clone(&actor));
        Ok(actor)
    }

    fn applied_window_visibility(&self, window_id: &str) -> Option<bool> {
        self.actors
            .lock()
            .ok()
            .and_then(|actors| actors.get(window_id).cloned())
            .and_then(|actor| actor.applied_window_visibility())
    }

    fn unbind_surface(&self, instance_id: &str, surface_label: &str) -> Option<String> {
        if let Ok(mut owners) = self.surface_owners.lock()
            && owners
                .get(surface_label)
                .is_some_and(|owner| owner.instance_id == instance_id)
        {
            owners.remove(surface_label);
        }
        let windows = self
            .projection
            .windows
            .lock()
            .ok()
            .map(|windows| {
                windows
                    .iter()
                    .map(|(window_id, projection)| (window_id.clone(), Arc::clone(projection)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (window_id, window) in windows {
            if mutate_projection_before_actor(&window, |projection| {
                projection.unbind_surface(instance_id)
            }) {
                if let Some(actor) = self
                    .actors
                    .lock()
                    .ok()
                    .and_then(|actors| actors.get(&window_id).cloned())
                {
                    actor.forget_surface(instance_id, surface_label);
                }
                return Some(window_id);
            }
        }
        None
    }

    fn remove(&self, window_id: &str) {
        let removed_tab_ids = self
            .existing(window_id)
            .map(|window| window.all_tab_ids())
            .unwrap_or_default();
        let _ = self.live.apply(RuntimeIntent::RemoveWindow {
            operation_id: uuid::Uuid::new_v4().to_string(),
            window_id: window_id.to_owned(),
        });
        if let Ok(mut windows) = self.projection.windows.lock() {
            windows.remove(window_id);
        }
        if let Ok(mut windows) = self.projection.desired_windows.lock() {
            windows.remove(window_id);
        }
        self.statuses.remove_many(&removed_tab_ids);
        if let Ok(mut actors) = self.actors.lock()
            && let Some(actor) = actors.remove(window_id)
        {
            actor.stop();
        }
    }
}

/// Applies projection bookkeeping and releases that lock before the caller enters a
/// native window actor. The actor commits its receipt back into the projection, so
/// holding both locks here would invert the actor's `actor -> projection` order.
fn mutate_projection_before_actor<T>(
    projection: &Mutex<T>,
    mutation: impl FnOnce(&mut T) -> bool,
) -> bool {
    let Ok(mut projection) = projection.lock() else {
        return false;
    };
    mutation(&mut projection)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DormantWindowState {
    Dormant,
    AwaitingRecovery,
    Restoring,
    Failed { failure_message: String },
}

impl DormantWindowState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Dormant => "dormant",
            Self::AwaitingRecovery => "awaiting-recovery",
            Self::Restoring => "restoring",
            Self::Failed { .. } => "failed",
        }
    }

    fn failure_message(&self) -> Option<&str> {
        match self {
            Self::Failed { failure_message } => Some(failure_message),
            _ => None,
        }
    }
}

fn initialize_dormant_window_state(
    state: &mut RuntimeState,
    windows: Vec<RuntimeRestoreWindowRecord>,
    session_recovery_window_ids: HashSet<String>,
) {
    state.dormant_windows = windows;
    let dormant_ids = state
        .dormant_windows
        .iter()
        .map(|window| window.id.clone())
        .collect::<HashSet<_>>();
    state.session_recovery_window_ids = session_recovery_window_ids
        .intersection(&dormant_ids)
        .cloned()
        .collect();
    state.dormant_window_states = state
        .dormant_windows
        .iter()
        .map(|window| {
            let window_state = if state.session_recovery_window_ids.contains(&window.id) {
                DormantWindowState::AwaitingRecovery
            } else {
                DormantWindowState::Dormant
            };
            (window.id.clone(), window_state)
        })
        .collect();
    if state.session_recovery_window_ids.is_empty() {
        state.recovery_interrupted_window_ids.clear();
    }
}

fn session_recovery_window_ids_for_startup(
    clean_exit: bool,
    persisted_live_window_ids: Option<&[String]>,
    restore_in_progress_window_ids: &[String],
    dormant_window_ids: &HashSet<String>,
) -> HashSet<String> {
    if clean_exit {
        return HashSet::new();
    }
    let mut recovery_window_ids = persisted_live_window_ids
        .map(|window_ids| window_ids.iter().cloned().collect::<HashSet<_>>())
        .unwrap_or_else(|| dormant_window_ids.clone());
    recovery_window_ids.extend(restore_in_progress_window_ids.iter().cloned());
    recovery_window_ids
        .intersection(dormant_window_ids)
        .cloned()
        .collect()
}

fn begin_dormant_window_restore_state(
    state: &mut RuntimeState,
    window_ids: &[String],
) -> Vec<String> {
    let dormant_ids = state
        .dormant_windows
        .iter()
        .map(|window| window.id.clone())
        .collect::<HashSet<_>>();
    let mut started = Vec::new();
    for window_id in window_ids {
        if dormant_ids.contains(window_id)
            && state.dormant_window_states.get(window_id) != Some(&DormantWindowState::Restoring)
        {
            state
                .dormant_window_states
                .insert(window_id.clone(), DormantWindowState::Restoring);
            started.push(window_id.clone());
        }
    }
    started
}

fn begin_saved_window_restore_state(
    state: &mut RuntimeState,
    windows: &[StateGameWindowRecord],
) -> Vec<String> {
    let mut started = Vec::new();
    for window in windows {
        if state.dormant_window_states.get(&window.id) == Some(&DormantWindowState::Restoring) {
            continue;
        }
        let active_source_id = window
            .active_tab_id
            .as_ref()
            .and_then(|active_tab_id| {
                window
                    .tabs
                    .iter()
                    .find(|tab| &tab.id == active_tab_id && !tab.hidden)
            })
            .or_else(|| window.tabs.iter().find(|tab| !tab.hidden))
            .map(|tab| tab.source_id.clone());
        let record = RuntimeRestoreWindowRecord {
            id: window.id.clone(),
            target_display: window.target_display.clone(),
            was_visible: true,
            active_source_id,
            tabs: window
                .tabs
                .iter()
                .map(|tab| RuntimeRestoreTabRecord {
                    tab_type: tab.tab_type.clone(),
                    source_id: tab.source_id.clone(),
                    name: tab.name.clone(),
                    role_ids: tab
                        .role_slots
                        .iter()
                        .map(|slot| slot.role_id.clone())
                        .collect(),
                    hidden: tab.hidden,
                    audio_muted: tab.audio_muted,
                })
                .collect(),
        };
        state
            .dormant_windows
            .retain(|candidate| candidate.id != window.id);
        state.dormant_windows.push(record);
        state
            .dormant_window_states
            .insert(window.id.clone(), DormantWindowState::Restoring);
        started.push(window.id.clone());
    }
    started
}

fn finish_dormant_window_restore_state(
    state: &mut RuntimeState,
    attempted_window_ids: &[String],
    restored_window_ids: &[String],
    failures: &HashMap<String, String>,
) {
    let restored_ids = restored_window_ids.iter().cloned().collect::<HashSet<_>>();
    state
        .dormant_windows
        .retain(|window| !restored_ids.contains(&window.id));
    for window_id in restored_window_ids {
        state.dormant_window_states.remove(window_id);
        state.session_recovery_window_ids.remove(window_id);
    }
    for window_id in attempted_window_ids {
        if restored_ids.contains(window_id) {
            continue;
        }
        let Some(current_state) = state.dormant_window_states.get(window_id) else {
            continue;
        };
        if current_state != &DormantWindowState::Restoring {
            continue;
        }
        let next_state = if let Some(message) = failures.get(window_id) {
            DormantWindowState::Failed {
                failure_message: message.clone(),
            }
        } else {
            DormantWindowState::Failed {
                failure_message: "The saved Game Window restore ended before completion."
                    .to_owned(),
            }
        };
        state
            .dormant_window_states
            .insert(window_id.clone(), next_state);
    }
    state
        .recovery_interrupted_window_ids
        .retain(|window_id| state.session_recovery_window_ids.contains(window_id));
    if state.session_recovery_window_ids.is_empty() {
        state.recovery_interrupted_window_ids.clear();
    }
}

fn discard_dormant_window_recovery_state(
    state: &mut RuntimeState,
    requested_window_ids: Option<&HashSet<String>>,
) -> Vec<String> {
    let discarded = state
        .session_recovery_window_ids
        .iter()
        .filter(|window_id| {
            requested_window_ids.is_none_or(|requested| requested.contains(*window_id))
                && state.dormant_window_states.get(*window_id)
                    != Some(&DormantWindowState::Restoring)
        })
        .cloned()
        .collect::<Vec<_>>();
    for window_id in &discarded {
        state.session_recovery_window_ids.remove(window_id);
        if state.dormant_window_states.contains_key(window_id) {
            state
                .dormant_window_states
                .insert(window_id.clone(), DormantWindowState::Dormant);
        }
    }
    state
        .recovery_interrupted_window_ids
        .retain(|window_id| state.session_recovery_window_ids.contains(window_id));
    discarded
}

fn fail_dormant_window_restore_state(
    state: &mut RuntimeState,
    window_ids: &[String],
    message: &str,
) -> bool {
    let mut changed = false;
    for window_id in window_ids {
        if state.dormant_window_states.get(window_id) == Some(&DormantWindowState::Restoring) {
            state.dormant_window_states.insert(
                window_id.clone(),
                DormantWindowState::Failed {
                    failure_message: message.to_owned(),
                },
            );
            changed = true;
        }
    }
    changed
}

#[derive(Default)]
struct RuntimeState {
    active_geometry_windows: HashSet<String>,
    #[cfg(not(windows))]
    active_window_resize_workers: HashSet<String>,
    allow_window_close_labels: HashSet<String>,
    audible_webviews: HashMap<String, bool>,
    auto_restore_attempted: bool,
    close_coordinator: CloseCoordinator,
    controlled_navigation_webviews: HashMap<String, u32>,
    #[cfg(feature = "desktop-e2e")]
    desktop_e2e_indeterminate_macro_input_roles: HashMap<String, bool>,
    dormant_windows: Vec<RuntimeRestoreWindowRecord>,
    dormant_window_states: HashMap<String, DormantWindowState>,
    launch_attempt_generations: HashMap<String, String>,
    main_frame_navigation_input_fences: HashMap<String, MainFrameNavigationInputFence>,
    macro_input_recoveries: HashMap<String, MacroInputRecoveryRuntimeState>,
    automatic_input_contexts: HashMap<String, RoleAutomaticInputContext>,
    role_input_fences: HashMap<String, RoleInputFence>,
    last_completed_document_ids: HashMap<String, String>,
    last_input_ready_epochs: HashMap<String, u64>,
    pending_macro_page_request: Option<Value>,
    quick_access_requests: QuickAccessRequestLedger,
    close_previews: HashMap<String, TabCloseTombstone>,
    completed_failed_launch_cleanups: HashSet<(String, String)>,
    failed_launch_diagnostics: HashMap<String, RuntimeErrorDiagnostic>,
    pending_restore_role_slots: HashMap<String, Vec<GameWindowRoleSlotRecord>>,
    pending_restore_workspace_slots: HashMap<String, Vec<StateWorkspaceSlotRecord>>,
    pending_window_tab_restores: HashMap<String, PendingWindowTabRestore>,
    pending_role_zoom_writes: HashMap<(String, String), u64>,
    #[cfg(not(windows))]
    pending_window_resizes: HashMap<String, PendingWindowResize>,
    quarantined_window_hosts: HashSet<String>,
    retiring_window_cleanup_failed: HashSet<String>,
    retiring_native_window_hosts: HashMap<String, RetiringNativeWindowHost>,
    retiring_window_revisions: HashMap<String, u64>,
    retiring_window_tabs: HashMap<String, HashSet<String>>,
    window_closes: WindowCloseLedger,
    overlay_capabilities: HashMap<String, String>,
    overlay_ready_webviews: HashSet<String>,
    popup_roles: HashMap<String, String>,
    active_provisional_launches: HashMap<String, String>,
    provisional_launches: HashMap<String, ProvisionalLaunch>,
    role_placeholder_identities: HashMap<String, RuntimeRolePlaceholderIdentity>,
    automatic_launch_retries: HashMap<String, u8>,
    retryable_failed_launches: HashSet<String>,
    recovery_interrupted_window_ids: Vec<String>,
    recovery_session_generation: u32,
    runtime_restart_required: bool,
    session_recovery_window_ids: HashSet<String>,
    startup_restore_window_ids: Option<HashSet<String>>,
    recovery_budgets: HashMap<String, RecoveryBudget>,
    recovery_generations: HashMap<String, u64>,
    recovering_roles: HashSet<String>,
    #[cfg(target_os = "macos")]
    content_layout_revisions: HashMap<String, u64>,
    #[cfg(target_os = "macos")]
    ready_surface_viewports: HashMap<String, ReadySurfaceViewportState>,
    session_import_backups: HashMap<String, NativeSessionBackup>,
    tab_drag_cursor_leases: HashMap<String, TabDragCursorLease>,
    tab_drag_placement_suppressed_windows: HashSet<String>,
    native_resources: NativeResourceRegistry,
}

impl RuntimeState {
    fn native_host_for_tab_handle(&self, tab_id: &str) -> Option<String> {
        self.native_resources
            .surface_registry
            .values()
            .chain(self.native_resources.retired_surface_registry.values())
            .find(|surface| surface.tab_id.as_deref() == Some(tab_id))
            .map(|surface| surface.window_id.clone())
    }

    fn window_has_attached_tab_handles(&self, window_id: &str) -> bool {
        self.native_resources
            .surface_registry
            .values()
            .chain(self.native_resources.retired_surface_registry.values())
            .any(|surface| surface.tab_id.is_some() && surface.window_id == window_id)
    }

    fn has_native_role_surface(&self, role_id: &str) -> bool {
        self.native_resources
            .tabs
            .values()
            .any(|tab| tab.roles.contains_key(role_id))
    }

    fn native_role_ids(&self) -> Vec<String> {
        let mut role_ids = self
            .native_resources
            .tabs
            .values()
            .flat_map(|tab| tab.roles.keys().cloned())
            .collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        role_ids
    }

    fn native_role_tab_pairs(&self) -> Vec<(String, String)> {
        self.native_resources
            .tabs
            .iter()
            .flat_map(|(tab_id, tab)| {
                tab.roles
                    .keys()
                    .map(|role_id| (role_id.clone(), tab_id.clone()))
            })
            .collect()
    }

    fn native_tab_id_for_role_surface(&self, role_id: &str) -> Option<&String> {
        self.native_resources.tabs.iter().find_map(|(tab_id, tab)| {
            tab.roles.contains_key(role_id).then_some(tab_id)
        })
    }

    fn tab_close_pending(&self, tab_id: &str) -> bool {
        self.close_previews.contains_key(tab_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RetiringNativeWindowHost {
    generation: u64,
    window_id: String,
}

struct InputReadinessRegistry {
    changed: watch::Sender<u64>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct ReadySurfaceViewportState {
    applied_layout_revision: u64,
    applied_page_revision: u64,
    instance_id: String,
    page_revision: u64,
    tab_id: String,
    window_id: String,
}

struct PendingWindowActivation {
    trigger: &'static str,
    window_generation: u64,
    window_id: String,
}

impl InputReadinessRegistry {
    fn new() -> Self {
        let (changed, _) = watch::channel(0);
        Self { changed }
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn notify(&self) {
        self.changed.send_modify(|revision| {
            *revision = revision.wrapping_add(1).max(1);
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeLaunchLatencyTrace {
    hydration_operation_id: String,
    intent_id: String,
    started_at: Instant,
}

#[derive(Clone, Debug)]
struct RestoredVisibilitySignal {
    changed: watch::Sender<Option<String>>,
    signal_id: String,
}

impl RestoredVisibilitySignal {
    fn new() -> Self {
        let (changed, _) = watch::channel(None);
        Self {
            changed,
            signal_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    fn submit(&self, operation_id: &str) {
        self.changed.send_replace(Some(operation_id.to_owned()));
    }

    fn subscribe(&self) -> watch::Receiver<Option<String>> {
        self.changed.subscribe()
    }
}

impl PartialEq for RestoredVisibilitySignal {
    fn eq(&self, other: &Self) -> bool {
        self.signal_id == other.signal_id
    }
}

impl Eq for RestoredVisibilitySignal {}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RestoredWindowVisibilityFence {
    foreground_tab_id: String,
    launch_trace: Option<RuntimeLaunchLatencyTrace>,
    reveal_dispatched: bool,
    topology_revision: u64,
    visibility_signal: RestoredVisibilitySignal,
    window_generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingWindowTabRestore {
    active_tab_id: Option<String>,
    completion_tab_ids: HashSet<String>,
    host_created: bool,
    ordered_tab_ids: Vec<String>,
    reserved_tab_ids: HashSet<String>,
    submission_complete: bool,
    successful_tab_ids: HashSet<String>,
    terminal_tab_ids: HashSet<String>,
    visibility_fence: Option<RestoredWindowVisibilityFence>,
    visible_tab_ids: Vec<String>,
}

#[derive(Clone)]
struct TabCloseTombstone {
    kernel_operation_id: String,
    parent_operation_id: Option<String>,
    revision: u64,
    retirement_revision: Option<u64>,
    slot_owners: Vec<(String, String, Option<u64>)>,
    source_id: String,
    tab_type: String,
    window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RetiringTabCleanup {
    expected_kernel_operation_id: Option<String>,
    parent_operation_id: String,
    tab_id: String,
    window_id: String,
}

pub(crate) struct RuntimeTabCloseIntent {
    pub(crate) source_id: String,
    pub(crate) tab_type: String,
}

#[derive(Clone)]
struct NativeSessionBackup {
    cookies: Vec<Cookie<'static>>,
    local_storage: Vec<(String, String)>,
    storage_touched: bool,
}

struct RoleSessionTransferRequest<'a> {
    role_id: &'a str,
    launch_url: &'a str,
    webview2_user_data_dir: &'a str,
    webkit_data_store_identifier: &'a str,
    replace_existing: bool,
    payload: SessionTransferPayloadRecord,
    backup_transaction_id: Option<&'a str>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionBackup {
    payload: SessionTransferPayloadRecord,
    storage_touched: bool,
}

struct RuntimeWebViewConfiguration {
    #[cfg(windows)]
    additional_browser_arguments: String,
    document_start_script: String,
    macos_high_refresh_mode: MacosHighRefreshMode,
    overlay_document_start_script_template: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceDiagnosticReadback {
    document_visibility_state: String,
    document_has_focus: bool,
    viewport_width: f64,
    viewport_height: f64,
    device_pixel_ratio: f64,
    hardware_concurrency: u32,
    frame_count: u32,
    observed_duration_ms: f64,
    presentation_fps: Option<f64>,
    #[serde(default)]
    primary_canvas: Option<BrowserCanvasDiagnosticRecord>,
    #[serde(default)]
    web_gl_context_attributes: Option<BrowserWebGlContextAttributesRecord>,
    #[serde(default)]
    frame_intervals_ms: Vec<f64>,
    p50_frame_interval_ms: Option<f64>,
    p95_frame_interval_ms: Option<f64>,
    p99_frame_interval_ms: Option<f64>,
    longest_frame_interval_ms: Option<f64>,
    long_task_count: Option<u32>,
    long_task_total_duration_ms: Option<f64>,
    longest_task_ms: Option<f64>,
    graphics: StateWebGraphicsRecord,
    #[serde(default)]
    game_loop_fps: Option<f64>,
    #[serde(default)]
    game_loop_p10_fps: Option<f64>,
    #[serde(default)]
    game_loop_timing_mode: Option<i32>,
    #[serde(default)]
    game_loop_timing_value: Option<f64>,
    #[serde(default)]
    game_loop_timer_drift_p95_ms: Option<f64>,
    #[serde(default)]
    context_loss_count: Option<u32>,
}

struct PerformanceDiagnosticSurface {
    high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    web_gl_configuration: RoleWebGlConfiguration,
    origin: Option<String>,
    role_id: String,
    webview: Webview,
}

struct PerformanceDiagnosticWindow {
    focused: bool,
    surfaces: Vec<PerformanceDiagnosticSurface>,
    window: Window,
    window_id: String,
}

struct PlatformPerformanceEnvironment {
    system_low_power_mode_enabled: Option<bool>,
    system_thermal_state: Option<String>,
}

#[derive(Default)]
struct PlatformWebViewDiagnostics {
    browser_process_present: Option<bool>,
    graphics_renderer: Option<String>,
    graphics_vendor: Option<String>,
    hardware_acceleration_enabled: Option<bool>,
    runtime_version: Option<String>,
    renderer_process_present: Option<bool>,
    gpu_process_present: Option<bool>,
}

struct PerformanceDiagnosticOperationState {
    cancellation: Arc<PerformanceDiagnosticCancellation>,
    operation_id: String,
    phase: BrowserPerformanceDiagnosticOperationPhase,
    revision: u64,
}

#[derive(Default)]
struct PerformanceDiagnosticCancellation {
    cancelled: AtomicBool,
    sampling_thread: Mutex<Option<thread::Thread>>,
}

impl PerformanceDiagnosticCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(owner) = self.sampling_thread.lock()
            && let Some(thread) = owner.as_ref()
        {
            thread.unpark();
        }
    }

    fn wait(&self, duration: Duration) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        if let Ok(mut owner) = self.sampling_thread.lock() {
            *owner = Some(thread::current());
        }
        let deadline = Instant::now() + duration;
        while !self.cancelled.load(Ordering::Acquire) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::park_timeout(remaining);
        }
        if let Ok(mut owner) = self.sampling_thread.lock() {
            *owner = None;
        }
        !self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
struct RuntimeShortcutModifierHandoff {
    modifier_codes: Vec<String>,
    #[cfg(windows)]
    source_role_id: Option<String>,
    source_tab_id: String,
    #[cfg(windows)]
    source_webview_label: Option<String>,
    started_at: Instant,
    window_id: String,
}

struct RoleInputDispatchLane {
    epoch: AtomicU64,
    normal_enabled: AtomicBool,
    quarantined: AtomicBool,
    sequence: Mutex<()>,
    surface_generation: AtomicU64,
}

#[derive(Debug)]
struct PendingMacroKeyObservation {
    code: String,
    input_epoch: u64,
    phase: String,
    role_id: String,
    sender: mpsc::SyncSender<MacroKeyObservationSignal>,
    surface_generation: u64,
    webview_label: String,
}

#[derive(Debug)]
enum MacroKeyObservationSignal {
    Cancelled,
    Observed,
}

impl Default for RoleInputDispatchLane {
    fn default() -> Self {
        Self {
            epoch: AtomicU64::new(0),
            normal_enabled: AtomicBool::new(true),
            quarantined: AtomicBool::new(false),
            sequence: Mutex::new(()),
            surface_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
struct InputDispatchContext {
    deadline: Instant,
    input_epoch: u64,
    intent: String,
    lane: Arc<RoleInputDispatchLane>,
    surface_generation: u64,
}

impl InputDispatchContext {
    fn is_cleanup(&self) -> bool {
        self.intent == "cleanup"
    }

    fn ensure_current(&self) -> RuntimeResult<()> {
        if self.lane.epoch.load(Ordering::Acquire) != self.input_epoch {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete role input epoch.",
            ));
        }
        if self.lane.surface_generation.load(Ordering::Acquire) != self.surface_generation {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete System WebView surface.",
            ));
        }
        if !self.is_cleanup() && !self.lane.normal_enabled.load(Ordering::Acquire) {
            return Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                "Automatic input is disabled for this role until it is restarted.",
            ));
        }
        if !self.is_cleanup() && Instant::now() >= self.deadline {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        Ok(())
    }

    fn remaining(&self, maximum: Duration) -> Duration {
        if self.is_cleanup() {
            return maximum;
        }
        self.deadline
            .saturating_duration_since(Instant::now())
            .min(maximum)
    }
}

#[derive(Clone)]
struct NativeInputSubmissionGuard {
    context: InputDispatchContext,
    state: Arc<AtomicU8>,
}

impl NativeInputSubmissionGuard {
    fn new(context: &InputDispatchContext) -> Self {
        Self {
            context: context.clone(),
            state: Arc::new(AtomicU8::new(0)),
        }
    }

    fn claim(&self) -> bool {
        self.context.ensure_current().is_ok()
            && self
                .state
                .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    fn timeout_error(&self) -> RuntimeError {
        match self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action expired before native input submission.",
            ),
            Err(2) => RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                "Native input was submitted but did not confirm before its deadline.",
            ),
            Err(_) => RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action was cancelled before native input submission.",
            ),
        }
    }
}
