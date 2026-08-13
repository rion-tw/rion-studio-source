#[cfg(target_os = "macos")]
const READY_SURFACE_VIEWPORT_REFRESH_SCRIPT: &str = r#"
(() => {
  window.dispatchEvent(new Event("resize"));
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
})();
"#;

#[cfg(target_os = "macos")]
fn ready_surface_lifecycle_is_live(
    tab_closing: bool,
    role_closing: bool,
    webview_closing: bool,
) -> bool {
    !tab_closing && !role_closing && !webview_closing
}

#[cfg(target_os = "macos")]
impl RuntimeState {
    fn live_ready_surface_identity(
        &self,
        surface_label: &str,
    ) -> Option<(String, String, String, Webview)> {
        self.native_resources
            .tabs
            .iter()
            .find_map(|(tab_id, tab)| {
                tab.roles.iter().find_map(|(role_id, surface)| {
                    (surface.webview.label() == surface_label
                        && ready_surface_lifecycle_is_live(
                            self.close_coordinator.closing_tabs.contains(tab_id),
                            self.close_coordinator.closing_roles.contains(role_id),
                            self.close_coordinator
                                .closing_webviews
                                .contains(surface_label),
                        ))
                    .then(|| {
                        (
                            tab_id.clone(),
                            role_id.clone(),
                            surface.surface_instance_id.clone(),
                            surface.webview.clone(),
                        )
                    })
                })
            })
    }
}

impl SystemRuntimeExecutor {
    fn schedule_ready_surface_viewport_refresh(&self, webview: &Webview) {
        #[cfg(target_os = "macos")]
        {
            let surface_label = webview.label();
            let identity = self.state.lock().ok().and_then(|state| {
                state
                    .live_ready_surface_identity(surface_label)
                    .map(|(tab_id, _, instance_id, _)| (tab_id, instance_id))
            });
            let Some((tab_id, surface_instance_id)) = identity else {
                return;
            };
            let Some(window_id) = self.presentation.tab_window(&tab_id).ok().flatten() else {
                return;
            };
            let ready = self.state.lock().ok().is_some_and(|mut state| {
                let identity_is_live = state
                    .live_ready_surface_identity(surface_label)
                    .is_some_and(|(current_tab_id, _, current_instance_id, _)| {
                        current_tab_id == tab_id && current_instance_id == surface_instance_id
                    });
                if !identity_is_live {
                    state.ready_surface_viewports.remove(surface_label);
                    return false;
                }
                let layout_revision = state
                    .content_layout_revisions
                    .get(&window_id)
                    .copied()
                    .unwrap_or_default();
                let ready = state
                    .ready_surface_viewports
                    .entry(surface_label.to_owned())
                    .or_insert_with(|| ReadySurfaceViewportState {
                        applied_layout_revision: 0,
                        applied_page_revision: 0,
                        instance_id: surface_instance_id.clone(),
                        page_revision: 0,
                        tab_id: tab_id.clone(),
                        window_id: window_id.clone(),
                    });
                if ready.instance_id != surface_instance_id {
                    *ready = ReadySurfaceViewportState {
                        applied_layout_revision: 0,
                        applied_page_revision: 0,
                        instance_id: surface_instance_id.clone(),
                        page_revision: 0,
                        tab_id: tab_id.clone(),
                        window_id: window_id.clone(),
                    };
                }
                ready.page_revision = ready.page_revision.wrapping_add(1).max(1);
                if !ready_viewport_pair_needs_apply(
                    ready.page_revision,
                    layout_revision,
                    ready.applied_page_revision,
                    ready.applied_layout_revision,
                ) {
                    return false;
                }
                ready.applied_page_revision = ready.page_revision;
                ready.applied_layout_revision = layout_revision;
                true
            });
            // Page readiness and AppKit layout are independent events. A completed pair is
            // claimed exactly once; later layout revisions replay against this page revision.
            if ready
                && self.layout_runtime_tab_inner(&tab_id).is_ok()
                && self.ready_surface_identity_matches(surface_label, &surface_instance_id)
            {
                let _ = webview.eval(READY_SURFACE_VIEWPORT_REFRESH_SCRIPT);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = webview;
        }
    }

    #[cfg(target_os = "macos")]
    fn refresh_ready_surface_viewports_for_window(&self, window_id: &str) {
        let candidates = self
            .state
            .lock()
            .map(|mut state| {
                let layout_revision = {
                    let revision = state
                        .content_layout_revisions
                        .entry(window_id.to_owned())
                        .or_insert(0);
                    *revision = revision.wrapping_add(1).max(1);
                    *revision
                };
                let ready_labels = state
                    .ready_surface_viewports
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                let mut stale_labels = Vec::new();
                let mut candidates = Vec::new();
                for label in ready_labels {
                    let Some(ready) = state.ready_surface_viewports.get(&label).cloned() else {
                        continue;
                    };
                    if ready.window_id != window_id {
                        continue;
                    }
                    let current = state
                        .live_ready_surface_identity(&label)
                        .filter(|(_, _, instance_id, _)| instance_id == &ready.instance_id)
                        .map(|(tab_id, _, _, webview)| (tab_id, webview));
                    let Some((tab_id, webview)) = current else {
                        stale_labels.push(label);
                        continue;
                    };
                    if tab_id != ready.tab_id
                        || !ready_viewport_pair_needs_apply(
                            ready.page_revision,
                            layout_revision,
                            ready.applied_page_revision,
                            ready.applied_layout_revision,
                        )
                    {
                        continue;
                    }
                    if let Some(stored) = state.ready_surface_viewports.get_mut(&label) {
                        stored.applied_page_revision = ready.page_revision;
                        stored.applied_layout_revision = layout_revision;
                    }
                    candidates.push((label, ready.instance_id, tab_id, webview));
                }
                for label in stale_labels {
                    state.ready_surface_viewports.remove(&label);
                }
                candidates
            })
            .unwrap_or_default();
        for (label, instance_id, tab_id, webview) in candidates {
            if self.presentation.tab_window(&tab_id).ok().flatten().as_deref()
                != Some(window_id)
                || !self.ready_surface_identity_matches(&label, &instance_id)
            {
                continue;
            }
            let _ = webview.eval(READY_SURFACE_VIEWPORT_REFRESH_SCRIPT);
        }
    }

    #[cfg(target_os = "macos")]
    fn ready_surface_identity_matches(&self, label: &str, instance_id: &str) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state
                .live_ready_surface_identity(label)
                .is_some_and(|(_, _, current_instance_id, _)| current_instance_id == instance_id)
        })
    }
}

#[cfg(target_os = "macos")]
fn ready_viewport_pair_needs_apply(
    page_revision: u64,
    layout_revision: u64,
    applied_page_revision: u64,
    applied_layout_revision: u64,
) -> bool {
    page_revision > 0
        && layout_revision > 0
        && (page_revision != applied_page_revision
            || layout_revision != applied_layout_revision)
}

#[cfg(all(test, target_os = "macos"))]
mod ready_surface_viewport_tests {
    use super::*;

    #[test]
    fn page_and_layout_events_apply_each_revision_pair_once_in_either_order() {
        assert!(!ready_viewport_pair_needs_apply(1, 0, 0, 0));
        assert!(ready_viewport_pair_needs_apply(1, 1, 0, 0));
        assert!(!ready_viewport_pair_needs_apply(1, 1, 1, 1));
        assert!(ready_viewport_pair_needs_apply(2, 1, 1, 1));
        assert!(ready_viewport_pair_needs_apply(1, 2, 1, 1));
    }

    #[test]
    fn closing_lifecycle_fences_late_ready_surface_callbacks() {
        assert!(ready_surface_lifecycle_is_live(false, false, false));
        assert!(!ready_surface_lifecycle_is_live(true, false, false));
        assert!(!ready_surface_lifecycle_is_live(false, true, false));
        assert!(!ready_surface_lifecycle_is_live(false, false, true));
    }
}
