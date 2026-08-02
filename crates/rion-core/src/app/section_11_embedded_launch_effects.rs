fn embedded_launch_effects(
    tab_id: &str,
    mut tab: EmbeddedTabEffectRecord,
    roles: &[StateRoleRecord],
    _runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
) -> Vec<crate::operation_actor::OperationStep> {
    let attempt_generation = uuid::Uuid::new_v4().to_string();
    tab.attempt_generation = Some(attempt_generation.clone());
    let zoom_factors = tab
        .roles
        .iter()
        .map(|role| (role.role.id.clone(), role.zoom_factor))
        .collect::<std::collections::HashMap<_, _>>();
    let resolved_engines = tab
        .roles
        .iter()
        .map(|role| (role.role.id.clone(), role.resolved_engine))
        .collect::<std::collections::HashMap<_, _>>();
    let mut create_step = effect_step(
        tab_id,
        CoreEffectAction::EmbeddedCreateTab { tab: Box::new(tab) },
        // Native creation owns its own bounded callbacks and verified cleanup. Keep the Core
        // deadline above a multi-role Windows setup so the actor never abandons a still-running
        // create transaction and races it with destroy compensation.
        Duration::from_secs(120),
        Some(CoreEffectAction::EmbeddedDestroyTab {
            tab_id: tab_id.to_owned(),
            attempt_generation: Some(attempt_generation),
            next_active_tab_id: None,
        }),
    );
    // A failed create transaction performs and verifies its own cleanup. Register native
    // destroy only after the create acknowledgement commits, so a provisional or never-created
    // tab cannot be destroyed by operation compensation.
    create_step.effect.compensate_on_rejected_result = false;
    let mut steps = vec![create_step];
    steps.push(effect_step(
        tab_id,
        CoreEffectAction::EmbeddedLoadRoles {
            roles: roles
                .iter()
                .map(|role| EmbeddedRoleLoadEffectRecord {
                    role_id: role.id.clone(),
                    resolved_engine: resolved_engines
                        .get(&role.id)
                        .copied()
                        .expect("every launched role has a resolved system engine"),
                    url: role.launch_url.clone(),
                    zoom_factor: zoom_factors.get(&role.id).copied().unwrap_or(1.0),
                })
                .collect(),
        },
        Duration::from_secs(45),
        None,
    ));
    steps
}

fn full_window_rect() -> StateNormalizedRectRecord {
    StateNormalizedRectRecord {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    }
}

fn unavailable_system_webview_runtime(
    platform: rion_platform::Platform,
) -> SystemWebViewRuntimeRegistrationRecord {
    use crate::model::{EngineCapabilitySnapshotRecord, EngineCapabilityStatus};

    SystemWebViewRuntimeRegistrationRecord {
        platform: match platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        }
        .to_owned(),
        engine: match platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        },
        adapter_version: "unregistered".to_owned(),
        available: false,
        capability_snapshot: EngineCapabilitySnapshotRecord {
            navigation: EngineCapabilityStatus::Disabled,
            persistent_session: EngineCapabilityStatus::Disabled,
            trusted_input: EngineCapabilityStatus::Disabled,
            background_input: EngineCapabilityStatus::Disabled,
            frame_evaluation: EngineCapabilityStatus::Disabled,
            popup: EngineCapabilityStatus::Disabled,
            audio_mute: EngineCapabilityStatus::Disabled,
            custom_fonts: EngineCapabilityStatus::Disabled,
            downloads: EngineCapabilityStatus::Disabled,
            file_upload: EngineCapabilityStatus::Disabled,
            permissions: EngineCapabilityStatus::Disabled,
            dialogs: EngineCapabilityStatus::Disabled,
            certificate_handling: EngineCapabilityStatus::Disabled,
        },
        failure_reason: Some(crate::model::SystemWebViewIssueReason::RuntimeCreationFailed),
    }
}

fn system_capability_available(status: crate::model::EngineCapabilityStatus) -> bool {
    matches!(
        status,
        crate::model::EngineCapabilityStatus::Supported
            | crate::model::EngineCapabilityStatus::Degraded
    )
}

fn system_capability_verified(status: crate::model::EngineCapabilityStatus) -> bool {
    status == crate::model::EngineCapabilityStatus::Supported
}

fn require_system_resolution(
    resolution: &crate::model::BrowserEngineResolutionRecord,
) -> CoreResult<()> {
    if let Some(reason) = resolution.issue_reason {
        return Err(CoreError::Domain {
            code: "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE",
            message: format!("The System WebView cannot satisfy this launch because {reason:?}."),
        });
    }
    Ok(())
}

fn embedded_launch_result(role_id: &str, launched_at: String) -> EmbeddedLaunchResultRecord {
    EmbeddedLaunchResultRecord {
        role_id: role_id.to_owned(),
        state: "running".to_owned(),
        launched_at,
        runtime_mode: "embedded".to_owned(),
    }
}

fn next_active_tab_after_removal(
    snapshot: &crate::model::BrowserRuntimeSnapshot,
    removed_tab_id: &str,
) -> Option<String> {
    let window_id = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == removed_tab_id)?
        .window_id
        .clone();
    let ordered = &snapshot
        .windows
        .iter()
        .find(|window| window.window_id == window_id)?
        .tab_ids;
    let removed_index = ordered.iter().position(|tab_id| tab_id == removed_tab_id)?;
    ordered
        .iter()
        .skip(removed_index + 1)
        .chain(ordered[..removed_index].iter().rev())
        .find(|tab_id| {
            snapshot
                .tabs
                .iter()
                .find(|tab| &tab.id == *tab_id)
                .is_some_and(|tab| !tab.hidden)
        })
        .cloned()
}

fn route_browser_action_events(
    events: Vec<CoreEvent>,
    browser_actions: &Sender<Vec<crate::model::BrowserActionRequest>>,
    event_sender: &Sender<Vec<CoreEvent>>,
) {
    let mut public_events = Vec::with_capacity(events.len());
    for event in events {
        if let CoreEvent::BrowserActions { actions } = event {
            let _ = browser_actions.send(actions);
        } else {
            public_events.push(event);
        }
    }
    if !public_events.is_empty() {
        publish_events(event_sender, public_events);
    }
}

fn start_event_dispatcher(
    subscribers: Arc<Mutex<Vec<Sender<Vec<CoreEvent>>>>>,
) -> CoreResult<Sender<Vec<CoreEvent>>> {
    let (sender, receiver) = unbounded::<Vec<CoreEvent>>();
    thread::Builder::new()
        .name("rion-core-event-dispatch".to_owned())
        .spawn(move || {
            while let Ok(events) = receiver.recv() {
                broadcast_events(&subscribers, events);
            }
        })
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    Ok(sender)
}

fn publish_events(sender: &Sender<Vec<CoreEvent>>, events: Vec<CoreEvent>) {
    let _ = sender.send(events);
}

fn broadcast_events(subscribers: &Mutex<Vec<Sender<Vec<CoreEvent>>>>, events: Vec<CoreEvent>) {
    let Ok(current) = subscribers.lock().map(|subscribers| subscribers.clone()) else {
        return;
    };
    let critical = events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::CoreEffects { .. }
                | CoreEvent::StateChanged { .. }
                | CoreEvent::BrowserStatuses { .. }
                | CoreEvent::MacroStatuses { reliable: true, .. }
                | CoreEvent::Shutdown
        )
    });
    let mut disconnected = Vec::new();
    for subscriber in current {
        let result = if critical {
            subscriber.send(events.clone()).map_err(|_| ())
        } else {
            match subscriber.try_send(events.clone()) {
                Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
                Err(TrySendError::Disconnected(_)) => Err(()),
            }
        };
        if result.is_err() {
            disconnected.push(subscriber);
        }
    }
    if disconnected.is_empty() {
        return;
    }
    if let Ok(mut subscribers) = subscribers.lock() {
        subscribers.retain(|subscriber| {
            !disconnected
                .iter()
                .any(|candidate| subscriber.same_channel(candidate))
        });
    }
}

impl Drop for AppCore {
    fn drop(&mut self) {
        self.shutdown();
    }
}
