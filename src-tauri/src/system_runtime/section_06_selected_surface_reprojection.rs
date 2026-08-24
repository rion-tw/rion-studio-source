#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectedSurfaceReprojectionFence {
    lifecycle_epoch: u64,
    revision: u64,
    tab_id: String,
    window_generation: u64,
    window_id: String,
}

#[cfg(any(windows, test))]
fn launch_phase_reprojects_selected_surfaces(phase: LaunchPhase) -> bool {
    matches!(
        phase,
        LaunchPhase::EssentialReady | LaunchPhase::Ready | LaunchPhase::Degraded
    )
}

#[cfg(any(windows, test))]
fn selected_surface_reprojection_fence_matches(
    expected: &SelectedSurfaceReprojectionFence,
    current: &LiveWindowRecord,
    lifecycle_epoch: u64,
) -> bool {
    expected.lifecycle_epoch == lifecycle_epoch
        && expected.revision == current.revision
        && expected.window_generation == current.window_generation
        && expected.window_id == current.window_id
        && current.selected_tab_id.as_deref() == Some(expected.tab_id.as_str())
}

#[cfg(any(windows, test))]
fn selected_surface_reprojection_identity_matches(
    expected_instance_id: &str,
    expected_generation: u64,
    expected_owner: &SurfacePresentationOwner,
    current_instance_id: &str,
    current_generation: u64,
    current_owner: &SurfacePresentationOwner,
) -> bool {
    expected_instance_id == current_instance_id
        && expected_generation == current_generation
        && expected_owner == current_owner
}

#[cfg(windows)]
#[derive(Clone)]
struct WindowsSelectedSurfaceReprojectionSurface {
    generation: u64,
    instance_id: String,
    owner: SurfacePresentationOwner,
    webview: Webview,
}

#[cfg(windows)]
struct WindowsSelectedSurfaceReprojectionTarget {
    fence: SelectedSurfaceReprojectionFence,
    surfaces: Vec<WindowsSelectedSurfaceReprojectionSurface>,
    window: Window,
}

#[cfg(windows)]
fn windows_desired_selected_surface_labels(tab: &RuntimeTab) -> HashSet<String> {
    let mut labels = tab
        .roles
        .values()
        .flat_map(|surface| {
            std::iter::once(surface.webview.label().to_owned()).chain(
                surface
                    .workspace_web
                    .as_ref()
                    .filter(|workspace| !workspace.fullscreen)
                    .map(|workspace| workspace.chrome.webview.label().to_owned()),
            )
        })
        .collect::<HashSet<_>>();
    labels.extend(tab.slots.values().filter_map(|slot| {
        slot.placeholder
            .as_ref()
            .map(|placeholder| placeholder.webview.label().to_owned())
    }));
    labels.extend(
        tab.dividers
            .iter()
            .map(|divider| divider.webview.label().to_owned()),
    );
    labels
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    fn schedule_windows_selected_surface_reprojection(
        &self,
        operation_id: String,
        phase: LaunchPhase,
    ) {
        let Some(runtime) = self.self_weak.get().and_then(Weak::upgrade) else {
            return;
        };
        tauri::async_runtime::spawn_blocking(move || {
            // EventBound: native presentation completion is the authoritative handoff. A stale
            // or superseded receipt never becomes permission to repair a newer projection.
            let Ok(receipt) = runtime.wait_native_operation_summary(&operation_id) else {
                return;
            };
            if matches!(
                receipt.status,
                SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
            ) {
                let Ok(_lane) = runtime.selected_surface_reprojection_lane.lock() else {
                    return;
                };
                runtime.reproject_windows_selected_surfaces(phase);
            }
        });
    }

    fn windows_selected_surface_reprojection_targets(
        &self,
    ) -> Vec<WindowsSelectedSurfaceReprojectionTarget> {
        let lifecycle_epoch = self.lifecycle_epoch();
        let Ok(live_windows) = self.presentation.snapshot_states() else {
            return Vec::new();
        };
        let provisional = {
            let Ok(state) = self.state.lock() else {
                return Vec::new();
            };
            live_windows
                .values()
                .filter_map(|live| {
                    let tab_id = live.selected_tab_id.as_ref()?;
                    if !self.presentation.statuses.permits_content_surface(tab_id)
                        || state.close_coordinator.closing_tabs.contains(tab_id)
                    {
                        return None;
                    }
                    let host = state.native_resources.display_hosts.get(&live.window_id)?;
                    if host.generation != live.window_generation {
                        return None;
                    }
                    let tab = state.native_resources.tabs.get(tab_id)?;
                    let desired_labels = windows_desired_selected_surface_labels(tab);
                    let surfaces = state
                        .native_resources
                        .surface_registry
                        .values()
                        .filter(|surface| {
                            surface.phase == ManagedSurfacePhase::Live
                                && surface.tab_id.as_deref() == Some(tab_id)
                                && surface.window_id == live.window_id
                                && surface.window_generation == live.window_generation
                                && desired_labels.contains(surface.webview.label())
                                && !state
                                    .close_coordinator
                                    .closing_webviews
                                    .contains(surface.webview.label())
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    (!surfaces.is_empty()).then(|| {
                        (
                            SelectedSurfaceReprojectionFence {
                                lifecycle_epoch,
                                revision: live.revision,
                                tab_id: tab_id.clone(),
                                window_generation: live.window_generation,
                                window_id: live.window_id.clone(),
                            },
                            host.window.clone(),
                            surfaces,
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        let surface_labels = provisional
            .iter()
            .flat_map(|(_, _, surfaces)| {
                surfaces
                    .iter()
                    .map(|surface| surface.webview.label().to_owned())
            })
            .collect::<HashSet<_>>();
        let owners = self.presentation.surface_owner_tokens(&surface_labels);
        provisional
            .into_iter()
            .filter(|(_, window, _)| {
                window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(false)
            })
            .filter_map(|(fence, window, surfaces)| {
                let surfaces = surfaces
                    .into_iter()
                    .filter_map(|surface| {
                        let owner = owners.get(surface.webview.label())?.clone();
                        surface_owner_matches_binding(
                            &owner,
                            &surface.instance_id,
                            &surface.window_id,
                            surface.window_generation,
                        )
                        .then(|| WindowsSelectedSurfaceReprojectionSurface {
                            generation: surface.generation,
                            instance_id: surface.instance_id,
                            owner,
                            webview: surface.webview,
                        })
                    })
                    .collect::<Vec<_>>();
                (!surfaces.is_empty()).then_some(WindowsSelectedSurfaceReprojectionTarget {
                    fence,
                    surfaces,
                    window,
                })
            })
            .collect()
    }

    fn windows_selected_surface_fence_is_current(
        &self,
        target: &WindowsSelectedSurfaceReprojectionTarget,
    ) -> bool {
        self.application_lifecycle_epoch_matches(target.fence.lifecycle_epoch)
            && self
                .presentation
                .existing(&target.fence.window_id)
                .is_some_and(|current| {
                    selected_surface_reprojection_fence_matches(
                        &target.fence,
                        &current,
                        self.lifecycle_epoch(),
                    )
                })
            && self
                .presentation
                .statuses
                .permits_content_surface(&target.fence.tab_id)
            && target.window.is_visible().unwrap_or(false)
            && !target.window.is_minimized().unwrap_or(false)
    }

    fn windows_selected_surface_is_current(
        &self,
        target: &WindowsSelectedSurfaceReprojectionTarget,
        surface: &WindowsSelectedSurfaceReprojectionSurface,
    ) -> bool {
        if !self.windows_selected_surface_fence_is_current(target) {
            return false;
        }
        let labels = HashSet::from([surface.webview.label().to_owned()]);
        let Some(current_owner) = self
            .presentation
            .surface_owner_tokens(&labels)
            .get(surface.webview.label())
            .cloned()
        else {
            return false;
        };
        self.state.lock().ok().is_some_and(|state| {
            let Some(host) = state
                .native_resources
                .display_hosts
                .get(&target.fence.window_id)
            else {
                return false;
            };
            let Some(tab) = state.native_resources.tabs.get(&target.fence.tab_id) else {
                return false;
            };
            let desired_labels = windows_desired_selected_surface_labels(tab);
            let Some(current) = state
                .native_resources
                .surface_registry
                .get(surface.webview.label())
            else {
                return false;
            };
            host.generation == target.fence.window_generation
                && !state
                    .close_coordinator
                    .closing_tabs
                    .contains(&target.fence.tab_id)
                && !state
                    .close_coordinator
                    .closing_webviews
                    .contains(surface.webview.label())
                && desired_labels.contains(surface.webview.label())
                && current.phase == ManagedSurfacePhase::Live
                && selected_surface_reprojection_identity_matches(
                    &surface.instance_id,
                    surface.generation,
                    &surface.owner,
                    &current.instance_id,
                    current.generation,
                    &current_owner,
                )
                && current.tab_id.as_deref() == Some(target.fence.tab_id.as_str())
                && current.window_id == target.fence.window_id
                && current.window_generation == target.fence.window_generation
        })
    }

    fn reproject_windows_selected_surfaces(&self, phase: LaunchPhase) {
        for target in self.windows_selected_surface_reprojection_targets() {
            self.reproject_windows_selected_window_surfaces(&target, phase);
        }
    }

    fn reproject_windows_selected_window_surfaces(
        &self,
        target: &WindowsSelectedSurfaceReprojectionTarget,
        phase: LaunchPhase,
    ) {
        let started = Instant::now();
        let mut results = Vec::with_capacity(target.surfaces.len());
        let mut actionable = Vec::with_capacity(target.surfaces.len());
        let mut reparented_surface_count = 0_usize;
        for surface in &target.surfaces {
            if !self.windows_selected_surface_is_current(target, surface) {
                results.push(json!({
                    "status": "stale",
                    "webviewLabel": surface.webview.label(),
                }));
                continue;
            }
            let initial = match windows_observe_selected_surface(&surface.webview, &target.window) {
                Ok(initial) => initial,
                Err(error) => {
                    results.push(json!({
                        "error": error,
                        "stage": "initial-observation",
                        "status": "indeterminate",
                        "webviewLabel": surface.webview.label(),
                    }));
                    continue;
                }
            };
            if !initial.parent_window_matches_host {
                if !self.windows_selected_surface_is_current(target, surface) {
                    results.push(json!({
                        "status": "stale",
                        "webviewLabel": surface.webview.label(),
                    }));
                    continue;
                }
                if let Err(error) = surface.webview.reparent(&target.window) {
                    results.push(json!({
                        "error": error.to_string(),
                        "stage": "reparent",
                        "status": "failed",
                        "webviewLabel": surface.webview.label(),
                    }));
                    continue;
                }
                match synchronize_windows_reparented_surfaces(
                    std::slice::from_ref(&surface.webview),
                    &target.window,
                ) {
                    Ok(_) => reparented_surface_count += 1,
                    Err(failure) => {
                        results.push(json!({
                            "error": failure.message,
                            "stage": failure.stage,
                            "status": if failure.timed_out { "indeterminate" } else { "failed" },
                            "webviewLabel": surface.webview.label(),
                        }));
                        continue;
                    }
                }
            }
            actionable.push((surface, initial));
        }

        if self.windows_selected_surface_fence_is_current(target) {
            self.hide_runtime_tab_status(&target.fence.window_id);
        }
        let bounds_projection_error = if self.windows_selected_surface_fence_is_current(target) {
            windows_force_selected_surface_bounds_projection(
                &target.window,
                &actionable
                    .iter()
                    .map(|(surface, _)| surface.webview.label().to_owned())
                    .collect::<Vec<_>>(),
            )
            .err()
        } else {
            None
        };
        for (surface, initial) in actionable {
            if !self.windows_selected_surface_is_current(target, surface) {
                results.push(json!({
                    "status": "stale",
                    "webviewLabel": surface.webview.label(),
                }));
                continue;
            }
            if let Err(error) = windows_notify_selected_surface_parent_position(&surface.webview) {
                results.push(json!({
                    "error": error,
                    "stage": "notify-parent-position",
                    "status": "indeterminate",
                    "webviewLabel": surface.webview.label(),
                }));
                continue;
            }
            if let Err(error) = surface.webview.show() {
                results.push(json!({
                    "error": error.to_string(),
                    "stage": "show",
                    "status": "failed",
                    "webviewLabel": surface.webview.label(),
                }));
                continue;
            }
            match windows_observe_selected_surface(&surface.webview, &target.window) {
                Ok(final_observation) => results.push(json!({
                    "controllerVisible": final_observation.controller_visible,
                    "finalBounds": {
                        "bottom": final_observation.bounds.bottom,
                        "left": final_observation.bounds.left,
                        "right": final_observation.bounds.right,
                        "top": final_observation.bounds.top,
                    },
                    "initialBounds": {
                        "bottom": initial.bounds.bottom,
                        "left": initial.bounds.left,
                        "right": initial.bounds.right,
                        "top": initial.bounds.top,
                    },
                    "initialControllerVisible": initial.controller_visible,
                    "initialParentWindowMatchesHost": initial.parent_window_matches_host,
                    "parentWindowMatchesHost": final_observation.parent_window_matches_host,
                    "status": if final_observation.controller_visible && final_observation.parent_window_matches_host { "applied" } else { "failed" },
                    "webviewLabel": surface.webview.label(),
                })),
                Err(error) => results.push(json!({
                    "error": error,
                    "stage": "final-observation",
                    "status": "indeterminate",
                    "webviewLabel": surface.webview.label(),
                })),
            }
        }
        self.record_windows_selected_surface_reprojection(
            target,
            phase,
            started.elapsed(),
            reparented_surface_count,
            bounds_projection_error,
            results,
        );
    }
}
