use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{self, Sender, SyncSender};

use crate::browser_runtime::RoleOwnershipRuntime;
use crate::error::{CoreError, CoreResult};
use crate::model::{BrowserRuntimeCommand, BrowserRuntimeResult, RuntimeTabActivationPhaseRecord};

use super::types::{
    LaunchAttemptId, NativeRuntimeEvent, OperationId, RuntimeCommit, RuntimeCommitStatus,
    RuntimeDesiredEffect, RuntimeIntent, RuntimeInvariantAudit, RuntimeLiveWindowRecord,
    RuntimeLogicalSurfaceRecord, RuntimeOperationPhase, RuntimeOperationRecord,
    RuntimeOperationTraceRecord, RuntimeSnapshot, RuntimeSurfaceGeneration,
    RuntimeSurfaceLifecycle, RuntimeTabActivationRecord, RuntimeTabId, RuntimeTabTombstone,
    RuntimeTerminalEvent, RuntimeTopologyCommitInput, RuntimeWindowContextInitializeInput,
    RuntimeWindowGeneration, RuntimeWindowPlacementCommitInput,
};

const RETAINED_OPERATION_IDS: usize = 4_096;
const RETAINED_OPERATION_TRACES: usize = 512;

#[derive(Clone, Default)]
struct RuntimeKernelState {
    applied_operation_ids: HashSet<String>,
    operation_order: VecDeque<String>,
    operations: HashMap<String, RuntimeOperationRecord>,
    ownership: RoleOwnershipRuntime,
    revision: u64,
    tab_activations: HashMap<String, RuntimeTabActivationRecord>,
    trace: VecDeque<RuntimeOperationTraceRecord>,
    tombstones: HashMap<String, RuntimeTabTombstone>,
    logical_surfaces: HashMap<String, RuntimeLogicalSurfaceRecord>,
    windows: HashMap<String, RuntimeLiveWindowRecord>,
}

pub struct RuntimeKernel {
    sender: Sender<RuntimeKernelRequest>,
}

enum RuntimeKernelRequest {
    Apply(Box<RuntimeIntent>, SyncSender<CoreResult<RuntimeCommit>>),
    Snapshot(SyncSender<CoreResult<RuntimeSnapshot>>),
    Audit(SyncSender<CoreResult<RuntimeInvariantAudit>>),
}

impl Default for RuntimeKernel {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<RuntimeKernelRequest>();
        std::thread::Builder::new()
            .name("rion-runtime-kernel".to_owned())
            .spawn(move || {
                let mut state = RuntimeKernelState::default();
                while let Ok(request) = receiver.recv() {
                    match request {
                        RuntimeKernelRequest::Apply(intent, reply) => {
                            let _ = reply.send(apply_to_state(&mut state, *intent));
                        }
                        RuntimeKernelRequest::Snapshot(reply) => {
                            let _ = reply.send(snapshot_state(&state));
                        }
                        RuntimeKernelRequest::Audit(reply) => {
                            let _ = reply.send(audit_state(&state));
                        }
                    }
                }
            })
            .expect("runtime kernel actor thread must start");
        Self { sender }
    }
}

impl RuntimeKernel {
    pub fn apply(&self, intent: RuntimeIntent) -> CoreResult<RuntimeCommit> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(RuntimeKernelRequest::Apply(Box::new(intent), reply))
            .map_err(|_| CoreError::Internal("runtime kernel actor stopped".to_owned()))?;
        receiver
            .recv()
            .map_err(|_| CoreError::Internal("runtime kernel reply dropped".to_owned()))?
    }

    pub fn invoke_browser_runtime(
        &self,
        command: BrowserRuntimeCommand,
    ) -> CoreResult<BrowserRuntimeResult> {
        self.apply(RuntimeIntent::BrowserRuntime(command))?
            .browser_result
            .ok_or_else(|| CoreError::Internal("runtime kernel omitted browser result".to_owned()))
    }

    pub fn snapshot(&self) -> CoreResult<RuntimeSnapshot> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(RuntimeKernelRequest::Snapshot(reply))
            .map_err(|_| CoreError::Internal("runtime kernel actor stopped".to_owned()))?;
        receiver
            .recv()
            .map_err(|_| CoreError::Internal("runtime kernel reply dropped".to_owned()))?
    }

    pub fn audit(&self) -> CoreResult<RuntimeInvariantAudit> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(RuntimeKernelRequest::Audit(reply))
            .map_err(|_| CoreError::Internal("runtime kernel actor stopped".to_owned()))?;
        receiver
            .recv()
            .map_err(|_| CoreError::Internal("runtime kernel reply dropped".to_owned()))?
    }

    pub fn snapshot_window(&self, window_id: &str) -> CoreResult<Option<RuntimeLiveWindowRecord>> {
        Ok(self.snapshot()?.windows.remove(window_id))
    }

    pub fn current_revision(&self) -> CoreResult<u64> {
        Ok(self.snapshot()?.revision)
    }
}

fn apply_to_state(
    state: &mut RuntimeKernelState,
    intent: RuntimeIntent,
) -> CoreResult<RuntimeCommit> {
    let mut candidate = state.clone();
    let commit = apply_to_candidate(&mut candidate, intent)?;
    validate_state(&candidate)?;
    *state = candidate;
    Ok(commit)
}

fn apply_to_candidate(
    state: &mut RuntimeKernelState,
    intent: RuntimeIntent,
) -> CoreResult<RuntimeCommit> {
    let (intent_kind, event_source) = intent_trace_identity(&intent);
    let trace_context = intent_trace_context(&intent);
    if let Some(idempotency_key) = intent.idempotency_key()
        && state.applied_operation_ids.contains(idempotency_key)
    {
        let commit = RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: intent.operation_id().map(str::to_owned),
            revision: state.revision,
            status: RuntimeCommitStatus::Duplicate,
            terminal_events: Vec::new(),
            window_ids: Vec::new(),
            browser_result: None,
        };
        record_trace(state, &commit, intent_kind, event_source, trace_context);
        return Ok(commit);
    }
    let operation_id = intent.operation_id().map(str::to_owned);
    let idempotency_key = intent.idempotency_key().map(str::to_owned);
    let mut commit = match intent {
        RuntimeIntent::BrowserRuntime(command) => apply_browser_runtime(state, command)?,
        RuntimeIntent::CommitTopology(input) => apply_topology(state, input)?,
        RuntimeIntent::CommitPlacement(input) => apply_placement(state, input)?,
        RuntimeIntent::InitializeWindowContext(input) => apply_window_context(state, input)?,
        RuntimeIntent::EnsureWindow { window_id, .. } => {
            let changed = !state.windows.contains_key(&window_id);
            if changed {
                let revision = next_revision(state);
                state.windows.insert(
                    window_id.clone(),
                    RuntimeLiveWindowRecord {
                        revision,
                        window_id: window_id.clone(),
                        ..RuntimeLiveWindowRecord::default()
                    },
                );
            }
            basic_commit(state, changed, vec![window_id])
        }
        RuntimeIntent::SetWindowGeneration {
            generation,
            window_id,
            ..
        } => {
            let current = state
                .windows
                .get(&window_id)
                .map(|window| window.window_generation)
                .unwrap_or_default();
            let changed = generation > current || !state.windows.contains_key(&window_id);
            if changed {
                let revision = next_revision(state);
                let window = state.windows.entry(window_id.clone()).or_default();
                window.window_id = window_id.clone();
                window.window_generation = generation.max(current);
                window.placement_sequence = 0;
                window.revision = revision;
                let next_generation = RuntimeWindowGeneration(window.window_generation);
                let tab_ids = window
                    .tabs
                    .iter()
                    .map(|tab| tab.id.clone())
                    .collect::<Vec<_>>();
                for tab_id in tab_ids {
                    if let Some(activation) = state.tab_activations.get_mut(&tab_id)
                        && activation.window_generation != next_generation
                    {
                        if matches!(
                            activation.phase,
                            RuntimeTabActivationPhaseRecord::Activating
                                | RuntimeTabActivationPhaseRecord::Attaching
                                | RuntimeTabActivationPhaseRecord::Loading
                        ) {
                            activation.phase = RuntimeTabActivationPhaseRecord::Failed;
                        }
                        activation.native_operation_id = None;
                        activation.owner_window_id.clone_from(&window_id);
                        activation.window_generation = next_generation;
                    }
                }
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::SetPersistedName {
            name, window_id, ..
        } => {
            let current = state
                .windows
                .get(&window_id)
                .and_then(|window| window.persisted_name.clone());
            let changed = current != name;
            if changed {
                let revision = next_revision(state);
                let window = state.windows.entry(window_id.clone()).or_default();
                window.window_id = window_id.clone();
                window.persisted_name = name;
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::SetTabAudioMuted {
            audio_muted,
            expected_revision,
            tab_id,
            window_id,
            ..
        } => {
            let Some(current) = state.windows.get(&window_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            if expected_revision.is_some_and(|expected| current.revision != expected)
                || !current.contains_tab(&tab_id)
            {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            }
            let changed = current
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .is_some_and(|tab| tab.audio_muted != audio_muted);
            if changed {
                let revision = next_revision(state);
                let window = state
                    .windows
                    .get_mut(&window_id)
                    .expect("audio candidate was validated");
                window
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == tab_id)
                    .expect("audio tab was validated")
                    .audio_muted = audio_muted;
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::SetRoleZoom {
            browser_zoom_percent,
            expected_revision,
            role_id,
            tab_id,
            window_id,
            ..
        } => {
            validate_role_zoom(browser_zoom_percent)?;
            let Some(current) = state.windows.get(&window_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            let Some(tab) = current.tabs.iter().find(|tab| tab.id == tab_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            let Some(slot) = tab.role_slots.iter().find(|slot| slot.role_id == role_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            if expected_revision.is_some_and(|expected| current.revision != expected) {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            }
            let workspace_zoom = tab
                .workspace_slots
                .iter()
                .find(|slot| slot.role_id.as_deref() == Some(role_id.as_str()))
                .map(|slot| slot.browser_zoom_percent);
            let changed = slot.browser_zoom_percent != browser_zoom_percent
                || workspace_zoom.is_some_and(|zoom| zoom != browser_zoom_percent);
            if changed {
                let revision = next_revision(state);
                let window = state
                    .windows
                    .get_mut(&window_id)
                    .expect("role zoom candidate was validated");
                let tab = window
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == tab_id)
                    .expect("role zoom tab was validated");
                tab.role_slots
                    .iter_mut()
                    .find(|slot| slot.role_id == role_id)
                    .expect("role zoom slot was validated")
                    .browser_zoom_percent = browser_zoom_percent;
                if let Some(workspace_slot) = tab
                    .workspace_slots
                    .iter_mut()
                    .find(|slot| slot.role_id.as_deref() == Some(role_id.as_str()))
                {
                    workspace_slot.browser_zoom_percent = browser_zoom_percent;
                }
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::ReplaceTabRoleSlots {
            expected_revision,
            role_slots,
            tab_id,
            window_id,
            ..
        } => {
            validate_role_slots(&role_slots)?;
            let Some(current) = state.windows.get(&window_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            let Some(tab) = current.tabs.iter().find(|tab| tab.id == tab_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            if expected_revision.is_some_and(|expected| current.revision != expected)
                || !tab.workspace_slots.is_empty()
                || role_slots
                    .iter()
                    .any(|slot| !tab.role_ids.contains(&slot.role_id))
                || tab
                    .role_ids
                    .iter()
                    .any(|role_id| !role_slots.iter().any(|slot| &slot.role_id == role_id))
            {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            }
            let changed = tab.role_slots != role_slots;
            if changed {
                let revision = next_revision(state);
                let window = state
                    .windows
                    .get_mut(&window_id)
                    .expect("role slot candidate was validated");
                window
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == tab_id)
                    .expect("role slot tab was validated")
                    .role_slots = role_slots;
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::ReplaceTabWorkspaceSlots {
            expected_revision,
            tab_id,
            window_id,
            workspace_slots,
            ..
        } => {
            let Some(current) = state.windows.get(&window_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            let Some(tab) = current.tabs.iter().find(|tab| tab.id == tab_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            let role_slots = validate_workspace_slots(&workspace_slots, &tab.role_ids)?;
            if expected_revision.is_some_and(|expected| current.revision != expected)
                || tab.tab_type != "workspace"
            {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            }
            let changed = tab.workspace_slots != workspace_slots || tab.role_slots != role_slots;
            if changed {
                let revision = next_revision(state);
                let window = state
                    .windows
                    .get_mut(&window_id)
                    .expect("workspace slot candidate was validated");
                let tab = window
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == tab_id)
                    .expect("workspace slot tab was validated");
                tab.role_slots = role_slots;
                tab.workspace_slots = workspace_slots;
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::SetWindowZoomFactor {
            expected_revision,
            window_id,
            zoom_factor,
            ..
        } => {
            if !zoom_factor.is_finite() || !(0.25..=5.0).contains(&zoom_factor) {
                return Err(CoreError::InvalidInput(
                    "runtime window zoom factor is invalid".to_owned(),
                ));
            }
            let Some(current) = state.windows.get(&window_id) else {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            };
            if expected_revision.is_some_and(|expected| current.revision != expected) {
                return Ok(superseded_commit(state, operation_id, vec![window_id]));
            }
            let changed = current.window_zoom_factor.unwrap_or(1.0) != zoom_factor;
            if changed {
                let revision = next_revision(state);
                let window = state
                    .windows
                    .get_mut(&window_id)
                    .expect("zoom candidate was validated");
                window.window_zoom_factor = Some(zoom_factor);
                window.revision = revision;
            }
            basic_commit(state, false, vec![window_id])
        }
        RuntimeIntent::SeedDormantTabs {
            tab_ids, window_id, ..
        } => seed_dormant_tabs(state, &window_id, tab_ids)?,
        RuntimeIntent::ActivateTab {
            expected_revision,
            operation_id,
            tab_id,
            window_id,
        } => activate_tab(state, expected_revision, operation_id, tab_id, window_id)?,
        RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id,
            phase,
            tab_id,
            ..
        } => set_tab_activation_phase(state, activation_attempt_id, tab_id, phase)?,
        RuntimeIntent::ReplaceWindow {
            expected_revision,
            mut window,
            ..
        } => {
            validate_window(&window)?;
            if expected_revision.is_some_and(|expected| {
                state
                    .windows
                    .get(&window.window_id)
                    .map(|current| current.revision)
                    != Some(expected)
            }) {
                RuntimeCommit {
                    desired_effects: Vec::new(),
                    membership_changed: false,
                    operation_id: operation_id.clone(),
                    revision: state.revision,
                    status: RuntimeCommitStatus::Superseded,
                    terminal_events: Vec::new(),
                    window_ids: vec![window.window_id],
                    browser_result: None,
                }
            } else {
                let membership_changed = state
                    .windows
                    .get(&window.window_id)
                    .is_none_or(|current| tab_set(current) != tab_set(&window));
                let mut candidate = state.windows.clone();
                candidate.insert(window.window_id.clone(), window.clone());
                validate_candidate_ownership(&candidate, &HashSet::new())?;
                let revision = next_revision(state);
                window.revision = revision;
                let window_id = window.window_id.clone();
                state.windows.insert(window_id.clone(), window);
                basic_commit(state, membership_changed, vec![window_id])
            }
        }
        RuntimeIntent::RemoveWindow { window_id, .. } => {
            let removed = state.windows.remove(&window_id);
            if removed.is_some() {
                let retained_tab_ids = state
                    .windows
                    .values()
                    .flat_map(|window| window.tabs.iter().map(|tab| tab.id.as_str()))
                    .collect::<HashSet<_>>();
                state
                    .tab_activations
                    .retain(|tab_id, _| retained_tab_ids.contains(tab_id.as_str()));
                let operations = &state.operations;
                let logical_surfaces = &state.logical_surfaces;
                state.tombstones.retain(|tab_id, tombstone| {
                    let exact_surface_is_terminal = !logical_surfaces.contains_key(tab_id)
                        && operations.get(tombstone.operation_id.as_str()).is_some_and(
                            |operation| {
                                matches!(
                                    operation.phase,
                                    RuntimeOperationPhase::Completed
                                        | RuntimeOperationPhase::Failed
                                )
                            },
                        );
                    tombstone.window_id != window_id || !exact_surface_is_terminal
                });
                next_revision(state);
            }
            basic_commit(state, removed.is_some(), vec![window_id])
        }
        RuntimeIntent::BeginOperation(operation) => begin_operation(state, operation)?,
        RuntimeIntent::CloseTab {
            attempt_id,
            expected_revision,
            operation_id,
            surface_generation,
            successor_tab_id,
            tab_id,
            window_generation,
            window_id,
        } => close_tab(
            state,
            attempt_id,
            expected_revision,
            operation_id,
            surface_generation,
            successor_tab_id,
            tab_id,
            window_generation,
            window_id,
        )?,
        RuntimeIntent::NativeEvent(event) => apply_native_event(state, event)?,
        RuntimeIntent::FailEventStream {
            operation_ids,
            stream_id,
            terminal_code,
            ..
        } => fail_event_stream(state, operation_ids, stream_id, terminal_code)?,
        RuntimeIntent::TerminalizeOperation {
            operation_id,
            phase,
            terminal_code,
        } => terminalize_operation(state, operation_id, phase, terminal_code)?,
    };
    commit.operation_id = operation_id.clone();
    if commit.status == RuntimeCommitStatus::Applied
        && let Some(idempotency_key) = idempotency_key
    {
        remember_operation(state, idempotency_key);
    }
    record_trace(state, &commit, intent_kind, event_source, trace_context);
    Ok(commit)
}

fn snapshot_state(state: &RuntimeKernelState) -> CoreResult<RuntimeSnapshot> {
    validate_state(state)?;
    Ok(RuntimeSnapshot {
        browser_runtime: state.ownership.snapshot(),
        logical_surfaces: state.logical_surfaces.clone(),
        operations: state.operations.clone(),
        revision: state.revision,
        tab_activations: state.tab_activations.clone(),
        trace: state.trace.iter().cloned().collect(),
        tombstones: state.tombstones.clone(),
        windows: state.windows.clone(),
    })
}

fn audit_state(state: &RuntimeKernelState) -> CoreResult<RuntimeInvariantAudit> {
    validate_state(state)?;
    Ok(RuntimeInvariantAudit {
        live_tab_count: state.windows.values().map(|window| window.tabs.len()).sum(),
        live_window_count: state.windows.len(),
        logical_surface_count: state.logical_surfaces.len(),
        pending_operation_count: state
            .operations
            .values()
            .filter(|operation| !operation.phase.is_terminal())
            .count(),
        revision: state.revision,
        tombstone_count: state.tombstones.len(),
        trace: state.trace.iter().cloned().collect(),
    })
}

fn apply_browser_runtime(
    state: &mut RuntimeKernelState,
    command: BrowserRuntimeCommand,
) -> CoreResult<RuntimeCommit> {
    let mutates = !matches!(&command, BrowserRuntimeCommand::Snapshot);
    let result = state.ownership.invoke(command)?;
    if mutates {
        next_revision(state);
    }
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: None,
        revision: state.revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: Vec::new(),
        window_ids: Vec::new(),
        browser_result: Some(result),
    })
}

include!("state/trace.rs");

include!("state/tab_activation.rs");

fn begin_operation(
    state: &mut RuntimeKernelState,
    operation: RuntimeOperationRecord,
) -> CoreResult<RuntimeCommit> {
    if operation.phase != RuntimeOperationPhase::Pending {
        return Err(CoreError::InvalidInput(
            "a runtime operation must begin in the pending phase".to_owned(),
        ));
    }
    let operation_id = operation.operation_id.as_str().to_owned();
    let mut terminal_events = Vec::new();
    if let (Some(tab_id), Some(attempt_id)) =
        (operation.tab_id.clone(), operation.attempt_id.clone())
    {
        if state.logical_surfaces.contains_key(tab_id.as_str()) {
            return Ok(superseded_commit(state, Some(operation_id), Vec::new()));
        }
        if let Some(tombstone) = state.tombstones.get(tab_id.as_str()).cloned() {
            let relaunch_is_admissible = state
                .operations
                .get(tombstone.operation_id.as_str())
                .is_some_and(|close| {
                    close.phase.is_terminal() && close.attempt_id.as_ref() != Some(&attempt_id)
                });
            if !relaunch_is_admissible {
                return Ok(superseded_commit(state, Some(operation_id), Vec::new()));
            }
            state.tombstones.remove(tab_id.as_str());
            for previous in state.operations.values_mut().filter(|previous| {
                previous.tab_id.as_ref() == Some(&tab_id) && !previous.phase.is_terminal()
            }) {
                previous.phase = RuntimeOperationPhase::Cancelled;
                previous.terminal_code = Some("SUPERSEDED_BY_RELAUNCH".to_owned());
                terminal_events.push(RuntimeTerminalEvent {
                    operation_id: previous.operation_id.clone(),
                    phase: RuntimeOperationPhase::Cancelled,
                    terminal_code: previous.terminal_code.clone(),
                });
            }
        }
        state.logical_surfaces.insert(
            tab_id.as_str().to_owned(),
            RuntimeLogicalSurfaceRecord {
                attempt_id,
                lifecycle: RuntimeSurfaceLifecycle::Desired,
                operation_id: operation.operation_id.clone(),
                surface_generation: operation.surface_generation,
                tab_id: tab_id.clone(),
                window_generation: operation.window_generation,
            },
        );
        let current_owner = state.windows.iter().find_map(|(window_id, window)| {
            window.contains_tab(tab_id.as_str()).then(|| {
                (
                    window_id.clone(),
                    RuntimeWindowGeneration(window.window_generation),
                )
            })
        });
        if let Some(activation) = state.tab_activations.get_mut(tab_id.as_str())
            && operation.window_id.as_deref() == Some(activation.owner_window_id.as_str())
            && current_owner.as_ref()
                == Some(&(
                    activation.owner_window_id.clone(),
                    operation.window_generation,
                ))
            && activation.window_generation == operation.window_generation
        {
            activation.native_operation_id = Some(operation.operation_id.clone());
            activation.phase = RuntimeTabActivationPhaseRecord::Attaching;
        }
    }
    state.operations.insert(operation_id.clone(), operation);
    let revision = next_revision(state);
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: Some(operation_id),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events,
        window_ids: Vec::new(),
        browser_result: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn close_tab(
    state: &mut RuntimeKernelState,
    attempt_id: Option<LaunchAttemptId>,
    expected_revision: Option<u64>,
    operation_id: OperationId,
    surface_generation: RuntimeSurfaceGeneration,
    successor_tab_id: Option<RuntimeTabId>,
    tab_id: RuntimeTabId,
    window_generation: RuntimeWindowGeneration,
    window_id: String,
) -> CoreResult<RuntimeCommit> {
    if state.tombstones.contains_key(tab_id.as_str()) {
        return Ok(superseded_commit(
            state,
            Some(operation_id.as_str().to_owned()),
            vec![window_id],
        ));
    }
    let Some(current) = state.windows.get(&window_id) else {
        return Ok(superseded_commit(
            state,
            Some(operation_id.as_str().to_owned()),
            vec![window_id],
        ));
    };
    if expected_revision.is_some_and(|expected| current.revision != expected)
        || current.window_generation != window_generation.0
        || !current.contains_tab(tab_id.as_str())
        || successor_tab_id.as_ref().is_some_and(|successor| {
            successor == &tab_id
                || !current.contains_tab(successor.as_str())
                || current.hidden_tab_ids.contains(successor.as_str())
        })
    {
        return Ok(superseded_commit(
            state,
            Some(operation_id.as_str().to_owned()),
            vec![window_id],
        ));
    }
    let dormant_without_surface = state
        .tab_activations
        .get(tab_id.as_str())
        .is_some_and(|activation| activation.phase == RuntimeTabActivationPhaseRecord::Dormant)
        && !state.logical_surfaces.contains_key(tab_id.as_str());
    let revision = next_revision(state);
    let window = state
        .windows
        .get_mut(&window_id)
        .expect("close candidate was validated");
    window.remove_tab(tab_id.as_str(), revision);
    if let Some(successor) = successor_tab_id {
        window.select(Some(successor.into_string()), revision);
    } else if window.selected_tab_id.is_none() {
        window.select(None, revision);
    }
    state.tab_activations.remove(tab_id.as_str());
    let mut terminal_events = Vec::new();
    for previous in state.operations.values_mut().filter(|previous| {
        previous.tab_id.as_ref() == Some(&tab_id) && !previous.phase.is_terminal()
    }) {
        previous.phase = RuntimeOperationPhase::Cancelled;
        previous.terminal_code = Some("SUPERSEDED_BY_CLOSE".to_owned());
        terminal_events.push(RuntimeTerminalEvent {
            operation_id: previous.operation_id.clone(),
            phase: RuntimeOperationPhase::Cancelled,
            terminal_code: previous.terminal_code.clone(),
        });
    }
    let operation = RuntimeOperationRecord {
        attempt_id,
        kind: "closeTab".to_owned(),
        operation_id: operation_id.clone(),
        phase: if dormant_without_surface {
            RuntimeOperationPhase::Completed
        } else {
            RuntimeOperationPhase::Pending
        },
        surface_generation,
        tab_id: Some(tab_id.clone()),
        terminal_code: None,
        window_generation,
        window_id: Some(window_id.clone()),
    };
    state
        .operations
        .insert(operation_id.as_str().to_owned(), operation);
    if !dormant_without_surface {
        state.tombstones.insert(
            tab_id.as_str().to_owned(),
            RuntimeTabTombstone {
                operation_id: operation_id.clone(),
                revision,
                surface_generation,
                tab_id: tab_id.clone(),
                window_generation,
                window_id: window_id.clone(),
            },
        );
    }
    if let Some(surface) = state.logical_surfaces.get_mut(tab_id.as_str()) {
        surface.lifecycle = RuntimeSurfaceLifecycle::Closing;
        surface.operation_id = operation_id.clone();
        surface.surface_generation = surface_generation;
        surface.window_generation = window_generation;
    }
    let desired_effects = if dormant_without_surface {
        Vec::new()
    } else {
        vec![RuntimeDesiredEffect::TeardownTab {
            operation_id,
            tab_id,
            window_id: window_id.clone(),
        }]
    };
    Ok(RuntimeCommit {
        desired_effects,
        membership_changed: true,
        operation_id: None,
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events,
        window_ids: vec![window_id],
        browser_result: None,
    })
}

fn apply_native_event(
    state: &mut RuntimeKernelState,
    event: NativeRuntimeEvent,
) -> CoreResult<RuntimeCommit> {
    let operation_id = event.operation_id.as_str().to_owned();
    let window_ids = state
        .windows
        .iter()
        .find_map(|(window_id, window)| {
            window
                .contains_tab(event.tab_id.as_str())
                .then(|| vec![window_id.clone()])
        })
        .or_else(|| {
            state
                .tombstones
                .get(event.tab_id.as_str())
                .map(|tombstone| vec![tombstone.window_id.clone()])
        })
        .unwrap_or_default();
    let Some(operation) = state.operations.get(&operation_id).cloned() else {
        return Ok(superseded_commit(state, Some(operation_id), window_ids));
    };
    if operation.phase.is_terminal() {
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: Some(operation_id),
            revision: state.revision,
            status: RuntimeCommitStatus::Duplicate,
            terminal_events: Vec::new(),
            window_ids,
            browser_result: None,
        });
    }
    let identity_matches = operation.tab_id.as_ref() == Some(&event.tab_id)
        && operation.attempt_id.as_ref() == Some(&event.attempt_id)
        && operation.window_generation == event.window_generation
        && operation.surface_generation == event.surface_generation;
    if !identity_matches {
        return Ok(superseded_commit(state, Some(operation_id), window_ids));
    }
    let has_tombstone = state.tombstones.contains_key(event.tab_id.as_str());
    if has_tombstone && event.event_kind != "closed" && event.event_kind != "failed" {
        return Ok(superseded_commit(state, Some(operation_id), window_ids));
    }
    let activation_event_matches =
        state
            .tab_activations
            .get(event.tab_id.as_str())
            .map(|activation| {
                activation.native_operation_id.as_ref() == Some(&event.operation_id)
                    && activation.window_generation == event.window_generation
                    && state.windows.iter().any(|(window_id, window)| {
                        window.contains_tab(event.tab_id.as_str())
                            && activation.owner_window_id == *window_id
                            && RuntimeWindowGeneration(window.window_generation)
                                == event.window_generation
                    })
            });
    if activation_event_matches == Some(false) {
        return Ok(superseded_commit(state, Some(operation_id), window_ids));
    }
    let (lifecycle, terminal_phase, terminal_code) = match event.event_kind.as_str() {
        "attached" => (RuntimeSurfaceLifecycle::Attached, None, None),
        "ready" => (
            RuntimeSurfaceLifecycle::Ready,
            Some(RuntimeOperationPhase::Completed),
            None,
        ),
        "failed" => (
            RuntimeSurfaceLifecycle::Failed,
            Some(RuntimeOperationPhase::Failed),
            Some("NATIVE_SURFACE_FAILED".to_owned()),
        ),
        "closed" => (
            RuntimeSurfaceLifecycle::Closed,
            Some(RuntimeOperationPhase::Completed),
            None,
        ),
        _ => {
            return Err(CoreError::InvalidInput(
                "native runtime event kind is invalid".to_owned(),
            ));
        }
    };
    if activation_event_matches == Some(true)
        && let Some(activation) = state.tab_activations.get_mut(event.tab_id.as_str())
    {
        let next_phase = match event.event_kind.as_str() {
            "attached" => RuntimeTabActivationPhaseRecord::Attaching,
            "ready" => RuntimeTabActivationPhaseRecord::Ready,
            "failed" => RuntimeTabActivationPhaseRecord::Failed,
            _ => activation.phase,
        };
        if activation.phase == next_phase
            || tab_activation_transition_allowed(activation.phase, next_phase)
        {
            activation.phase = next_phase;
        }
    }
    if let Some(surface) = state.logical_surfaces.get_mut(event.tab_id.as_str()) {
        if surface.lifecycle == lifecycle {
            return Ok(RuntimeCommit {
                desired_effects: Vec::new(),
                membership_changed: false,
                operation_id: Some(operation_id),
                revision: state.revision,
                status: RuntimeCommitStatus::Duplicate,
                terminal_events: Vec::new(),
                window_ids,
                browser_result: None,
            });
        }
        surface.lifecycle = lifecycle;
    }
    let mut terminal_events = Vec::new();
    if let Some(phase) = terminal_phase {
        if let Some(operation) = state.operations.get_mut(&operation_id) {
            operation.phase = phase;
            operation.terminal_code = terminal_code.clone();
        }
        terminal_events.push(RuntimeTerminalEvent {
            operation_id: event.operation_id.clone(),
            phase,
            terminal_code,
        });
        if matches!(
            lifecycle,
            RuntimeSurfaceLifecycle::Closed | RuntimeSurfaceLifecycle::Failed
        ) {
            state.logical_surfaces.remove(event.tab_id.as_str());
            let owner_window_is_retired = state
                .tombstones
                .get(event.tab_id.as_str())
                .is_some_and(|tombstone| !state.windows.contains_key(&tombstone.window_id));
            if owner_window_is_retired {
                state.tombstones.remove(event.tab_id.as_str());
            }
        }
    }
    let revision = next_revision(state);
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: Some(operation_id),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events,
        window_ids,
        browser_result: None,
    })
}

fn fail_event_stream(
    state: &mut RuntimeKernelState,
    operation_ids: Vec<OperationId>,
    stream_id: OperationId,
    terminal_code: String,
) -> CoreResult<RuntimeCommit> {
    if operation_ids.is_empty() || terminal_code.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "runtime event stream failure requires operations and a terminal code".to_owned(),
        ));
    }
    let mut unique_operation_ids = HashSet::new();
    let mut terminal_events = Vec::new();
    let mut window_ids = HashSet::new();
    for operation_id in operation_ids {
        if !unique_operation_ids.insert(operation_id.as_str().to_owned()) {
            continue;
        }
        let Some(operation) = state.operations.get_mut(operation_id.as_str()) else {
            continue;
        };
        if operation.phase.is_terminal() {
            continue;
        }
        operation.phase = RuntimeOperationPhase::Indeterminate;
        operation.terminal_code = Some(terminal_code.clone());
        if let Some(tab_id) = operation.tab_id.as_ref() {
            if let Some((window_id, _)) = state
                .windows
                .iter()
                .find(|(_, window)| window.contains_tab(tab_id.as_str()))
            {
                window_ids.insert(window_id.clone());
            }
            if let Some(surface) = state.logical_surfaces.get_mut(tab_id.as_str())
                && surface.operation_id == operation_id
                && matches!(
                    surface.lifecycle,
                    RuntimeSurfaceLifecycle::Desired
                        | RuntimeSurfaceLifecycle::Attached
                        | RuntimeSurfaceLifecycle::Ready
                )
            {
                surface.lifecycle = RuntimeSurfaceLifecycle::Failed;
            }
        }
        terminal_events.push(RuntimeTerminalEvent {
            operation_id,
            phase: RuntimeOperationPhase::Indeterminate,
            terminal_code: Some(terminal_code.clone()),
        });
    }
    if terminal_events.is_empty() {
        return Ok(superseded_commit(
            state,
            Some(stream_id.as_str().to_owned()),
            Vec::new(),
        ));
    }
    let revision = next_revision(state);
    let mut window_ids = window_ids.into_iter().collect::<Vec<_>>();
    window_ids.sort();
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: Some(stream_id.as_str().to_owned()),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events,
        window_ids,
        browser_result: None,
    })
}

fn terminalize_operation(
    state: &mut RuntimeKernelState,
    operation_id: OperationId,
    phase: RuntimeOperationPhase,
    terminal_code: Option<String>,
) -> CoreResult<RuntimeCommit> {
    if !phase.is_terminal() {
        return Err(CoreError::InvalidInput(
            "a runtime terminal outcome cannot be pending".to_owned(),
        ));
    }
    let Some(operation) = state.operations.get_mut(operation_id.as_str()) else {
        return Ok(superseded_commit(
            state,
            Some(operation_id.as_str().to_owned()),
            Vec::new(),
        ));
    };
    if operation.phase.is_terminal() {
        let status = if operation.phase == phase && operation.terminal_code == terminal_code {
            RuntimeCommitStatus::Duplicate
        } else {
            RuntimeCommitStatus::Superseded
        };
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: Some(operation_id.as_str().to_owned()),
            revision: state.revision,
            status,
            terminal_events: Vec::new(),
            window_ids: Vec::new(),
            browser_result: None,
        });
    }
    operation.phase = phase;
    operation.terminal_code = terminal_code.clone();
    let revision = next_revision(state);
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: Some(operation_id.as_str().to_owned()),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: vec![RuntimeTerminalEvent {
            operation_id,
            phase,
            terminal_code,
        }],
        window_ids: Vec::new(),
        browser_result: None,
    })
}

fn superseded_commit(
    state: &RuntimeKernelState,
    operation_id: Option<String>,
    window_ids: Vec<String>,
) -> RuntimeCommit {
    RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id,
        revision: state.revision,
        status: RuntimeCommitStatus::Superseded,
        terminal_events: Vec::new(),
        window_ids,
        browser_result: None,
    }
}

fn apply_topology(
    state: &mut RuntimeKernelState,
    mut input: RuntimeTopologyCommitInput,
) -> CoreResult<RuntimeCommit> {
    if input.commit_id.trim().is_empty()
        || !matches!(
            input.source.as_str(),
            "appKit" | "html" | "restore" | "command"
        )
    {
        return Err(CoreError::InvalidInput(
            "runtime topology commit identity or source is invalid".to_owned(),
        ));
    }
    if input.windows.is_empty() {
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: Some(input.commit_id),
            revision: state.revision,
            status: RuntimeCommitStatus::Superseded,
            terminal_events: Vec::new(),
            window_ids: Vec::new(),
            browser_result: None,
        });
    }
    input
        .windows
        .sort_by(|left, right| left.window_id.cmp(&right.window_id));
    let stale = input.windows.iter().any(|commit| {
        state.windows.get(&commit.window_id).is_some_and(|window| {
            commit.window_generation < window.window_generation
                || (commit.window_generation == window.window_generation
                    && commit.ui_sequence > 0
                    && commit.ui_sequence <= window.ui_sequence)
        })
    });
    let window_ids = input
        .windows
        .iter()
        .map(|window| window.window_id.clone())
        .collect::<Vec<_>>();
    if stale {
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: Some(input.commit_id),
            revision: state.revision,
            status: RuntimeCommitStatus::Superseded,
            terminal_events: Vec::new(),
            window_ids,
            browser_result: None,
        });
    }
    let touched = window_ids.iter().cloned().collect::<HashSet<_>>();
    let mut candidate = state.windows.clone();
    let mut owner_by_tab = HashMap::<String, String>::new();
    for commit in &input.windows {
        for tab in &commit.tabs {
            if commit.window_id == input.primary_window_id || !owner_by_tab.contains_key(&tab.id) {
                owner_by_tab.insert(tab.id.clone(), commit.window_id.clone());
            }
        }
    }
    for mut commit in input.windows {
        commit.tabs.retain(|tab| {
            owner_by_tab.get(&tab.id).map(String::as_str) == Some(commit.window_id.as_str())
        });
        let tab_ids = commit
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .collect::<HashSet<_>>();
        commit
            .hidden_tab_ids
            .retain(|tab_id| tab_ids.contains(tab_id.as_str()));
        let active_tab_id = commit
            .active_tab_id
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
        let previous = candidate.remove(&commit.window_id).unwrap_or_default();
        candidate.insert(
            commit.window_id.clone(),
            RuntimeLiveWindowRecord {
                hidden_tab_ids: commit.hidden_tab_ids,
                placement_sequence: previous.placement_sequence,
                persisted_name: previous.persisted_name,
                placement: previous.placement,
                revision: 0,
                selected_tab_id: active_tab_id,
                tabs: commit.tabs,
                target_display: previous.target_display,
                ui_sequence: commit.ui_sequence,
                window_generation: commit.window_generation,
                window_id: commit.window_id,
                window_zoom_factor: previous.window_zoom_factor,
            },
        );
    }
    validate_candidate_ownership(&candidate, &touched)?;
    let membership_changed = window_ids.iter().any(|window_id| {
        match (state.windows.get(window_id), candidate.get(window_id)) {
            (Some(before), Some(after)) => tab_set(before) != tab_set(after),
            (None, Some(after)) => !after.tabs.is_empty(),
            _ => false,
        }
    });
    let revision = next_revision(state);
    for window_id in &window_ids {
        if let Some(mut window) = candidate.remove(window_id) {
            window.revision = revision;
            state.windows.insert(window_id.clone(), window);
        }
    }
    let retained_tab_ids = state
        .windows
        .values()
        .flat_map(|window| window.tabs.iter().map(|tab| tab.id.as_str()))
        .collect::<HashSet<_>>();
    state
        .tab_activations
        .retain(|tab_id, _| retained_tab_ids.contains(tab_id.as_str()));
    let activation_owners = state
        .windows
        .iter()
        .flat_map(|(window_id, window)| {
            window.tabs.iter().map(move |tab| {
                (
                    tab.id.clone(),
                    (
                        window_id.clone(),
                        RuntimeWindowGeneration(window.window_generation),
                    ),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let mut terminal_events = Vec::new();
    for (tab_id, activation) in &mut state.tab_activations {
        let Some((owner_window_id, window_generation)) = activation_owners.get(tab_id) else {
            continue;
        };
        if activation.owner_window_id == *owner_window_id
            && activation.window_generation == *window_generation
        {
            continue;
        }
        if matches!(
            activation.phase,
            RuntimeTabActivationPhaseRecord::Activating
                | RuntimeTabActivationPhaseRecord::Attaching
                | RuntimeTabActivationPhaseRecord::Loading
        ) {
            activation.phase = RuntimeTabActivationPhaseRecord::Failed;
            if let Some(native_operation_id) = activation.native_operation_id.take()
                && let Some(operation) = state.operations.get_mut(native_operation_id.as_str())
                && !operation.phase.is_terminal()
            {
                operation.phase = RuntimeOperationPhase::Cancelled;
                operation.terminal_code = Some("TAB_ACTIVATION_OWNER_CHANGED".to_owned());
                terminal_events.push(RuntimeTerminalEvent {
                    operation_id: operation.operation_id.clone(),
                    phase: RuntimeOperationPhase::Cancelled,
                    terminal_code: operation.terminal_code.clone(),
                });
            }
            state.logical_surfaces.remove(tab_id);
        }
        activation.native_operation_id = None;
        activation.owner_window_id.clone_from(owner_window_id);
        activation.window_generation = *window_generation;
    }
    validate_state(state)?;
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed,
        operation_id: Some(input.commit_id),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events,
        window_ids,
        browser_result: None,
    })
}

fn apply_placement(
    state: &mut RuntimeKernelState,
    input: RuntimeWindowPlacementCommitInput,
) -> CoreResult<RuntimeCommit> {
    let current = state
        .windows
        .get(&input.window_id)
        .cloned()
        .unwrap_or_default();
    if input.window_generation < current.window_generation
        || (input.window_generation == current.window_generation
            && input.placement_sequence <= current.placement_sequence)
    {
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: Some(input.operation_id),
            revision: current.revision,
            status: RuntimeCommitStatus::Superseded,
            terminal_events: Vec::new(),
            window_ids: vec![input.window_id],
            browser_result: None,
        });
    }
    let revision = next_revision(state);
    let window = state.windows.entry(input.window_id.clone()).or_default();
    window.placement = Some(input.placement);
    window.placement_sequence = input.placement_sequence;
    window.revision = revision;
    window.target_display = Some(input.target_display);
    window.window_generation = input.window_generation;
    window.window_id = input.window_id.clone();
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: Some(input.operation_id),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: Vec::new(),
        window_ids: vec![input.window_id],
        browser_result: None,
    })
}

fn apply_window_context(
    state: &mut RuntimeKernelState,
    input: RuntimeWindowContextInitializeInput,
) -> CoreResult<RuntimeCommit> {
    let current = state.windows.get(&input.window_id).cloned();
    if current
        .as_ref()
        .is_some_and(|window| input.window_generation < window.window_generation)
    {
        return Ok(superseded_commit(
            state,
            Some(input.operation_id),
            vec![input.window_id],
        ));
    }

    let generation_advanced = current
        .as_ref()
        .is_some_and(|window| input.window_generation > window.window_generation);
    let should_seed_placement = generation_advanced
        || current
            .as_ref()
            .is_none_or(|window| window.placement.is_none() || window.target_display.is_none());
    let next_name = input.persisted_name.or_else(|| {
        current
            .as_ref()
            .and_then(|window| window.persisted_name.clone())
    });
    let changed = current.as_ref().is_none_or(|window| {
        window.persisted_name != next_name
            || window.window_generation != input.window_generation
            || (should_seed_placement
                && (window.placement.as_ref() != Some(&input.placement)
                    || window.target_display.as_ref() != Some(&input.target_display)))
    });
    if !changed {
        return Ok(basic_commit(state, false, vec![input.window_id]));
    }

    let revision = next_revision(state);
    let tab_ids = {
        let window = state.windows.entry(input.window_id.clone()).or_default();
        window.window_id.clone_from(&input.window_id);
        window.persisted_name = next_name;
        if should_seed_placement {
            window.placement = Some(input.placement);
            window.target_display = Some(input.target_display);
        }
        if generation_advanced {
            window.placement_sequence = 0;
        }
        window.window_generation = input.window_generation;
        window.revision = revision;
        window
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>()
    };
    let next_generation = RuntimeWindowGeneration(input.window_generation);
    for tab_id in tab_ids {
        if let Some(activation) = state.tab_activations.get_mut(&tab_id)
            && activation.window_generation != next_generation
        {
            if matches!(
                activation.phase,
                RuntimeTabActivationPhaseRecord::Activating
                    | RuntimeTabActivationPhaseRecord::Attaching
                    | RuntimeTabActivationPhaseRecord::Loading
            ) {
                activation.phase = RuntimeTabActivationPhaseRecord::Failed;
            }
            activation.native_operation_id = None;
            activation.owner_window_id.clone_from(&input.window_id);
            activation.window_generation = next_generation;
        }
    }
    Ok(basic_commit(state, false, vec![input.window_id]))
}

fn basic_commit(
    state: &RuntimeKernelState,
    membership_changed: bool,
    window_ids: Vec<String>,
) -> RuntimeCommit {
    RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed,
        operation_id: None,
        revision: state.revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: Vec::new(),
        window_ids,
        browser_result: None,
    }
}

fn next_revision(state: &mut RuntimeKernelState) -> u64 {
    state.revision = state.revision.saturating_add(1).max(1);
    state.revision
}

fn remember_operation(state: &mut RuntimeKernelState, operation_id: String) {
    if !state.applied_operation_ids.insert(operation_id.clone()) {
        return;
    }
    state.operation_order.push_back(operation_id);
    while state.operation_order.len() > RETAINED_OPERATION_IDS {
        if let Some(expired) = state.operation_order.pop_front() {
            state.applied_operation_ids.remove(&expired);
        }
    }
}

fn tab_set(window: &RuntimeLiveWindowRecord) -> HashSet<&str> {
    window.tabs.iter().map(|tab| tab.id.as_str()).collect()
}

fn validate_candidate_ownership(
    windows: &HashMap<String, RuntimeLiveWindowRecord>,
    touched: &HashSet<String>,
) -> CoreResult<()> {
    let mut owners = HashMap::<&str, &str>::new();
    for (window_id, window) in windows {
        for tab in &window.tabs {
            if let Some(previous) = owners.insert(&tab.id, window_id)
                && previous != window_id
            {
                let scope = if touched.contains(previous) && touched.contains(window_id) {
                    "committed"
                } else {
                    "untouched"
                };
                return Err(CoreError::Domain {
                    code: "RUNTIME_TAB_OWNER_CONFLICT",
                    message: format!(
                        "Runtime tab {} has conflicting {scope} window owners.",
                        tab.id
                    ),
                });
            }
        }
    }
    Ok(())
}

include!("state/validation.rs");
