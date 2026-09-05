const RETAINED_WORKSPACE_DIVIDER_RECEIPTS: usize = 1024;
const MAX_ACTIVE_WORKSPACE_DIVIDER_GESTURES: usize = 128;

#[derive(Clone)]
struct WorkspaceDividerGesture {
    gesture_id: String,
    platform: crate::model::BrowserWorkspaceDividerPlatform,
    host_identity: crate::model::BrowserWorkspaceDividerHostIdentityRecord,
    window_id: String,
    tab_id: String,
    attempt_generation: String,
    window_generation: u64,
    initial_topology_revision: u64,
    current_topology_revision: u64,
    divider_index: u32,
    last_pointer_sequence: u64,
    last_position: Option<f64>,
    workspace_slots: Vec<crate::model::StateWorkspaceSlotRecord>,
}

#[derive(Clone)]
struct WorkspaceDividerReceiptEntry {
    fingerprint: String,
    receipt: crate::model::BrowserWorkspaceDividerPointerReceiptRecord,
}

#[derive(Default)]
struct WorkspaceDividerRuntime {
    gestures: std::collections::HashMap<String, WorkspaceDividerGesture>,
    receipts: std::collections::HashMap<String, WorkspaceDividerReceiptEntry>,
    receipt_order: std::collections::VecDeque<String>,
}

struct WorkspaceDividerMoveResult {
    changed: bool,
    position: f64,
    status: crate::model::SystemRuntimeOperationStatus,
    failure_code: Option<String>,
    topology_revision: u64,
    workspace_slots: Vec<crate::model::StateWorkspaceSlotRecord>,
}

impl AppCore {
    fn handle_workspace_divider_pointer(
        &self,
        event: crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        self.validate_workspace_divider_event(&event)?;
        let fingerprint = serde_json::to_string(&event)
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_workspace_divider_receipt(
            &event.event_id,
            &fingerprint,
        )? {
            return Ok(receipt);
        }
        self.accept_workspace_divider_appkit_sequence(&event)?;
        let receipt = match event.phase {
            crate::model::BrowserWorkspaceDividerPointerPhase::Start => {
                self.start_workspace_divider_gesture(&event)?
            }
            crate::model::BrowserWorkspaceDividerPointerPhase::Move => {
                self.move_workspace_divider_gesture(&event)?
            }
            crate::model::BrowserWorkspaceDividerPointerPhase::End => {
                self.end_workspace_divider_gesture(&event)?
            }
            crate::model::BrowserWorkspaceDividerPointerPhase::Cancel => {
                self.cancel_workspace_divider_gesture(&event)?
            }
        };
        self.retain_workspace_divider_receipt(event.event_id, fingerprint, receipt)
    }

    fn validate_workspace_divider_event(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<()> {
        let registration = self.browser_runtime_registration()?;
        let expected_platform = match self.platform {
            rion_platform::Platform::Macos => {
                crate::model::BrowserWorkspaceDividerPlatform::Macos
            }
            rion_platform::Platform::Windows => {
                crate::model::BrowserWorkspaceDividerPlatform::Windows
            }
        };
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION
            || registration.engine != crate::model::ResolvedBrowserEngine::Chromium
            || registration.platform
                != match expected_platform {
                    crate::model::BrowserWorkspaceDividerPlatform::Macos => "macos",
                    crate::model::BrowserWorkspaceDividerPlatform::Windows => "windows",
                }
            || event.platform != expected_platform
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_RUNTIME_UNAVAILABLE",
                "The workspace-divider action does not match the registered Chromium runtime.",
            ));
        }
        if uuid::Uuid::parse_str(&event.event_id).is_err()
            || !valid_runtime_ui_identifier(&event.gesture_id)
            || !valid_runtime_ui_identifier(&event.window_id)
            || !valid_runtime_ui_identifier(&event.tab_id)
            || !valid_runtime_ui_identifier(&event.attempt_generation)
            || event.pointer_sequence == 0
            || event.window_generation == 0
            || event.topology_revision == 0
            || (event.phase == crate::model::BrowserWorkspaceDividerPointerPhase::Move
                && event
                    .requested_position
                    .is_none_or(|position| !position.is_finite() || !(0.0..=1.0).contains(&position)))
            || (event.phase != crate::model::BrowserWorkspaceDividerPointerPhase::Move
                && event.requested_position.is_some())
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_EVENT_INVALID",
                "The workspace-divider pointer event is malformed.",
            ));
        }
        match self.platform {
            rion_platform::Platform::Macos => {
                let host = event.appkit_host.as_ref().ok_or_else(|| {
                    workspace_divider_error(
                        "WORKSPACE_DIVIDER_APPKIT_HOST_MISSING",
                        "The macOS divider event omitted its exact retained AppKit host.",
                    )
                })?;
                let sequence = event.appkit_adapter_sequence.ok_or_else(|| {
                    workspace_divider_error(
                        "WORKSPACE_DIVIDER_APPKIT_SEQUENCE_MISSING",
                        "The macOS divider event omitted its AppKit adapter sequence.",
                    )
                })?;
                if sequence == 0
                    || host.identity.logical_window_id != event.window_id
                    || host.window_generation != event.window_generation
                    || host.topology_revision != event.topology_revision
                    || event.host_identity
                        != (crate::model::BrowserWorkspaceDividerHostIdentityRecord::Appkit {
                            identity: host.identity.clone(),
                        })
                {
                    return Err(workspace_divider_error(
                        "WORKSPACE_DIVIDER_APPKIT_HOST_STALE",
                        "The macOS divider event carries a stale AppKit host fence.",
                    ));
                }
            }
            rion_platform::Platform::Windows => {
                if event.appkit_host.is_some()
                    || event.appkit_adapter_sequence.is_some()
                    || !matches!(
                        &event.host_identity,
                        crate::model::BrowserWorkspaceDividerHostIdentityRecord::Windows {
                            native_host_id,
                            host_generation
                        } if *native_host_id > 0 && *host_generation > 0
                    )
                {
                    return Err(workspace_divider_error(
                        "WORKSPACE_DIVIDER_WINDOWS_HOST_INVALID",
                        "The Windows divider event cannot claim an AppKit host.",
                    ));
                }
            }
        }
        Ok(())
    }

    fn accept_workspace_divider_appkit_sequence(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<()> {
        let Some(host) = event.appkit_host.as_ref() else {
            return Ok(());
        };
        let sequence = event
            .appkit_adapter_sequence
            .expect("validated AppKit divider sequence");
        if !self.accept_appkit_event_sequence(&host.identity, sequence)? {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_APPKIT_SEQUENCE_STALE",
                "The macOS divider pointer sequence is stale.",
            ));
        }
        Ok(())
    }

    fn start_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        let (window, tab) = self.exact_workspace_divider_tab(event, event.topology_revision)?;
        let roles = workspace_divider_roles(&tab)?;
        let dividers = layout::create_dividers(&roles);
        if usize::try_from(event.divider_index)
            .ok()
            .is_none_or(|index| index >= dividers.len())
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_INDEX_STALE",
                "The native divider no longer identifies a live Core divider.",
            ));
        }
        let mut runtime = self.workspace_divider_runtime.lock().map_err(|_| {
            CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
        })?;
        let stale_gestures = runtime
            .gestures
            .iter()
            .filter(|(_, gesture)| {
                gesture.window_id == event.window_id
                    && gesture.tab_id == event.tab_id
                    && gesture.divider_index == event.divider_index
                    && (gesture.platform != event.platform
                        || gesture.host_identity != event.host_identity
                        || gesture.attempt_generation != event.attempt_generation
                        || gesture.window_generation != event.window_generation)
            })
            .map(|(gesture_id, _)| gesture_id.clone())
            .collect::<Vec<_>>();
        for gesture_id in stale_gestures {
            // A replaced native host is an authoritative crash-cancel boundary.
            // Already committed moves remain Core-authoritative in memory.
            // This replaced gesture performs no durability commit; a later,
            // independent saved-window snapshot may persist current authority.
            runtime.gestures.remove(&gesture_id);
        }
        if runtime.gestures.len() >= MAX_ACTIVE_WORKSPACE_DIVIDER_GESTURES {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_GESTURE_CAPACITY",
                "The bounded workspace-divider gesture registry is full.",
            ));
        }
        if runtime.gestures.values().any(|gesture| {
            gesture.window_id == event.window_id
                && gesture.tab_id == event.tab_id
                && gesture.divider_index == event.divider_index
        }) || runtime.gestures.contains_key(&event.gesture_id)
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_GESTURE_CONFLICT",
                "The divider already owns a live native pointer gesture.",
            ));
        }
        let workspace_slots = tab.workspace_slots.clone();
        runtime.gestures.insert(
            event.gesture_id.clone(),
            WorkspaceDividerGesture {
                gesture_id: event.gesture_id.clone(),
                platform: event.platform,
                host_identity: event.host_identity.clone(),
                window_id: event.window_id.clone(),
                tab_id: event.tab_id.clone(),
                attempt_generation: event.attempt_generation.clone(),
                window_generation: event.window_generation,
                initial_topology_revision: event.topology_revision,
                current_topology_revision: event.topology_revision,
                divider_index: event.divider_index,
                last_pointer_sequence: event.pointer_sequence,
                last_position: None,
                workspace_slots: workspace_slots.clone(),
            },
        );
        Ok(workspace_divider_receipt(
            event,
            crate::model::SystemRuntimeOperationStatus::Applied,
            false,
            false,
            None,
            window.revision,
            workspace_slots,
            None,
        ))
    }

    fn move_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        let gesture = self.exact_workspace_divider_gesture(event)?;
        let (_window, tab) = self.exact_workspace_divider_tab(
            event,
            gesture.current_topology_revision,
        )?;
        if tab.workspace_slots != gesture.workspace_slots {
            return self.supersede_workspace_divider_gesture(
                event,
                gesture,
                "WORKSPACE_DIVIDER_TOPOLOGY_STALE",
            );
        }
        let prior_slots = gesture.workspace_slots.clone();
        let roles = workspace_divider_roles(&tab)?;
        let dividers = layout::create_dividers(&roles);
        let resize = self.resize_workspace_divider(&crate::model::WorkspaceDividerResizeInput {
            roles,
            dividers,
            divider_index: event.divider_index,
            requested_position: event.requested_position.expect("validated move position"),
            previous_position: gesture.last_position,
        })?;
        let workspace_slots = workspace_divider_slots_from_resize(&tab, &resize)?;
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::ReplaceTabWorkspaceSlots {
            expected_revision: Some(gesture.current_topology_revision),
            operation_id: event.event_id.clone(),
            tab_id: event.tab_id.clone(),
            window_id: event.window_id.clone(),
            workspace_slots: workspace_slots.clone(),
        })?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return self.supersede_workspace_divider_gesture(
                event,
                gesture,
                "WORKSPACE_DIVIDER_TOPOLOGY_STALE",
            );
        }
        let current = self.browser_runtime.snapshot()?;
        let committed_revision = current
            .windows
            .get(&event.window_id)
            .map(|window| window.revision)
            .ok_or_else(|| {
                workspace_divider_error(
                    "WORKSPACE_DIVIDER_WINDOW_STALE",
                    "The divider window disappeared after its Core commit.",
                )
            })?;
        let native = if resize.changed {
            self.project_workspace_divider_native(event)
        } else {
            Ok(())
        };
        let result = match native {
            Ok(()) => WorkspaceDividerMoveResult {
                changed: resize.changed,
                position: resize.position,
                status: crate::model::SystemRuntimeOperationStatus::Applied,
                failure_code: None,
                topology_revision: committed_revision,
                workspace_slots,
            },
            Err(native_error) => {
                let compensation = self.compensate_workspace_divider_move(
                    event,
                    committed_revision,
                    prior_slots.clone(),
                );
                match compensation {
                    Ok(compensated_revision) => WorkspaceDividerMoveResult {
                        changed: false,
                        position: gesture.last_position.unwrap_or(resize.position),
                        status: crate::model::SystemRuntimeOperationStatus::Failed,
                        failure_code: Some(native_error.code().to_owned()),
                        topology_revision: compensated_revision,
                        workspace_slots: prior_slots,
                    },
                    Err(_) => WorkspaceDividerMoveResult {
                        changed: resize.changed,
                        position: resize.position,
                        status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                        failure_code: Some(
                            "WORKSPACE_DIVIDER_COMPENSATION_FAILED".to_owned(),
                        ),
                        topology_revision: committed_revision,
                        workspace_slots,
                    },
                }
            }
        };
        let mut runtime = self.workspace_divider_runtime.lock().map_err(|_| {
            CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
        })?;
        if result.status == crate::model::SystemRuntimeOperationStatus::Applied {
            let current = runtime.gestures.get_mut(&event.gesture_id).ok_or_else(|| {
                workspace_divider_error(
                    "WORKSPACE_DIVIDER_GESTURE_STALE",
                    "The divider gesture ended before its native projection receipt.",
                )
            })?;
            current.current_topology_revision = result.topology_revision;
            current.last_pointer_sequence = event.pointer_sequence;
            current.last_position = Some(result.position);
            current.workspace_slots.clone_from(&result.workspace_slots);
        } else {
            runtime.gestures.remove(&event.gesture_id);
        }
        Ok(workspace_divider_receipt(
            event,
            result.status,
            result.changed,
            false,
            Some(result.position),
            result.topology_revision,
            result.workspace_slots,
            result.failure_code,
        ))
    }

    fn end_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        let gesture = self.exact_workspace_divider_gesture(event)?;
        let (window, tab) =
            self.exact_workspace_divider_tab(event, gesture.current_topology_revision)?;
        let persistence = if tab.workspace_slots == gesture.workspace_slots {
            self.persist_workspace_divider_window(&window)
        } else {
            Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_TOPOLOGY_STALE",
                "The divider topology changed before its exact durability boundary.",
            ))
        };
        self.remove_workspace_divider_gesture(&event.gesture_id)?;
        let (status, durable, failure_code) = match persistence {
            Ok(()) => (crate::model::SystemRuntimeOperationStatus::Applied, true, None),
            Err(error) => (
                crate::model::SystemRuntimeOperationStatus::Degraded,
                false,
                Some(error.code().to_owned()),
            ),
        };
        Ok(workspace_divider_receipt(
            event,
            status,
            false,
            durable,
            gesture.last_position,
            gesture.current_topology_revision,
            gesture.workspace_slots,
            failure_code,
        ))
    }

    fn persist_workspace_divider_window(
        &self,
        window: &crate::RuntimeLiveWindowRecord,
    ) -> CoreResult<()> {
        let tabs = window
            .tabs
            .iter()
            .map(|tab| crate::model::GameWindowTabRecord {
                id: tab.id.clone(),
                tab_type: tab.tab_type.clone(),
                source_id: tab.source_id.clone(),
                name: tab.title.clone(),
                role_slots: tab.role_slots.clone(),
                workspace_slots: tab.workspace_slots.clone(),
                hidden: window.hidden_tab_ids.contains(&tab.id),
                audio_muted: tab.audio_muted,
            })
            .collect::<Vec<_>>();
        {
            let _guard = self.state_mutation_guard()?;
            let state = self.read_typed_snapshot()?;
            if !state
                .game_windows
                .iter()
                .any(|saved| saved.id == window.window_id)
            {
                return Err(workspace_divider_error(
                    "WORKSPACE_DIVIDER_WINDOW_NOT_SAVED",
                    "A transient runtime window cannot durably store divider geometry.",
                ));
            }
            self.mutate_state_under_guard(StateMutation::GameWindowUpdate {
                id: window.window_id.clone(),
                input: crate::model::GameWindowUpdateInputRecord {
                    name: None,
                    target_display: None,
                    placement: None,
                    tabs: Some(tabs),
                    active_tab_id: Some(window.selected_tab_id.clone()),
                },
            })?;
        }
        self.mark_runtime_ui_windows_live(std::slice::from_ref(&window.window_id))
    }

    fn cancel_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        let gesture = self.exact_workspace_divider_gesture(event)?;
        self.remove_workspace_divider_gesture(&event.gesture_id)?;
        Ok(workspace_divider_receipt(
            event,
            crate::model::SystemRuntimeOperationStatus::Cancelled,
            false,
            false,
            gesture.last_position,
            gesture.current_topology_revision,
            gesture.workspace_slots,
            None,
        ))
    }

    fn exact_workspace_divider_tab(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
        expected_revision: u64,
    ) -> CoreResult<(crate::RuntimeLiveWindowRecord, crate::RuntimeLiveTabRecord)> {
        let snapshot = self.browser_runtime.snapshot()?;
        let window = snapshot.windows.get(&event.window_id).cloned().ok_or_else(|| {
            workspace_divider_error(
                "WORKSPACE_DIVIDER_WINDOW_STALE",
                "The divider window is no longer live.",
            )
        })?;
        let tab = window
            .tabs
            .iter()
            .find(|tab| tab.id == event.tab_id)
            .cloned()
            .ok_or_else(|| {
                workspace_divider_error(
                    "WORKSPACE_DIVIDER_TAB_STALE",
                    "The divider tab is no longer attached to its window.",
                )
            })?;
        let browser_tab = snapshot
            .browser_runtime
            .tabs
            .iter()
            .find(|tab| tab.id == event.tab_id && tab.window_id == event.window_id);
        if window.window_generation != event.window_generation
            || window.revision != expected_revision
            || tab.tab_type != "workspace"
            || tab.workspace_slots.len() < 2
            || browser_tab.and_then(|tab| tab.attempt_generation.as_deref())
                != Some(event.attempt_generation.as_str())
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_TOPOLOGY_STALE",
                "The divider attempt, window generation, topology, or workspace tab is stale.",
            ));
        }
        Ok((window, tab))
    }

    fn exact_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<WorkspaceDividerGesture> {
        let runtime = self.workspace_divider_runtime.lock().map_err(|_| {
            CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
        })?;
        let gesture = runtime.gestures.get(&event.gesture_id).cloned().ok_or_else(|| {
            workspace_divider_error(
                "WORKSPACE_DIVIDER_GESTURE_STALE",
                "The native divider gesture is no longer active.",
            )
        })?;
        if gesture.gesture_id != event.gesture_id
            || gesture.platform != event.platform
            || gesture.host_identity != event.host_identity
            || gesture.window_id != event.window_id
            || gesture.tab_id != event.tab_id
            || gesture.attempt_generation != event.attempt_generation
            || gesture.window_generation != event.window_generation
            || gesture.initial_topology_revision > event.topology_revision
            || gesture.current_topology_revision != event.topology_revision
            || gesture.divider_index != event.divider_index
            || event.pointer_sequence <= gesture.last_pointer_sequence
        {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_GESTURE_STALE",
                "The divider gesture lost its exact attempt, host, topology, or pointer sequence fence.",
            ));
        }
        Ok(gesture)
    }

    fn supersede_workspace_divider_gesture(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
        gesture: WorkspaceDividerGesture,
        failure_code: &str,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        self.remove_workspace_divider_gesture(&event.gesture_id)?;
        Ok(workspace_divider_receipt(
            event,
            crate::model::SystemRuntimeOperationStatus::Superseded,
            false,
            false,
            gesture.last_position,
            gesture.current_topology_revision,
            gesture.workspace_slots,
            Some(failure_code.to_owned()),
        ))
    }

    fn project_workspace_divider_native(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    ) -> CoreResult<()> {
        if let Some(host) = event.appkit_host.as_ref() {
            let native_event = crate::model::AppKitRuntimeEventRecord {
                event_id: event.event_id.clone(),
                adapter_sequence: event
                    .appkit_adapter_sequence
                    .expect("validated AppKit divider sequence"),
                hosts: vec![host.clone()],
                action: crate::model::AppKitRuntimeEventActionRecord::Layout {
                    layout_sequence: event.pointer_sequence,
                },
            };
            let projection = self.build_appkit_projection(&native_event)?;
            self.run_embedded_runtime_effect(
                &event.window_id,
                CoreEffectAction::EmbeddedApplyAppKitProjection {
                    projection: Box::new(projection),
                },
                None,
                Some(&event.event_id),
            )?;
            return Ok(());
        }
        self.project_embedded_runtime_snapshot_without_persistence(Some(&event.event_id))?;
        Ok(())
    }

    fn compensate_workspace_divider_move(
        &self,
        event: &crate::model::BrowserWorkspaceDividerPointerRecord,
        committed_revision: u64,
        prior_slots: Vec<crate::model::StateWorkspaceSlotRecord>,
    ) -> CoreResult<u64> {
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::ReplaceTabWorkspaceSlots {
            expected_revision: Some(committed_revision),
            operation_id: format!("{}:core-compensation", event.event_id),
            tab_id: event.tab_id.clone(),
            window_id: event.window_id.clone(),
            workspace_slots: prior_slots,
        })?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_COMPENSATION_STALE",
                "A later Core action superseded divider compensation.",
            ));
        }
        self.project_workspace_divider_native(event)?;
        let snapshot = self.browser_runtime.snapshot()?;
        snapshot
            .windows
            .get(&event.window_id)
            .map(|window| window.revision)
            .ok_or_else(|| {
                workspace_divider_error(
                    "WORKSPACE_DIVIDER_COMPENSATION_STALE",
                    "The divider window disappeared during compensation.",
                )
            })
    }

    fn remove_workspace_divider_gesture(&self, gesture_id: &str) -> CoreResult<()> {
        self.workspace_divider_runtime
            .lock()
            .map_err(|_| CoreError::Internal("workspace divider runtime lock poisoned".to_owned()))?
            .gestures
            .remove(gesture_id);
        Ok(())
    }

    fn cached_workspace_divider_receipt(
        &self,
        event_id: &str,
        fingerprint: &str,
    ) -> CoreResult<Option<crate::model::BrowserWorkspaceDividerPointerReceiptRecord>> {
        let runtime = self.workspace_divider_runtime.lock().map_err(|_| {
            CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
        })?;
        let Some(entry) = runtime.receipts.get(event_id) else {
            return Ok(None);
        };
        if entry.fingerprint != fingerprint {
            return Err(workspace_divider_error(
                "WORKSPACE_DIVIDER_EVENT_ID_REUSED",
                "A divider event identity was reused for another payload.",
            ));
        }
        Ok(Some(entry.receipt.clone()))
    }

    fn retain_workspace_divider_receipt(
        &self,
        event_id: String,
        fingerprint: String,
        receipt: crate::model::BrowserWorkspaceDividerPointerReceiptRecord,
    ) -> CoreResult<crate::model::BrowserWorkspaceDividerPointerReceiptRecord> {
        let mut runtime = self.workspace_divider_runtime.lock().map_err(|_| {
            CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
        })?;
        runtime.receipt_order.push_back(event_id.clone());
        runtime.receipts.insert(
            event_id,
            WorkspaceDividerReceiptEntry {
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        while runtime.receipt_order.len() > RETAINED_WORKSPACE_DIVIDER_RECEIPTS {
            if let Some(expired) = runtime.receipt_order.pop_front() {
                runtime.receipts.remove(&expired);
            }
        }
        Ok(receipt)
    }
}

fn workspace_divider_roles(
    tab: &crate::RuntimeLiveTabRecord,
) -> CoreResult<Vec<crate::model::LayoutRoleInput>> {
    tab.workspace_slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            let role_id = match (&slot.role_id, &slot.web) {
                (Some(role_id), None) => role_id.clone(),
                (None, Some(_)) => workspace_web_surface_id(&tab.id, index),
                _ => {
                    return Err(workspace_divider_error(
                        "WORKSPACE_DIVIDER_SLOT_INVALID",
                        "A workspace divider slot has ambiguous content ownership.",
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
        .collect()
}

fn workspace_divider_slots_from_resize(
    tab: &crate::RuntimeLiveTabRecord,
    resize: &crate::model::WorkspaceDividerResizeOutput,
) -> CoreResult<Vec<crate::model::StateWorkspaceSlotRecord>> {
    if resize.roles.len() != tab.workspace_slots.len() {
        return Err(workspace_divider_error(
            "WORKSPACE_DIVIDER_RESIZE_INVALID",
            "Core returned an incomplete divider resize projection.",
        ));
    }
    let rect_by_role = resize
        .roles
        .iter()
        .map(|role| (role.role_id.as_str(), &role.rect))
        .collect::<std::collections::HashMap<_, _>>();
    tab.workspace_slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            let role_id = slot
                .role_id
                .clone()
                .unwrap_or_else(|| workspace_web_surface_id(&tab.id, index));
            let rect = rect_by_role.get(role_id.as_str()).ok_or_else(|| {
                workspace_divider_error(
                    "WORKSPACE_DIVIDER_RESIZE_INVALID",
                    "Core omitted a workspace slot from its divider resize projection.",
                )
            })?;
            let mut slot = slot.clone();
            slot.rect = crate::model::StateNormalizedRectRecord {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
            Ok(slot)
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn workspace_divider_receipt(
    event: &crate::model::BrowserWorkspaceDividerPointerRecord,
    status: crate::model::SystemRuntimeOperationStatus,
    changed: bool,
    durable: bool,
    position: Option<f64>,
    topology_revision: u64,
    workspace_slots: Vec<crate::model::StateWorkspaceSlotRecord>,
    failure_code: Option<String>,
) -> crate::model::BrowserWorkspaceDividerPointerReceiptRecord {
    crate::model::BrowserWorkspaceDividerPointerReceiptRecord {
        event_id: event.event_id.clone(),
        gesture_id: event.gesture_id.clone(),
        pointer_sequence: event.pointer_sequence,
        phase: event.phase,
        status,
        changed,
        durable,
        position,
        window_generation: event.window_generation,
        topology_revision,
        workspace_slots,
        failure_code,
    }
}

fn workspace_divider_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}
