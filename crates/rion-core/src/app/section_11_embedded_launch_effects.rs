struct EmbeddedWebSurfaceLoadPlan {
    profile: crate::model::GlobalWebProfilePathsRecord,
    surfaces: Vec<crate::model::EmbeddedWebSurfaceLoadEffectRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EmbeddedLaunchPresentationIntent {
    Foreground,
    RestoreHydration,
}

struct EmbeddedLaunchOwnershipProjection {
    presentation_intent: EmbeddedLaunchPresentationIntent,
    windows: Vec<crate::model::EmbeddedRuntimeWindowProjectionRecord>,
}

fn embedded_launch_effects(
    tab_id: &str,
    mut tab: EmbeddedTabEffectRecord,
    roles: &[StateRoleRecord],
    runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
    lifecycle_epoch: u64,
    web_surface_load: Option<EmbeddedWebSurfaceLoadPlan>,
    ownership_projection: Option<EmbeddedLaunchOwnershipProjection>,
) -> CoreResult<Vec<crate::operation_actor::OperationStep>> {
    let attempt_generation = tab
        .attempt_generation
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
    let managed_role_loads = roles
        .iter()
        .map(|role| {
            Ok(EmbeddedRoleLoadEffectRecord {
                role_id: role.id.clone(),
                resolved_engine: resolved_engines.get(&role.id).copied().ok_or_else(|| {
                    invalid_web_surface_effect(
                        "A managed role is missing its exact native launch view.",
                    )
                })?,
                url: role.launch_url.clone(),
                zoom_factor: zoom_factors.get(&role.id).copied().ok_or_else(|| {
                    invalid_web_surface_effect(
                        "A managed role is missing its exact native zoom projection.",
                    )
                })?,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let focus_window_id = tab.target.window_id.clone();
    let create_step = effect_step(
        tab_id,
        CoreEffectAction::EmbeddedCreateTab { tab: Box::new(tab) },
        // Native creation owns its own bounded callbacks and verified cleanup. Keep the Core
        // deadline above a multi-role Windows setup so the actor never abandons a still-running
        // create transaction and races it with destroy compensation.
        Duration::from_secs(120),
        None,
    );
    // The live tab is visible before role navigation finishes. Later launch
    // failure retains that tab as a retryable presentation; it may never issue
    // a topology compensation that removes the user's tab.
    let mut steps = vec![create_step];
    if let Some(ownership_projection) = ownership_projection {
        let windows = ownership_projection.windows;
        let exact_launch_window = windows.iter().any(|window| {
            window.window_id == focus_window_id
                && window.active_tab_id.as_deref() == Some(tab_id)
                && window.tab_ids.iter().any(|candidate| candidate == tab_id)
                && window.window_generation > 0
                && window.topology_revision > 0
        });
        if !exact_launch_window {
            return Err(CoreError::Domain {
                code: "CHROMIUM_LAUNCH_FOCUS_PROJECTION_INVALID",
                message: "The Chromium launch is missing its exact committed window and active-tab fence."
                    .to_owned(),
            });
        }
        let requests_foreground = ownership_projection.presentation_intent
            == EmbeddedLaunchPresentationIntent::Foreground;
        let (reveal_window_ids, focus_window_ids, focus_tab_id) = if requests_foreground {
            (
                vec![focus_window_id.clone()],
                vec![focus_window_id],
                Some(tab_id.to_owned()),
            )
        } else {
            (Vec::new(), Vec::new(), None)
        };
        steps.push(effect_step(
            tab_id,
            CoreEffectAction::EmbeddedFollowRoleOwnership {
                lifecycle_epoch,
                roles: runtime_snapshot.roles,
                windows,
                target: None,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            },
            Duration::from_secs(15),
            None,
        ));
    }
    if web_surface_load.is_none() || !managed_role_loads.is_empty() {
        steps.push(effect_step(
            tab_id,
            CoreEffectAction::EmbeddedLoadRoles {
                roles: managed_role_loads,
            },
            Duration::from_secs(45),
            None,
        ));
    }
    if let Some(web_surface_load) = web_surface_load {
        steps.push(effect_step(
            tab_id,
            CoreEffectAction::EmbeddedLoadWebSurfaces {
                tab_id: tab_id.to_owned(),
                attempt_generation,
                profile: web_surface_load.profile,
                surfaces: web_surface_load.surfaces,
            },
            Duration::from_secs(45),
            None,
        ));
    }
    Ok(steps)
}

fn embedded_web_surface_load_plan(
    tab: &EmbeddedTabEffectRecord,
    profile: Option<crate::model::GlobalWebProfilePathsRecord>,
) -> CoreResult<Option<EmbeddedWebSurfaceLoadPlan>> {
    let Some(profile) = profile else {
        return Ok(None);
    };
    crate::global_web_profile::validate(&profile)?;
    let web_slots = tab
        .slots
        .iter()
        .filter(|slot| slot.web.is_some())
        .collect::<Vec<_>>();
    let web_views = tab
        .roles
        .iter()
        .filter(|view| view.web.is_some())
        .collect::<Vec<_>>();
    if web_slots.is_empty() || web_slots.len() != web_views.len() {
        return Err(invalid_web_surface_effect(
            "The global Web profile does not have an exact Web slot and view set.",
        ));
    }

    let mut surface_ids = std::collections::HashSet::new();
    let mut slot_ids = std::collections::HashSet::new();
    let mut surfaces = Vec::with_capacity(web_slots.len());
    for slot in web_slots {
        let Some(web) = slot.web.as_ref() else {
            return Err(invalid_web_surface_effect(
                "A planned Web surface no longer belongs to a Web slot.",
            ));
        };
        let mut matching_views = web_views.iter().filter(|view| view.role.id == slot.role.id);
        let view = matching_views.next().ok_or_else(|| {
            invalid_web_surface_effect("A Web slot is missing its exact native launch view.")
        })?;
        if matching_views.next().is_some()
            || slot.slot_id.trim().is_empty()
            || slot.role.id.trim().is_empty()
            || !slot_ids.insert(slot.slot_id.as_str())
            || !surface_ids.insert(slot.role.id.as_str())
            || view.web.as_ref() != Some(web)
            || view.role.name != web.name
            || view.role.launch_url != web.start_url
            || slot.role.name != web.name
            || slot.role.launch_url != web.start_url
            || view.rect != slot.rect
            || view.zoom_factor != slot.zoom_factor
            || view.zoom_mode != slot.zoom_mode
            || !slot.zoom_factor.is_finite()
            || !(0.25..=5.0).contains(&slot.zoom_factor)
            || view.resolved_engine != crate::model::ResolvedBrowserEngine::Chromium
        {
            return Err(invalid_web_surface_effect(
                "A Web surface does not match its exact slot, view, URL, zoom, or Chromium engine.",
            ));
        }
        surfaces.push(crate::model::EmbeddedWebSurfaceLoadEffectRecord {
            surface_id: slot.role.id.clone(),
            slot_id: slot.slot_id.clone(),
            url: web.start_url.clone(),
            zoom_factor: slot.zoom_factor,
            resolved_engine: view.resolved_engine,
        });
    }
    if tab
        .roles
        .iter()
        .filter(|view| view.web.is_some())
        .any(|view| !surface_ids.contains(view.role.id.as_str()))
    {
        return Err(invalid_web_surface_effect(
            "A Web launch view is not owned by an exact workspace slot.",
        ));
    }
    Ok(Some(EmbeddedWebSurfaceLoadPlan { profile, surfaces }))
}

fn invalid_web_surface_effect(message: &str) -> CoreError {
    CoreError::Domain {
        code: "GLOBAL_WEB_SURFACE_EFFECT_INVALID",
        message: message.to_owned(),
    }
}

fn full_window_rect() -> StateNormalizedRectRecord {
    StateNormalizedRectRecord {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    }
}

fn workspace_web_surface_role(
    tab_id: &str,
    slot_index: usize,
    web: &crate::model::WorkspaceWebContentRecord,
) -> StateRoleRecord {
    StateRoleRecord {
        id: workspace_web_surface_id(tab_id, slot_index),
        game_id: "workspace-web".to_owned(),
        name: web.name.clone(),
        launch_url: web.start_url.clone(),
        notes: String::new(),
        cover_image_data_url: None,
        cover_image_dominant_color: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn workspace_web_surface_id(tab_id: &str, slot_index: usize) -> String {
    format!("web-{tab_id}-{}", slot_index + 1)
}

fn unavailable_browser_runtime_registration(
    platform: rion_platform::Platform,
    contract_version: u32,
) -> BrowserRuntimeRegistrationRecord {
    use crate::model::{EngineCapabilitySnapshotRecord, EngineCapabilityStatus};

    BrowserRuntimeRegistrationRecord {
        contract_version,
        platform: match platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        }
        .to_owned(),
        engine: if contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION {
            crate::model::ResolvedBrowserEngine::Chromium
        } else {
            match platform {
                rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
                rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
            }
        },
        adapter_version: "unregistered".to_owned(),
        available: false,
        capabilities: EngineCapabilitySnapshotRecord {
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
        failure_reason: Some(crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed),
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

fn require_browser_runtime_resolution(
    resolution: &crate::model::BrowserEngineResolutionRecord,
) -> CoreResult<()> {
    if let Some(reason) = resolution.issue_reason {
        return match resolution.host_kind {
            crate::model::BrowserHostKind::SystemNative => Err(CoreError::Domain {
                code: "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE",
                message: format!(
                    "The System WebView cannot satisfy this launch because {reason:?}."
                ),
            }),
            crate::model::BrowserHostKind::AppkitChromium
            | crate::model::BrowserHostKind::BundledChromium => Err(CoreError::Domain {
                code: "BROWSER_RUNTIME_CAPABILITY_UNAVAILABLE",
                message: format!(
                    "The bundled Chromium runtime cannot satisfy this launch because {reason:?}."
                ),
            }),
        };
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
                | CoreEvent::CoreEffectCancellations { .. }
                | CoreEvent::StateChanged { .. }
                | CoreEvent::BrowserStatuses { .. }
                | CoreEvent::BrowserLaunchCompleted { .. }
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
        if let Err(error) = self.shutdown_checked() {
            if self.retain_instance_lock_until_process_exit() {
                eprintln!(
                    "Core shutdown did not reach a verified terminal: {error} (instance lock retained until process termination)"
                );
            } else {
                eprintln!("Core shutdown did not reach a verified terminal: {error}");
            }
        }
    }
}
