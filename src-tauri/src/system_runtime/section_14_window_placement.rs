#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObservedWindowPresentation {
    Fullscreen,
    Maximized,
    Minimized,
    Normal,
}

impl ObservedWindowPresentation {
    fn from_persisted(value: &str) -> Option<Self> {
        match value {
            "fullscreen" => Some(Self::Fullscreen),
            "maximized" => Some(Self::Maximized),
            "normal" => Some(Self::Normal),
            _ => None,
        }
    }

    fn persisted(self) -> Option<&'static str> {
        match self {
            Self::Fullscreen => Some("fullscreen"),
            Self::Maximized => Some("maximized"),
            Self::Normal => Some("normal"),
            Self::Minimized => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ObservedWindowPlacement {
    display_id: i64,
    normal_bounds: Option<StatePixelBoundsRecord>,
    presentation: ObservedWindowPresentation,
    scale_factor: f64,
    sequence: u64,
    window_generation: u64,
    window_id: String,
    work_area: StatePixelBoundsRecord,
}

#[derive(Clone, Debug)]
struct ObservedWindowPlacementReduction {
    sequence: u64,
    target: Option<EmbeddedLaunchTargetRecord>,
}

fn reduce_observed_window_placement(
    current: &EmbeddedLaunchTargetRecord,
    current_generation: u64,
    last_sequence: u64,
    observed: &ObservedWindowPlacement,
) -> Option<ObservedWindowPlacementReduction> {
    if observed.window_id != current.window_id
        || observed.window_generation != current_generation
        || observed.sequence <= last_sequence
        || !observed.scale_factor.is_finite()
        || observed.scale_factor <= 0.0
        || observed.work_area.width <= 0
        || observed.work_area.height <= 0
    {
        return None;
    }
    let Some(presentation) = observed.presentation.persisted() else {
        return Some(ObservedWindowPlacementReduction {
            sequence: observed.sequence,
            target: None,
        });
    };
    let mut target = current.clone();
    target.display_id = observed.display_id;
    target.presentation = presentation.to_owned();
    target.scale_factor = observed.scale_factor;
    target.work_area = observed.work_area.clone();
    if observed.presentation == ObservedWindowPresentation::Normal {
        let bounds = observed.normal_bounds.as_ref()?;
        if bounds.width <= 0 || bounds.height <= 0 {
            return None;
        }
        target.bounds = bounds.clone();
    }
    Some(ObservedWindowPlacementReduction {
        sequence: observed.sequence,
        target: Some(target),
    })
}

impl SystemRuntimeExecutor {
    #[cfg(not(windows))]
    fn next_window_placement_observation_sequence() -> u64 {
        WINDOW_PLACEMENT_OBSERVATION_SEQUENCE
            .fetch_add(1, Ordering::Relaxed)
            .max(1)
    }

    fn observe_native_window_placement(
        &self,
        window_id: &str,
        sequence: u64,
        presentation_hint: Option<ObservedWindowPresentation>,
    ) -> bool {
        let Some((window_generation, window, fallback)) = self.state.lock().ok().and_then(|state| {
            let host = state.native_resources.display_hosts.get(window_id)?;
            Some((host.generation, host.window.clone(), host.target.clone()))
        }) else {
            return false;
        };

        // Native getters run without the runtime-state lock. AppKit and Tauri may
        // synchronously dispatch window callbacks while answering these queries.
        let minimized = window.is_minimized().unwrap_or(false);
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let maximized = window.is_maximized().unwrap_or(false);
        let presentation = if minimized {
            ObservedWindowPresentation::Minimized
        } else if fullscreen {
            ObservedWindowPresentation::Fullscreen
        } else if let Some(presentation) = presentation_hint {
            presentation
        } else if maximized {
            ObservedWindowPresentation::Maximized
        } else {
            ObservedWindowPresentation::Normal
        };
        let scale_factor = window
            .scale_factor()
            .ok()
            .map(normalized_scale_factor)
            .unwrap_or(fallback.scale_factor.max(f64::EPSILON));
        let normal_bounds = (presentation == ObservedWindowPresentation::Normal)
            .then(|| {
                let position = window.outer_position().ok()?;
                let size = window.inner_size().ok()?;
                let (x, y) = logical_window_position(position.x, position.y, scale_factor);
                Some(StatePixelBoundsRecord {
                    x,
                    y,
                    width: (f64::from(size.width) / scale_factor).round().max(1.0) as i32,
                    height: (f64::from(size.height) / scale_factor).round().max(1.0) as i32,
                })
            })
            .flatten();
        if presentation == ObservedWindowPresentation::Normal && normal_bounds.is_none() {
            return false;
        }
        let (display_id, work_area) = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| {
                let monitor_scale = monitor.scale_factor().max(f64::EPSILON);
                let work_area = monitor.work_area();
                (
                    super::monitor_id(&monitor),
                    StatePixelBoundsRecord {
                        x: (f64::from(work_area.position.x) / monitor_scale).round() as i32,
                        y: (f64::from(work_area.position.y) / monitor_scale).round() as i32,
                        width: (f64::from(work_area.size.width) / monitor_scale).round() as i32,
                        height: (f64::from(work_area.size.height) / monitor_scale).round() as i32,
                    },
                )
            })
            .unwrap_or((fallback.display_id, fallback.work_area));
        self.commit_observed_window_placement(ObservedWindowPlacement {
            display_id,
            normal_bounds,
            presentation,
            scale_factor,
            sequence,
            window_generation,
            window_id: window_id.to_owned(),
            work_area,
        })
    }

    fn commit_observed_window_placement(&self, observed: ObservedWindowPlacement) -> bool {
        let Some(lane) = self.state.lock().ok().and_then(|state| {
            state
                .native_resources
                .display_hosts
                .get(&observed.window_id)
                .map(|host| Arc::clone(&host.placement_observation_lane))
        }) else {
            return false;
        };
        let Ok(_lane) = lane.lock() else {
            return false;
        };
        let Some((current, last_sequence)) = self.state.lock().ok().and_then(|state| {
            let host = state.native_resources.display_hosts.get(&observed.window_id)?;
            (host.generation == observed.window_generation).then(|| {
                (
                    host.target.clone(),
                    host.last_placement_observation_sequence,
                )
            })
        }) else {
            return false;
        };
        let Some(reduction) = reduce_observed_window_placement(
            &current,
            observed.window_generation,
            last_sequence,
            &observed,
        ) else {
            return false;
        };
        let Some(target) = reduction.target else {
            if let Ok(mut state) = self.state.lock()
                && let Some(host) = state.native_resources.display_hosts.get_mut(&observed.window_id)
                && host.generation == observed.window_generation
                && reduction.sequence > host.last_placement_observation_sequence
            {
                host.last_placement_observation_sequence = reduction.sequence;
            }
            return false;
        };
        match self.update_live_window_target_for_generation(
            &target,
            observed.window_generation,
        ) {
            Ok(Some(_)) => {}
            Ok(None) => return false,
            Err(error) => {
                eprintln!(
                    "Native Game Window placement commit failed: window={} error={error}",
                    observed.window_id
                );
                return false;
            }
        }
        let applied = self.state.lock().ok().is_some_and(|mut state| {
            let Some(host) = state.native_resources.display_hosts.get_mut(&observed.window_id) else {
                return false;
            };
            if host.generation != observed.window_generation
                || reduction.sequence <= host.last_placement_observation_sequence
            {
                return false;
            }
            host.target = target;
            host.last_placement_observation_sequence = reduction.sequence;
            true
        });
        if !applied {
            return false;
        }
        self.publish_projection();
        self.persist_observed_window_placement(&observed.window_id);
        self.record_presentation_event(
            LogLevel::Debug,
            "native.window-placement-observed",
            "The authoritative native window placement was committed.",
            &observed.window_id,
            None,
            self.live_topology_revision(),
            "native-placement-event",
            0,
        );
        true
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn queue_macos_window_placement_observation(
        self: &Arc<Self>,
        window_id: &str,
    ) {
        let runtime = Arc::clone(self);
        let observed_window_id = window_id.to_owned();
        let sequence = Self::next_window_placement_observation_sequence();
        if thread::Builder::new()
            .name("rion-macos-window-placement".to_owned())
            .spawn(move || {
                runtime.observe_native_window_placement(&observed_window_id, sequence, None);
            })
            .is_err()
        {
            eprintln!(
                "Native Game Window placement observer could not start: window={window_id}"
            );
        }
    }
}
