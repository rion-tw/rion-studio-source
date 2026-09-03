#[derive(Clone)]
struct RuntimeLogicalClose {
    attempt_id: crate::LaunchAttemptId,
    operation_id: crate::OperationId,
    source_id: String,
    surface_generation: crate::RuntimeSurfaceGeneration,
    tab_id: crate::RuntimeTabId,
    tab_type: String,
    window_generation: crate::RuntimeWindowGeneration,
    window_id: String,
}

type AppKitEventReceipt = crate::model::AppKitRuntimeEventReceiptRecord;

impl AppCore {
    fn ensure_chromium_runtime_launch_topology(
        &self,
        tab: &EmbeddedTabEffectRecord,
    ) -> CoreResult<Option<(u64, u64)>> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Ok(None);
        }
        let snapshot = self.browser_runtime.snapshot()?;
        let current = snapshot.windows.get(&tab.target.window_id);
        if current.is_some_and(|window| window.contains_tab(&tab.tab_id)) {
            let window = current.expect("checked Chromium launch topology window");
            let window = self.ensure_chromium_launch_window_context(tab, window)?;
            return Ok((self.platform == rion_platform::Platform::Macos)
                .then_some((window.window_generation, window.revision)));
        }
        let window_generation = current.map_or_else(
            || snapshot.revision.saturating_add(1).max(1),
            |window| window.window_generation,
        );
        let mut tabs = current.map_or_else(Vec::new, |window| window.tabs.clone());
        tabs.push(runtime_live_tab_from_effect(tab));
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: format!(
                    "chromium-launch-topology:{}:{}",
                    tab.target.window_id,
                    tab.attempt_generation.as_deref().unwrap_or(&tab.tab_id)
                ),
                source: "command".to_owned(),
                primary_window_id: tab.target.window_id.clone(),
                windows: vec![crate::RuntimeWindowTopologyCommit {
                    active_tab_id: Some(tab.tab_id.clone()),
                    hidden_tab_ids: current.map_or_else(std::collections::HashSet::new, |window| {
                        window.hidden_tab_ids.clone()
                    }),
                    tabs,
                    ui_sequence: current
                        .map_or(1, |window| window.ui_sequence.saturating_add(1).max(1)),
                    window_generation,
                    window_id: tab.target.window_id.clone(),
                }],
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(CoreError::Domain {
                code: "CHROMIUM_LAUNCH_TOPOLOGY_STALE",
                message: "The Chromium launch topology changed before native creation.".to_owned(),
            });
        }
        let current = self.browser_runtime.snapshot()?;
        let window =
            current
                .windows
                .get(&tab.target.window_id)
                .ok_or_else(|| CoreError::Domain {
                    code: "CHROMIUM_LAUNCH_TOPOLOGY_MISSING",
                    message: "The committed Chromium launch topology is unavailable.".to_owned(),
                })?;
        let window = self.ensure_chromium_launch_window_context(tab, window)?;
        let launch_window_generation = window.window_generation;
        let activation_attempt_id = crate::OperationId::new(format!(
            "chromium-launch-activation:{}:{}",
            tab.target.window_id,
            tab.attempt_generation.as_deref().unwrap_or(&tab.tab_id),
        ))
        .map_err(CoreError::InvalidInput)?;
        let activation = self.apply_runtime_intent(crate::RuntimeIntent::BeginTabActivation {
            operation_id: activation_attempt_id,
            tab_id: crate::RuntimeTabId::new(tab.tab_id.clone())
                .map_err(CoreError::InvalidInput)?,
            window_id: tab.target.window_id.clone(),
        })?;
        if activation.status == crate::RuntimeCommitStatus::Superseded {
            return Err(CoreError::Domain {
                code: "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                message: "The Chromium tab activation changed before native creation.".to_owned(),
            });
        }
        let current = self.browser_runtime.snapshot()?;
        let window = current.windows.get(&tab.target.window_id).ok_or_else(|| {
            CoreError::Domain {
                code: "CHROMIUM_LAUNCH_TOPOLOGY_MISSING",
                message: "The activated Chromium launch topology is unavailable.".to_owned(),
            }
        })?;
        if window.window_generation != launch_window_generation
            || !window.contains_tab(&tab.tab_id)
        {
            return Err(CoreError::Domain {
                code: "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                message: "The Chromium tab activation lost its exact launch topology.".to_owned(),
            });
        }
        Ok((self.platform == rion_platform::Platform::Macos)
            .then_some((window.window_generation, window.revision)))
    }

    fn handle_appkit_runtime_event(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
    ) -> CoreResult<AppKitEventReceipt> {
        validate_appkit_runtime_event_platform(self)?;
        validate_appkit_runtime_event_shape(&event)?;
        let primary = event
            .hosts
            .first()
            .expect("validated AppKit event has a primary host")
            .clone();
        let visibility = match &event.action {
            crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility { visible } => {
                Some(*visible)
            }
            _ => None,
        };
        if let Some(visible) = visibility {
            return self.handle_appkit_window_visibility_event(event, primary, visible);
        }
        let _event_lane = self.appkit_event_sequence.acquire()?;
        if !self.accept_appkit_event_sequence(&primary.identity, event.adapter_sequence)? {
            return self.appkit_superseded_receipt(&event, &primary, None);
        }
        let before = self.browser_runtime.snapshot()?;
        if !appkit_observations_match(&event.hosts, &before) {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        }

        match event.action.clone() {
            crate::model::AppKitRuntimeEventActionRecord::Activate { tab_id } => {
                self.apply_appkit_activate(event, primary, tab_id)
            }
            crate::model::AppKitRuntimeEventActionRecord::Reorder {
                tab_id,
                before_tab_id,
            } => self.apply_appkit_reorder(event, primary, tab_id, before_tab_id),
            crate::model::AppKitRuntimeEventActionRecord::Move {
                session_id,
                tab_id,
                source_window_id,
                target_window_id,
                before_tab_id,
                ordered_tab_ids,
                phase,
            } => self.apply_appkit_move(
                event,
                primary,
                session_id,
                tab_id,
                source_window_id,
                target_window_id,
                before_tab_id,
                ordered_tab_ids,
                phase,
            ),
            crate::model::AppKitRuntimeEventActionRecord::Stop {
                tab_id,
                ordered_tab_ids,
            } => self.apply_appkit_stop(event, primary, tab_id, ordered_tab_ids),
            crate::model::AppKitRuntimeEventActionRecord::SetTabHidden { tab_id, hidden } => {
                self.apply_appkit_tab_hidden(event, primary, tab_id, hidden)
            }
            crate::model::AppKitRuntimeEventActionRecord::SetWindowVisibility { .. } => {
                unreachable!("AppKit visibility events use their replayable EventBound lane")
            }
            crate::model::AppKitRuntimeEventActionRecord::CloseWindow => {
                self.apply_appkit_window_close(event, primary)
            }
            crate::model::AppKitRuntimeEventActionRecord::WindowState { placement_sequence } => {
                self.apply_appkit_window_state(event, primary, placement_sequence)
            }
            crate::model::AppKitRuntimeEventActionRecord::Layout { .. } => {
                self.finish_appkit_projection(event, primary, false)
            }
        }
    }

    fn accept_appkit_event_sequence(
        &self,
        identity: &crate::model::AppKitRuntimeHostIdentityRecord,
        sequence: u64,
    ) -> CoreResult<bool> {
        let mut sequences = self
            .appkit_event_sequences
            .lock()
            .map_err(|_| CoreError::Internal("AppKit event sequence lock poisoned".to_owned()))?;
        let current = sequences.get(identity).copied().unwrap_or_default();
        if sequence <= current {
            return Ok(false);
        }
        sequences.insert(identity.clone(), sequence);
        Ok(true)
    }

    fn apply_appkit_activate(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        tab_id: String,
    ) -> CoreResult<AppKitEventReceipt> {
        if primary.identity.logical_window_id
            != appkit_action_window_id(&event.action, &primary.identity.logical_window_id)
        {
            return Err(appkit_event_error(
                "APPKIT_EVENT_WINDOW_MISMATCH",
                "The AppKit activation source does not match its exact native host.",
            ));
        }
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::ActivateTab {
            expected_revision: Some(primary.topology_revision),
            operation_id: crate::OperationId::new(event.event_id.clone())
                .map_err(CoreError::InvalidInput)?,
            tab_id: crate::RuntimeTabId::new(tab_id).map_err(CoreError::InvalidInput)?,
            window_id: primary.identity.logical_window_id.clone(),
        })?;
        match commit.status {
            crate::RuntimeCommitStatus::Superseded => {
                self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"))
            }
            crate::RuntimeCommitStatus::Applied | crate::RuntimeCommitStatus::Duplicate => {
                let window_id = primary.identity.logical_window_id.clone();
                self.finish_appkit_durable_projection(event, primary, true, &[window_id])
            }
        }
    }

    fn apply_appkit_reorder(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        tab_id: String,
        before_tab_id: Option<String>,
    ) -> CoreResult<AppKitEventReceipt> {
        let snapshot = self.browser_runtime.snapshot()?;
        let mut window = snapshot
            .windows
            .get(&primary.identity.logical_window_id)
            .cloned()
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_EVENT_STALE",
                    "The AppKit reorder window is no longer live.",
                )
            })?;
        let ordered = reordered_visible_tab_ids(&window, &tab_id, before_tab_id.as_deref())?;
        window.reorder_known_tabs(&ordered);
        let commit = self.commit_appkit_topology(
            &event.event_id,
            &primary.identity.logical_window_id,
            vec![window],
        )?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        }
        let window_id = primary.identity.logical_window_id.clone();
        self.finish_appkit_durable_projection(event, primary, true, &[window_id])
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_appkit_move(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        session_id: String,
        tab_id: String,
        source_window_id: String,
        target_window_id: String,
        before_tab_id: Option<String>,
        ordered_tab_ids: Vec<String>,
        phase: String,
    ) -> CoreResult<AppKitEventReceipt> {
        if session_id.trim().is_empty() || !matches!(phase.as_str(), "hover" | "drop") {
            return Err(appkit_event_error(
                "APPKIT_DRAG_IDENTITY_INVALID",
                "The AppKit tab move session identity is invalid.",
            ));
        }
        let snapshot = self.browser_runtime.snapshot()?;
        let mut source = snapshot
            .windows
            .get(&source_window_id)
            .cloned()
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_EVENT_STALE",
                    "The AppKit drag source is no longer live.",
                )
            })?;
        let mut target = snapshot
            .windows
            .get(&target_window_id)
            .cloned()
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_EVENT_STALE",
                    "The AppKit drag target is no longer live.",
                )
            })?;
        let tab = source
            .tabs
            .iter()
            .find(|candidate| candidate.id == tab_id)
            .cloned()
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_EVENT_STALE",
                    "The AppKit drag tab no longer belongs to its source window.",
                )
            })?;
        if primary.identity.logical_window_id != target_window_id
            || appkit_observation(&event.hosts, &source_window_id).is_none()
            || appkit_observation(&event.hosts, &target_window_id).is_none()
        {
            return Err(appkit_event_error(
                "APPKIT_DRAG_HOST_FENCE_MISSING",
                "The AppKit drag did not carry both exact live host generations.",
            ));
        }
        if phase == "hover" {
            let target_expected = if source_window_id == target_window_id {
                source.tab_ids()
            } else {
                target
                    .tab_ids()
                    .into_iter()
                    .chain(std::iter::once(tab_id.clone()))
                    .collect::<Vec<_>>()
            };
            validate_exact_order(
                &ordered_tab_ids,
                &target_expected,
                &tab_id,
                before_tab_id.as_deref(),
            )?;
            return self.appkit_receipt(
                &event,
                &primary,
                crate::model::SystemRuntimeOperationStatus::Applied,
                false,
                true,
                None,
            );
        }
        if source_window_id == target_window_id {
            validate_exact_order(
                &ordered_tab_ids,
                &source.tab_ids(),
                &tab_id,
                before_tab_id.as_deref(),
            )?;
            source.reorder_known_tabs(&ordered_tab_ids);
            source.select(Some(tab_id), source.revision);
            let commit =
                self.commit_appkit_topology(&event.event_id, &target_window_id, vec![source])?;
            if commit.status == crate::RuntimeCommitStatus::Superseded {
                return self.reconcile_appkit_superseded(
                    &event,
                    &primary,
                    Some("APPKIT_EVENT_STALE"),
                );
            }
            return self.finish_appkit_durable_projection(
                event,
                primary,
                true,
                &[target_window_id],
            );
        }

        let target_expected = target
            .tab_ids()
            .into_iter()
            .chain(std::iter::once(tab_id.clone()))
            .collect::<Vec<_>>();
        validate_exact_order(
            &ordered_tab_ids,
            &target_expected,
            &tab_id,
            before_tab_id.as_deref(),
        )?;
        let source_selected = source.selected_tab_id.as_deref() == Some(tab_id.as_str());
        source.tabs.retain(|candidate| candidate.id != tab_id);
        source.hidden_tab_ids.remove(&tab_id);
        if source_selected {
            source.selected_tab_id = source.tab_ids().first().cloned();
        }
        target.tabs.retain(|candidate| candidate.id != tab_id);
        target.tabs.push(tab);
        target.reorder_known_tabs(&ordered_tab_ids);
        target.hidden_tab_ids.remove(&tab_id);
        target.selected_tab_id = Some(tab_id);
        let commit =
            self.commit_appkit_topology(&event.event_id, &target_window_id, vec![source, target])?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        }
        self.finish_appkit_durable_projection(
            event,
            primary,
            true,
            &[source_window_id, target_window_id],
        )
    }

    fn commit_appkit_topology(
        &self,
        event_id: &str,
        primary_window_id: &str,
        windows: Vec<crate::RuntimeLiveWindowRecord>,
    ) -> CoreResult<crate::RuntimeCommit> {
        self.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: event_id.to_owned(),
                source: "appKit".to_owned(),
                primary_window_id: primary_window_id.to_owned(),
                windows: windows
                    .into_iter()
                    .map(|window| crate::RuntimeWindowTopologyCommit {
                        active_tab_id: window.selected_tab_id,
                        hidden_tab_ids: window.hidden_tab_ids,
                        tabs: window.tabs,
                        ui_sequence: window.ui_sequence.saturating_add(1).max(1),
                        window_generation: window.window_generation,
                        window_id: window.window_id,
                    })
                    .collect(),
            },
        ))
    }

    fn apply_appkit_tab_hidden(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        tab_id: String,
        hidden: bool,
    ) -> CoreResult<AppKitEventReceipt> {
        let snapshot = self.browser_runtime.snapshot()?;
        let mut window = snapshot
            .windows
            .get(&primary.identity.logical_window_id)
            .cloned()
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_EVENT_STALE",
                    "The AppKit tab visibility window is no longer live.",
                )
            })?;
        if !window.tabs.iter().any(|tab| tab.id == tab_id) {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        }
        if hidden {
            window.hidden_tab_ids.insert(tab_id.clone());
            if window.selected_tab_id.as_deref() == Some(tab_id.as_str()) {
                window.selected_tab_id = window
                    .tabs
                    .iter()
                    .find(|tab| !window.hidden_tab_ids.contains(&tab.id))
                    .map(|tab| tab.id.clone());
            }
        } else {
            window.hidden_tab_ids.remove(&tab_id);
            window.selected_tab_id = Some(tab_id);
        }
        let commit = self.commit_appkit_topology(
            &event.event_id,
            &primary.identity.logical_window_id,
            vec![window],
        )?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        }
        let window_id = primary.identity.logical_window_id.clone();
        self.finish_appkit_durable_projection(event, primary, true, &[window_id])
    }
}

fn validate_appkit_runtime_event_platform(core: &AppCore) -> CoreResult<()> {
    let registration = core.browser_runtime_registration()?;
    if core.platform != rion_platform::Platform::Macos
        || core.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION
        || registration.platform != "macos"
        || registration.engine != crate::model::ResolvedBrowserEngine::Chromium
    {
        return Err(appkit_event_error(
            "APPKIT_RUNTIME_EVENT_UNAVAILABLE",
            "The privileged AppKit runtime-event lane is unavailable.",
        ));
    }
    Ok(())
}

fn appkit_projection_failure_requires_quarantine(code: &str) -> bool {
    matches!(
        code,
        "MACOS_APPKIT_CHROMIUM_PROJECTION_HOST_QUARANTINED"
            | "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED"
    )
}

fn validate_appkit_runtime_event_shape(
    event: &crate::model::AppKitRuntimeEventRecord,
) -> CoreResult<()> {
    if uuid::Uuid::parse_str(&event.event_id).is_err()
        || event.adapter_sequence == 0
        || event.hosts.is_empty()
        || event.hosts.len() > 2
    {
        return Err(appkit_event_error(
            "APPKIT_EVENT_IDENTITY_INVALID",
            "The AppKit event identity, sequence, or host scope is invalid.",
        ));
    }
    let mut logical_windows = std::collections::HashSet::new();
    let mut identities = std::collections::HashSet::new();
    for host in &event.hosts {
        let identity = &host.identity;
        if !valid_appkit_identifier(&identity.logical_window_id)
            || !valid_appkit_identifier(&identity.launch_generation)
            || identity.native_generation == 0
            || host.window_generation == 0
            || host.topology_revision == 0
            || !valid_layout_bounds(&host.content_bounds)
            || !valid_pixel_bounds(&host.normal_bounds)
            || !valid_pixel_bounds(&host.saved_work_area)
            || !matches!(
                host.presentation.as_str(),
                "normal" | "maximized" | "fullscreen"
            )
            || !logical_windows.insert(identity.logical_window_id.as_str())
            || !identities.insert(identity)
        {
            return Err(appkit_event_error(
                "APPKIT_EVENT_HOST_INVALID",
                "The AppKit event carries malformed or aliased native host evidence.",
            ));
        }
    }
    match &event.action {
        crate::model::AppKitRuntimeEventActionRecord::Move {
            source_window_id,
            target_window_id,
            ordered_tab_ids,
            ..
        } => {
            if source_window_id == target_window_id {
                if event.hosts.len() != 1 {
                    return Err(appkit_event_error(
                        "APPKIT_DRAG_HOST_FENCE_INVALID",
                        "A same-window AppKit reorder must carry one exact host.",
                    ));
                }
            } else if event.hosts.len() != 2 {
                return Err(appkit_event_error(
                    "APPKIT_DRAG_HOST_FENCE_INVALID",
                    "A cross-window AppKit move must carry both exact hosts.",
                ));
            }
            if ordered_tab_ids.is_empty() {
                return Err(appkit_event_error(
                    "APPKIT_DRAG_ORDER_INVALID",
                    "The AppKit move must carry a complete target order.",
                ));
            }
        }
        crate::model::AppKitRuntimeEventActionRecord::Stop {
            ordered_tab_ids, ..
        } if ordered_tab_ids.len()
            != ordered_tab_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len() =>
        {
            return Err(appkit_event_error(
                "APPKIT_STOP_ORDER_INVALID",
                "The AppKit stop order contains duplicate tab identities.",
            ));
        }
        crate::model::AppKitRuntimeEventActionRecord::WindowState { placement_sequence }
            if *placement_sequence == 0 =>
        {
            return Err(appkit_event_error(
                "APPKIT_PLACEMENT_SEQUENCE_INVALID",
                "The AppKit placement sequence must be positive.",
            ));
        }
        crate::model::AppKitRuntimeEventActionRecord::Layout { layout_sequence }
            if *layout_sequence == 0 =>
        {
            return Err(appkit_event_error(
                "APPKIT_LAYOUT_SEQUENCE_INVALID",
                "The AppKit layout sequence must be positive.",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn appkit_observations_match(
    observations: &[crate::model::AppKitRuntimeHostObservationRecord],
    snapshot: &crate::RuntimeSnapshot,
) -> bool {
    observations.iter().all(|observation| {
        snapshot
            .windows
            .get(&observation.identity.logical_window_id)
            .is_some_and(|window| {
                window.window_generation == observation.window_generation
                    && window.revision == observation.topology_revision
            })
    })
}

fn appkit_observation<'a>(
    observations: &'a [crate::model::AppKitRuntimeHostObservationRecord],
    window_id: &str,
) -> Option<&'a crate::model::AppKitRuntimeHostObservationRecord> {
    observations
        .iter()
        .find(|observation| observation.identity.logical_window_id == window_id)
}

fn appkit_action_window_id<'a>(
    _action: &'a crate::model::AppKitRuntimeEventActionRecord,
    primary_window_id: &'a str,
) -> &'a str {
    primary_window_id
}

fn reordered_visible_tab_ids(
    window: &crate::RuntimeLiveWindowRecord,
    tab_id: &str,
    before_tab_id: Option<&str>,
) -> CoreResult<Vec<String>> {
    let mut ordered = window.tab_ids();
    let Some(current_index) = ordered.iter().position(|candidate| candidate == tab_id) else {
        return Err(appkit_event_error(
            "APPKIT_EVENT_STALE",
            "The AppKit reorder tab is no longer visible in its source window.",
        ));
    };
    ordered.remove(current_index);
    let insertion_index = match before_tab_id {
        Some(before_tab_id) => ordered
            .iter()
            .position(|candidate| candidate == before_tab_id)
            .ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_REORDER_TARGET_INVALID",
                    "The AppKit reorder target is not a visible sibling tab.",
                )
            })?,
        None => ordered.len(),
    };
    ordered.insert(insertion_index, tab_id.to_owned());
    Ok(ordered)
}

fn validate_exact_order(
    ordered_tab_ids: &[String],
    expected_tab_ids: &[String],
    tab_id: &str,
    before_tab_id: Option<&str>,
) -> CoreResult<()> {
    let ordered_set = ordered_tab_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let expected_set = expected_tab_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let moved_index = ordered_tab_ids
        .iter()
        .position(|candidate| candidate == tab_id);
    let position_matches = match (moved_index, before_tab_id) {
        (Some(index), Some(before)) => {
            ordered_tab_ids.get(index + 1).map(String::as_str) == Some(before)
        }
        (Some(index), None) => index + 1 == ordered_tab_ids.len(),
        _ => false,
    };
    if ordered_set.len() != ordered_tab_ids.len()
        || expected_set.len() != expected_tab_ids.len()
        || ordered_set != expected_set
        || !position_matches
    {
        return Err(appkit_event_error(
            "APPKIT_DRAG_ORDER_INVALID",
            "The AppKit move order is incomplete, duplicated, or inconsistent with its insertion target.",
        ));
    }
    Ok(())
}

struct AppKitTabSurfaceLayouts {
    roles: Vec<crate::model::AppKitRuntimeRoleLayoutRecord>,
    web_surfaces: Vec<crate::model::AppKitRuntimeWebSurfaceLayoutRecord>,
    workspace_dividers: Vec<crate::model::AppKitRuntimeWorkspaceDividerLayoutRecord>,
}

struct AppKitTabSurfaceGeometry<'a> {
    content_bounds: &'a crate::model::LayoutBounds,
    active: bool,
    hidden: bool,
    window_visible: bool,
    gap: u32,
}

fn appkit_tab_surface_layouts(
    tab: &crate::RuntimeLiveTabRecord,
    browser_tab: Option<&crate::model::BrowserRuntimeTabRecord>,
    window_id: &str,
    geometry: AppKitTabSurfaceGeometry<'_>,
    owner_by_role: &std::collections::HashMap<&str, &crate::model::BrowserRuntimeRoleOwnerRecord>,
) -> CoreResult<AppKitTabSurfaceLayouts> {
    let web_slots = tab
        .workspace_slots
        .iter()
        .enumerate()
        .filter(|(_, slot)| slot.web.is_some())
        .collect::<Vec<_>>();
    let web_identities = browser_tab.map_or(&[][..], |tab| tab.web_surfaces.as_slice());
    if web_slots.len() != web_identities.len()
        || (!web_slots.is_empty()
            && browser_tab.is_none_or(|browser_tab| {
                browser_tab.id != tab.id
                    || browser_tab.window_id != window_id
                    || browser_tab
                        .attempt_generation
                        .as_deref()
                        .is_none_or(str::is_empty)
            }))
    {
        return Err(appkit_event_error(
            "APPKIT_WEB_SURFACE_IDENTITY_STALE",
            "An AppKit Web surface lost its exact tab, window, or attempt identity.",
        ));
    }
    let mut web_by_slot = std::collections::HashMap::new();
    for identity in web_identities {
        if identity.surface_id.trim().is_empty()
            || identity.slot_id.trim().is_empty()
            || web_by_slot
                .insert(identity.slot_id.as_str(), identity)
                .is_some()
        {
            return Err(appkit_event_error(
                "APPKIT_WEB_SURFACE_IDENTITY_STALE",
                "An AppKit Web surface identity is malformed or duplicated.",
            ));
        }
    }
    let roles = if tab.workspace_slots.is_empty() {
        tab.role_slots
            .iter()
            .filter(|slot| {
                owner_by_role
                    .get(slot.role_id.as_str())
                    .is_some_and(|owner| owner.tab_id == tab.id)
            })
            .map(|slot| crate::model::LayoutRoleInput {
                role_id: slot.role_id.clone(),
                rect: crate::model::LayoutRect {
                    x: slot.rect.x,
                    y: slot.rect.y,
                    width: slot.rect.width,
                    height: slot.rect.height,
                },
            })
            .collect::<Vec<_>>()
    } else {
        tab.workspace_slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                let role_id = match (&slot.role_id, &slot.web) {
                    (Some(role_id), None) => role_id.clone(),
                    (None, Some(_)) => {
                        let identity = web_by_slot.get(slot.id.as_str()).ok_or_else(|| {
                            appkit_event_error(
                                "APPKIT_WEB_SURFACE_IDENTITY_STALE",
                                "An AppKit Web slot has no exact surface identity.",
                            )
                        })?;
                        if identity.surface_id != workspace_web_surface_id(&tab.id, index) {
                            return Err(appkit_event_error(
                                "APPKIT_WEB_SURFACE_IDENTITY_STALE",
                                "An AppKit Web surface ID does not match its stable slot identity.",
                            ));
                        }
                        identity.surface_id.clone()
                    }
                    _ => {
                        return Err(appkit_event_error(
                            "APPKIT_WEB_SURFACE_IDENTITY_STALE",
                            "An AppKit workspace slot has ambiguous content identity.",
                        ));
                    }
                };
                Ok(crate::model::LayoutRoleInput {
                    role_id,
                    rect: crate::model::LayoutRect {
                        x: slot.rect.x,
                        y: slot.rect.y,
                        width: slot.rect.width,
                        height: slot.rect.height,
                    },
                })
            })
            .collect::<CoreResult<Vec<_>>>()?
    };
    if roles.is_empty() {
        return Ok(AppKitTabSurfaceLayouts {
            roles: Vec::new(),
            web_surfaces: Vec::new(),
            workspace_dividers: Vec::new(),
        });
    }
    let divider_descriptors = layout::create_dividers(&roles);
    let divider_axes = divider_descriptors
        .iter()
        .map(|divider| divider.axis.clone())
        .collect::<Vec<_>>();
    let dividers = divider_descriptors
        .into_iter()
        .map(|divider| crate::model::LayoutDividerInput {
            axis: divider.axis,
            before_role_ids: divider.before_role_ids,
            after_role_ids: divider.after_role_ids,
        })
        .collect();
    let output = crate::resolve_workspace_layout(&crate::model::WorkspaceLayoutInput {
        active: geometry.active,
        hidden: geometry.hidden,
        window_visible: geometry.window_visible,
        content_bounds: geometry.content_bounds.clone(),
        gap: geometry.gap,
        roles,
        dividers,
    });
    let attempt_generation = browser_tab
        .and_then(|tab| tab.attempt_generation.as_deref())
        .unwrap_or_default();
    let web_by_surface = web_identities
        .iter()
        .map(|identity| (identity.surface_id.as_str(), identity))
        .collect::<std::collections::HashMap<_, _>>();
    let mut role_layouts = Vec::new();
    let mut web_surface_layouts = Vec::new();
    for role in output.roles {
        if let Some(identity) = web_by_surface.get(role.role_id.as_str()) {
            web_surface_layouts.push(crate::model::AppKitRuntimeWebSurfaceLayoutRecord {
                surface_id: identity.surface_id.clone(),
                slot_id: identity.slot_id.clone(),
                tab_id: tab.id.clone(),
                attempt_generation: attempt_generation.to_owned(),
                bounds: role.bounds,
                visible: output.visible,
            });
        } else if let Some(owner) = owner_by_role
            .get(role.role_id.as_str())
            .filter(|owner| owner.tab_id == tab.id)
        {
            role_layouts.push(crate::model::AppKitRuntimeRoleLayoutRecord {
                role_id: role.role_id,
                tab_id: tab.id.clone(),
                owner_generation: owner.generation,
                bounds: role.bounds,
            });
        }
    }
    let workspace_dividers = output
        .dividers
        .into_iter()
        .map(|divider| {
            let axis = divider_axes
                .get(divider.index as usize)
                .cloned()
                .ok_or_else(|| {
                    appkit_event_error(
                        "APPKIT_WORKSPACE_DIVIDER_IDENTITY_STALE",
                        "An AppKit workspace divider lost its Core descriptor identity.",
                    )
                })?;
            Ok(crate::model::AppKitRuntimeWorkspaceDividerLayoutRecord {
                tab_id: tab.id.clone(),
                attempt_generation: attempt_generation.to_owned(),
                divider_index: divider.index,
                axis,
                bounds: divider.bounds,
                visible: output.visible,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(AppKitTabSurfaceLayouts {
        roles: role_layouts,
        web_surfaces: web_surface_layouts,
        workspace_dividers,
    })
}

fn valid_appkit_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.contains(['/', '\\', '\0'])
        && !value.chars().any(char::is_control)
}

fn valid_layout_bounds(bounds: &crate::model::LayoutBounds) -> bool {
    bounds.width > 0
        && bounds.height > 0
        && bounds.x.checked_add(bounds.width).is_some()
        && bounds.y.checked_add(bounds.height).is_some()
}

fn valid_pixel_bounds(bounds: &crate::model::StatePixelBoundsRecord) -> bool {
    bounds.width > 0
        && bounds.height > 0
        && bounds.x.checked_add(bounds.width).is_some()
        && bounds.y.checked_add(bounds.height).is_some()
}

fn appkit_event_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn runtime_live_tab_from_effect(tab: &EmbeddedTabEffectRecord) -> crate::RuntimeLiveTabRecord {
    crate::RuntimeLiveTabRecord {
        audio_muted: tab.audio_muted,
        closable: true,
        icon_data_url: None,
        id: tab.tab_id.clone(),
        persistable: true,
        role_ids: tab
            .slots
            .iter()
            .filter(|slot| slot.web.is_none())
            .map(|slot| slot.role.id.clone())
            .collect(),
        role_slots: tab
            .slots
            .iter()
            .filter(|slot| slot.web.is_none())
            .map(|slot| crate::model::GameWindowRoleSlotRecord {
                slot_id: slot.slot_id.clone(),
                role_id: slot.role.id.clone(),
                rect: slot.rect.clone(),
                browser_zoom_percent: (slot.zoom_mode == "fixed")
                    .then_some(slot.zoom_factor * 100.0),
            })
            .collect(),
        workspace_slots: tab.workspace_slots.clone(),
        source_id: tab.source_id.clone(),
        tab_type: if tab.workspace_id.is_some() {
            "workspace".to_owned()
        } else {
            "role".to_owned()
        },
        title: tab.name.clone(),
        workspace_template: tab.workspace_template.clone(),
    }
}
impl AppCore {
    fn apply_appkit_stop(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        tab_id: String,
        ordered_tab_ids: Vec<String>,
    ) -> CoreResult<AppKitEventReceipt> {
        let Some(close) = self.prepare_appkit_logical_close(
            &event.event_id,
            &primary,
            &tab_id,
            Some(&ordered_tab_ids),
        )?
        else {
            return self.reconcile_appkit_superseded(&event, &primary, Some("APPKIT_EVENT_STALE"));
        };
        let request = crate::model::RuntimeTabMutationRequestRecord {
            operation_id: close.operation_id.as_str().to_owned(),
            mutation_kind: "stop".to_owned(),
            tab_id: close.tab_id.as_str().to_owned(),
            source_window_id: primary.identity.logical_window_id.clone(),
            source_window_generation: close.window_generation.0,
            lifecycle_epoch: event.adapter_sequence,
        };
        match self.stop_embedded_tab_mutation(request, &close.source_id, &close.tab_type) {
            Ok(_) => {
                self.finish_runtime_logical_close(&close, "closed")?;
                let remaining = self.browser_runtime.snapshot()?;
                if remaining
                    .windows
                    .get(&primary.identity.logical_window_id)
                    .is_none_or(|window| window.tabs.is_empty())
                {
                    self.appkit_receipt(
                        &event,
                        &primary,
                        crate::model::SystemRuntimeOperationStatus::Applied,
                        true,
                        true,
                        None,
                    )
                } else {
                    self.finish_appkit_projection(event, primary, true)
                }
            }
            Err(error) => {
                let failure_code = error.code().to_owned();
                let _ = self.finish_runtime_logical_close(&close, "failed");
                self.appkit_receipt(
                    &event,
                    &primary,
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    true,
                    false,
                    Some(failure_code),
                )
            }
        }
    }

    fn prepare_appkit_logical_close(
        &self,
        operation_id: &str,
        observation: &crate::model::AppKitRuntimeHostObservationRecord,
        tab_id: &str,
        ordered_tab_ids: Option<&[String]>,
    ) -> CoreResult<Option<RuntimeLogicalClose>> {
        self.prepare_runtime_logical_close(
            operation_id,
            &observation.identity.logical_window_id,
            Some(observation.window_generation),
            Some(observation.topology_revision),
            tab_id,
            ordered_tab_ids,
        )
    }

    fn prepare_runtime_logical_close(
        &self,
        operation_id: &str,
        window_id: &str,
        expected_window_generation: Option<u64>,
        expected_topology_revision: Option<u64>,
        tab_id: &str,
        ordered_tab_ids: Option<&[String]>,
    ) -> CoreResult<Option<RuntimeLogicalClose>> {
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot.windows.get(window_id) else {
            return Ok(None);
        };
        if expected_window_generation
            .is_some_and(|expected| window.window_generation != expected)
            || expected_topology_revision.is_some_and(|expected| window.revision != expected)
        {
            return Ok(None);
        }
        let Some(tab) = window.tabs.iter().find(|candidate| candidate.id == tab_id) else {
            return Ok(None);
        };
        let visible_before = window.tab_ids();
        let visible_after = visible_before
            .iter()
            .filter(|candidate| candidate.as_str() != tab_id)
            .cloned()
            .collect::<Vec<_>>();
        if ordered_tab_ids.is_some_and(|ordered| ordered != visible_after) {
            return Err(appkit_event_error(
                "APPKIT_STOP_ORDER_INVALID",
                "The AppKit stop order does not match the exact remaining visible tabs.",
            ));
        }
        let successor = if window.selected_tab_id.as_deref() == Some(tab_id) {
            let closing_index = visible_before
                .iter()
                .position(|candidate| candidate == tab_id)
                .unwrap_or_default();
            visible_after
                .get(closing_index.min(visible_after.len().saturating_sub(1)))
                .cloned()
        } else {
            window.selected_tab_id.clone()
        };
        let ownership_tab = snapshot
            .browser_runtime
            .tabs
            .iter()
            .find(|candidate| candidate.id == tab_id);
        let attempt_id = snapshot
            .logical_surfaces
            .get(tab_id)
            .map(|surface| surface.attempt_id.clone())
            .or_else(|| {
                ownership_tab
                    .and_then(|tab| tab.attempt_generation.as_deref())
                    .and_then(|attempt| crate::LaunchAttemptId::new(attempt).ok())
            })
            .unwrap_or(crate::LaunchAttemptId::new(operation_id).map_err(CoreError::InvalidInput)?);
        let surface_generation = snapshot
            .logical_surfaces
            .get(tab_id)
            .map_or(crate::RuntimeSurfaceGeneration(1), |surface| {
                surface.surface_generation
            });
        let operation_id =
            crate::OperationId::new(operation_id).map_err(CoreError::InvalidInput)?;
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CloseTab {
            attempt_id: Some(attempt_id.clone()),
            expected_revision: Some(window.revision),
            operation_id: operation_id.clone(),
            surface_generation,
            successor_tab_id: successor
                .map(crate::RuntimeTabId::new)
                .transpose()
                .map_err(CoreError::InvalidInput)?,
            tab_id: crate::RuntimeTabId::new(tab_id).map_err(CoreError::InvalidInput)?,
            window_generation: crate::RuntimeWindowGeneration(window.window_generation),
            window_id: window.window_id.clone(),
        })?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Ok(None);
        }
        Ok(Some(RuntimeLogicalClose {
            attempt_id,
            operation_id,
            source_id: tab.source_id.clone(),
            surface_generation,
            tab_id: crate::RuntimeTabId::new(tab_id).map_err(CoreError::InvalidInput)?,
            tab_type: tab.tab_type.clone(),
            window_generation: crate::RuntimeWindowGeneration(window.window_generation),
            window_id: window.window_id.clone(),
        }))
    }

    fn finish_runtime_logical_close(
        &self,
        close: &RuntimeLogicalClose,
        event_kind: &str,
    ) -> CoreResult<()> {
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::NativeEvent(
            crate::NativeRuntimeEvent {
                attempt_id: close.attempt_id.clone(),
                event_kind: event_kind.to_owned(),
                operation_id: close.operation_id.clone(),
                surface_generation: close.surface_generation,
                tab_id: close.tab_id.clone(),
                window_generation: close.window_generation,
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(appkit_event_error(
                "APPKIT_CLOSE_COMPLETION_STALE",
                "The exact AppKit close completion no longer owns its logical operation.",
            ));
        }
        let remaining = self.browser_runtime.snapshot()?;
        if remaining
            .windows
            .get(&close.window_id)
            .is_some_and(|window| window.tabs.is_empty())
        {
            self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
                operation_id: format!("{}:empty-window", close.operation_id.as_str()),
                window_id: close.window_id.clone(),
            })?;
        }
        Ok(())
    }

    fn apply_appkit_window_close(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
    ) -> CoreResult<AppKitEventReceipt> {
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot
            .windows
            .get(&primary.identity.logical_window_id)
            .cloned()
        else {
            return self.appkit_superseded_receipt(&event, &primary, Some("APPKIT_EVENT_STALE"));
        };
        for (index, tab_id) in window.all_tab_ids().iter().enumerate() {
            let current = self.browser_runtime.snapshot()?;
            let Some(current_window) = current.windows.get(&window.window_id) else {
                break;
            };
            let current_observation = crate::model::AppKitRuntimeHostObservationRecord {
                window_generation: current_window.window_generation,
                topology_revision: current_window.revision,
                ..primary.clone()
            };
            let child_operation_id = format!("{}:tab:{}", event.event_id, index + 1);
            let Some(close) = self.prepare_appkit_logical_close(
                &child_operation_id,
                &current_observation,
                tab_id,
                None,
            )?
            else {
                return self.appkit_superseded_receipt(
                    &event,
                    &primary,
                    Some("APPKIT_WINDOW_CLOSE_STALE"),
                );
            };
            let request = crate::model::RuntimeTabMutationRequestRecord {
                operation_id: close.operation_id.as_str().to_owned(),
                mutation_kind: "stop".to_owned(),
                tab_id: close.tab_id.as_str().to_owned(),
                source_window_id: window.window_id.clone(),
                source_window_generation: close.window_generation.0,
                lifecycle_epoch: event.adapter_sequence,
            };
            if let Err(error) =
                self.stop_embedded_tab_mutation(request, &close.source_id, &close.tab_type)
            {
                let failure_code = error.code().to_owned();
                let _ = self.finish_runtime_logical_close(&close, "failed");
                return self.appkit_receipt(
                    &event,
                    &primary,
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    true,
                    false,
                    Some(failure_code),
                );
            }
            self.finish_runtime_logical_close(&close, "closed")?;
        }
        let remove = self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
            operation_id: format!("{}:remove-window", event.event_id),
            window_id: window.window_id,
        })?;
        if remove.status == crate::RuntimeCommitStatus::Superseded {
            return self.appkit_superseded_receipt(
                &event,
                &primary,
                Some("APPKIT_WINDOW_CLOSE_STALE"),
            );
        }
        self.appkit_receipt(
            &event,
            &primary,
            crate::model::SystemRuntimeOperationStatus::Applied,
            true,
            true,
            None,
        )
    }

    fn apply_appkit_window_state(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        placement_sequence: u64,
    ) -> CoreResult<AppKitEventReceipt> {
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitPlacement(
            crate::RuntimeWindowPlacementCommitInput {
                operation_id: event.event_id.clone(),
                placement: crate::model::GameWindowPlacementRecord {
                    normal_bounds: primary.normal_bounds.clone(),
                    saved_work_area: primary.saved_work_area.clone(),
                    presentation: primary.presentation.clone(),
                },
                placement_sequence,
                source: "appKit".to_owned(),
                target_display: primary.target_display.clone(),
                window_generation: primary.window_generation,
                window_id: primary.identity.logical_window_id.clone(),
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.reconcile_appkit_superseded(
                &event,
                &primary,
                Some("APPKIT_PLACEMENT_STALE"),
            );
        }
        self.finish_appkit_projection(event, primary, false)
    }

    fn finish_appkit_projection(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        topology_committed: bool,
    ) -> CoreResult<AppKitEventReceipt> {
        let projection = self.build_appkit_projection(&event)?;
        let quarantine_scope = projection.windows.clone();
        let native = self.run_embedded_runtime_effect(
            &primary.identity.logical_window_id,
            CoreEffectAction::EmbeddedApplyAppKitProjection {
                projection: Box::new(projection),
            },
            None,
            None,
        );
        match native {
            Ok(_) => self.appkit_receipt(
                &event,
                &primary,
                crate::model::SystemRuntimeOperationStatus::Applied,
                topology_committed,
                true,
                None,
            ),
            Err(error) if appkit_projection_failure_requires_quarantine(error.code()) => {
                let native_failure_code = error.code().to_owned();
                match self
                    .reconcile_appkit_projection_quarantine(&event.event_id, &quarantine_scope)
                {
                    Ok(()) => self.appkit_receipt(
                        &event,
                        &primary,
                        crate::model::SystemRuntimeOperationStatus::Failed,
                        false,
                        false,
                        Some(native_failure_code),
                    ),
                    Err(reconciliation_error) => self.appkit_receipt(
                        &event,
                        &primary,
                        crate::model::SystemRuntimeOperationStatus::Indeterminate,
                        false,
                        false,
                        Some(reconciliation_error.code().to_owned()),
                    ),
                }
            }
            Err(error) => self.appkit_receipt(
                &event,
                &primary,
                if topology_committed {
                    crate::model::SystemRuntimeOperationStatus::Degraded
                } else {
                    crate::model::SystemRuntimeOperationStatus::Failed
                },
                topology_committed,
                false,
                Some(error.code().to_owned()),
            ),
        }
    }

    fn finish_appkit_durable_projection(
        &self,
        event: crate::model::AppKitRuntimeEventRecord,
        primary: crate::model::AppKitRuntimeHostObservationRecord,
        topology_committed: bool,
        window_ids: &[String],
    ) -> CoreResult<AppKitEventReceipt> {
        let mut receipt = self.finish_appkit_projection(event, primary, topology_committed)?;
        if !receipt.topology_committed {
            return Ok(receipt);
        }
        if let Err(error) = self.persist_runtime_ui_windows(window_ids)
            && receipt.status == crate::model::SystemRuntimeOperationStatus::Applied
        {
            receipt.status = crate::model::SystemRuntimeOperationStatus::Degraded;
            receipt.failure_code = Some(error.code().to_owned());
        }
        Ok(receipt)
    }

    fn reconcile_appkit_projection_quarantine(
        &self,
        event_id: &str,
        projections: &[crate::model::AppKitRuntimeWindowProjectionRecord],
    ) -> CoreResult<()> {
        for projection in projections {
            let window_id = projection.identity.logical_window_id.as_str();
            let tab_ids = projection
                .tabs
                .iter()
                .map(|tab| tab.tab_id.clone())
                .collect::<Vec<_>>();
            let snapshot = self.browser_runtime.snapshot()?;
            let window = snapshot.windows.get(window_id).ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_PROJECTION_QUARANTINE_STALE",
                    "The quarantined AppKit window is no longer in the exact Core topology.",
                )
            })?;
            if window.window_generation != projection.window_generation
                || window.revision != projection.topology_revision
                || window.tab_ids() != tab_ids
                || window.selected_tab_id != projection.active_tab_id
            {
                return Err(appkit_event_error(
                    "APPKIT_PROJECTION_QUARANTINE_STALE",
                    "The quarantined AppKit window changed before Core teardown.",
                ));
            }
            let request = crate::model::RuntimeWindowStopRequestRecord {
                parent_operation_id: format!("{event_id}:appkit-projection-quarantine:{window_id}"),
                window_id: window_id.to_owned(),
                window_generation: projection.window_generation,
                topology_revision: projection.topology_revision,
                tab_ids,
                intent_origin: "appKitProjectionQuarantine".to_owned(),
                admission_id: None,
                closing_tabs: Vec::new(),
            };
            self.stop_embedded_window(&request, false)?;

            let after_native = self.browser_runtime.snapshot()?;
            let current = after_native.windows.get(window_id).ok_or_else(|| {
                appkit_event_error(
                    "APPKIT_PROJECTION_QUARANTINE_STALE",
                    "The quarantined AppKit window disappeared before Core removal.",
                )
            })?;
            if current.window_generation != request.window_generation
                || current.revision != request.topology_revision
                || current.tab_ids() != request.tab_ids
            {
                return Err(appkit_event_error(
                    "APPKIT_PROJECTION_QUARANTINE_STALE",
                    "The quarantined AppKit window changed during Core teardown.",
                ));
            }
            self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
                operation_id: format!("{event_id}:remove-quarantined-appkit-window:{window_id}"),
                window_id: window_id.to_owned(),
            })?;
        }
        Ok(())
    }

    fn build_appkit_projection(
        &self,
        event: &crate::model::AppKitRuntimeEventRecord,
    ) -> CoreResult<crate::model::AppKitRuntimeProjectionEffectRecord> {
        let snapshot = self.browser_runtime.snapshot()?;
        let settings = self
            .read_typed_snapshot()?
            .game_browser_settings
            .ok_or_else(|| {
                CoreError::StateDatabase("game browser settings are missing".to_owned())
            })?;
        let owner_by_role = snapshot
            .browser_runtime
            .roles
            .iter()
            .filter(|role| role.state == "running")
            .map(|role| (role.role_id.as_str(), &role.owner))
            .collect::<std::collections::HashMap<_, _>>();
        let browser_tab_by_id = snapshot
            .browser_runtime
            .tabs
            .iter()
            .map(|tab| (tab.id.as_str(), tab))
            .collect::<std::collections::HashMap<_, _>>();
        let mut windows = Vec::with_capacity(event.hosts.len());
        for observation in &event.hosts {
            let Some(window) = snapshot
                .windows
                .get(&observation.identity.logical_window_id)
            else {
                continue;
            };
            let mut roles = Vec::new();
            let mut web_surfaces = Vec::new();
            let mut workspace_dividers = Vec::new();
            for tab in &window.tabs {
                let active = window.selected_tab_id.as_deref() == Some(tab.id.as_str());
                let layouts = appkit_tab_surface_layouts(
                    tab,
                    browser_tab_by_id.get(tab.id.as_str()).copied(),
                    &window.window_id,
                    AppKitTabSurfaceGeometry {
                        content_bounds: &observation.content_bounds,
                        active,
                        hidden: window.hidden_tab_ids.contains(&tab.id),
                        window_visible: observation.visible && !observation.minimized,
                        gap: settings.workspace.gap,
                    },
                    &owner_by_role,
                )?;
                if active {
                    roles = layouts.roles;
                    workspace_dividers = layouts.workspace_dividers;
                }
                web_surfaces.extend(layouts.web_surfaces);
            }
            windows.push(crate::model::AppKitRuntimeWindowProjectionRecord {
                identity: observation.identity.clone(),
                adapter_sequence: event.adapter_sequence,
                window_generation: window.window_generation,
                topology_revision: window.revision,
                logical_tab_ids: window.tabs.iter().map(|tab| tab.id.clone()).collect(),
                hidden_tab_ids: window
                    .tabs
                    .iter()
                    .filter(|tab| window.hidden_tab_ids.contains(&tab.id))
                    .map(|tab| tab.id.clone())
                    .collect(),
                tabs: window
                    .tabs
                    .iter()
                    .filter(|tab| !window.hidden_tab_ids.contains(&tab.id))
                    .map(|tab| crate::model::AppKitRuntimeTabProjectionRecord {
                        tab_id: tab.id.clone(),
                        name: tab.title.clone(),
                        phase: snapshot
                            .tab_activations
                            .get(&tab.id)
                            .filter(|activation| {
                                activation.owner_window_id == window.window_id
                                    && activation.window_generation.0 == window.window_generation
                            })
                            .map(|activation| activation.phase)
                            .unwrap_or(crate::model::RuntimeTabActivationPhaseRecord::Ready),
                        tab_type: tab.tab_type.clone(),
                        workspace_template: tab.workspace_template.clone(),
                        audio_muted: tab.audio_muted,
                    })
                    .collect(),
                active_tab_id: window.selected_tab_id.clone(),
                roles,
                web_surfaces,
                workspace_dividers,
                window_visible: observation.visible && !observation.minimized,
            });
        }
        if windows.is_empty() {
            return Err(appkit_event_error(
                "APPKIT_PROJECTION_STALE",
                "No exact live AppKit host remains for this Core projection.",
            ));
        }
        Ok(crate::model::AppKitRuntimeProjectionEffectRecord {
            event_id: event.event_id.clone(),
            windows,
        })
    }

    fn appkit_superseded_receipt(
        &self,
        event: &crate::model::AppKitRuntimeEventRecord,
        primary: &crate::model::AppKitRuntimeHostObservationRecord,
        failure_code: Option<&str>,
    ) -> CoreResult<AppKitEventReceipt> {
        self.appkit_receipt(
            event,
            primary,
            crate::model::SystemRuntimeOperationStatus::Superseded,
            false,
            false,
            failure_code.map(str::to_owned),
        )
    }

    fn reconcile_appkit_superseded(
        &self,
        event: &crate::model::AppKitRuntimeEventRecord,
        primary: &crate::model::AppKitRuntimeHostObservationRecord,
        failure_code: Option<&str>,
    ) -> CoreResult<AppKitEventReceipt> {
        let projection = match self.build_appkit_projection(event) {
            Ok(projection) => projection,
            Err(error) if error.code() == "APPKIT_PROJECTION_STALE" => {
                return self.appkit_superseded_receipt(
                    event,
                    primary,
                    failure_code.or(Some(error.code())),
                );
            }
            Err(error) => {
                return self.appkit_receipt(
                    event,
                    primary,
                    crate::model::SystemRuntimeOperationStatus::Failed,
                    false,
                    false,
                    Some(error.code().to_owned()),
                );
            }
        };
        match self.run_embedded_runtime_effect(
            &primary.identity.logical_window_id,
            CoreEffectAction::EmbeddedApplyAppKitProjection {
                projection: Box::new(projection),
            },
            None,
            None,
        ) {
            Ok(_) => self.appkit_receipt(
                event,
                primary,
                crate::model::SystemRuntimeOperationStatus::Superseded,
                false,
                true,
                failure_code.map(str::to_owned),
            ),
            Err(error) => self.appkit_receipt(
                event,
                primary,
                crate::model::SystemRuntimeOperationStatus::Failed,
                false,
                false,
                Some(error.code().to_owned()),
            ),
        }
    }

    fn appkit_receipt(
        &self,
        event: &crate::model::AppKitRuntimeEventRecord,
        primary: &crate::model::AppKitRuntimeHostObservationRecord,
        status: crate::model::SystemRuntimeOperationStatus,
        topology_committed: bool,
        native_applied: bool,
        failure_code: Option<String>,
    ) -> CoreResult<AppKitEventReceipt> {
        let snapshot = self.browser_runtime.snapshot()?;
        let current = snapshot.windows.get(&primary.identity.logical_window_id);
        Ok(crate::model::AppKitRuntimeEventReceiptRecord {
            event_id: event.event_id.clone(),
            adapter_sequence: event.adapter_sequence,
            status,
            topology_committed,
            native_applied,
            window_generation: current
                .map_or(primary.window_generation, |window| window.window_generation),
            topology_revision: current.map_or(snapshot.revision, |window| window.revision),
            failure_code,
        })
    }
}
