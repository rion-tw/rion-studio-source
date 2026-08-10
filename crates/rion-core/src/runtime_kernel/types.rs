use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub use crate::model::RuntimeOperationTraceRecord;
use crate::model::{
    BrowserRuntimeResult, BrowserRuntimeSnapshot, DisplayTargetRecord, GameWindowPlacementRecord,
    GameWindowRoleSlotRecord, RuntimeTabActivationPhaseRecord,
};

macro_rules! identity_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, String> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(concat!(stringify!($name), " cannot be empty.").to_owned());
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }
    };
}

identity_type!(RuntimeTabId);
identity_type!(LaunchAttemptId);
identity_type!(OperationId);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RuntimeWindowGeneration(pub u64);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RuntimeSurfaceGeneration(pub u64);

#[derive(Clone, Debug)]
pub struct RuntimeLiveTabRecord {
    pub audio_muted: bool,
    pub closable: bool,
    pub icon_data_url: Option<String>,
    pub id: String,
    pub persistable: bool,
    pub role_ids: Vec<String>,
    pub role_slots: Vec<GameWindowRoleSlotRecord>,
    pub source_id: String,
    pub tab_type: String,
    pub title: String,
    pub workspace_template: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeLiveWindowRecord {
    pub hidden_tab_ids: HashSet<String>,
    pub persisted_name: Option<String>,
    pub placement: Option<GameWindowPlacementRecord>,
    pub revision: u64,
    pub selected_tab_id: Option<String>,
    pub tabs: Vec<RuntimeLiveTabRecord>,
    pub target_display: Option<DisplayTargetRecord>,
    pub ui_sequence: u64,
    pub window_generation: u64,
    pub window_id: String,
    pub window_zoom_factor: Option<f64>,
}

impl RuntimeLiveWindowRecord {
    pub fn tab_ids(&self) -> Vec<String> {
        self.tabs
            .iter()
            .filter(|tab| !self.hidden_tab_ids.contains(&tab.id))
            .map(|tab| tab.id.clone())
            .collect()
    }

    pub fn all_tab_ids(&self) -> Vec<String> {
        self.tabs.iter().map(|tab| tab.id.clone()).collect()
    }

    pub fn tab_is_hidden(&self, tab_id: &str) -> bool {
        self.hidden_tab_ids.contains(tab_id)
    }

    pub fn contains_tab(&self, tab_id: &str) -> bool {
        self.tabs.iter().any(|tab| tab.id == tab_id)
    }

    pub fn set_tab_hidden(&mut self, tab_id: &str, hidden: bool, revision: u64) -> bool {
        if !self.contains_tab(tab_id) {
            return false;
        }
        let changed = if hidden {
            self.hidden_tab_ids.insert(tab_id.to_owned())
        } else {
            self.hidden_tab_ids.remove(tab_id)
        };
        if changed {
            self.revision = revision;
        }
        changed
    }

    pub fn insert_tab(&mut self, tab: RuntimeLiveTabRecord, revision: u64, select: bool) {
        let id = tab.id.clone();
        if let Some(existing) = self.tabs.iter_mut().find(|existing| existing.id == id) {
            *existing = tab;
        } else {
            self.tabs.push(tab);
        }
        self.revision = revision;
        if select {
            self.select(Some(id), revision);
        }
    }

    pub fn remove_tab(&mut self, tab_id: &str, revision: u64) -> bool {
        let existed = self.tabs.iter().any(|tab| tab.id == tab_id);
        self.tabs.retain(|tab| tab.id != tab_id);
        self.hidden_tab_ids.remove(tab_id);
        if existed {
            self.revision = revision;
        }
        if self.selected_tab_id.as_deref() == Some(tab_id) {
            self.select(None, revision);
        }
        existed
    }

    pub fn select(&mut self, tab_id: Option<String>, revision: u64) {
        if let Some(tab_id) = tab_id.as_deref() {
            self.hidden_tab_ids.remove(tab_id);
        }
        self.revision = revision;
        self.selected_tab_id = tab_id;
    }

    pub fn update_metadata(
        &mut self,
        tab_id: &str,
        source_id: &str,
        tab_type: &str,
        role_ids: &[String],
        title: &str,
    ) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.role_ids = role_ids.to_vec();
            tab.source_id = source_id.to_owned();
            tab.tab_type = tab_type.to_owned();
            tab.title = title.to_owned();
        }
    }

    pub fn tab_title(&self, tab_id: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.title.clone())
    }

    pub fn reorder_known_tabs(&mut self, ordered_tab_ids: &[String]) {
        let positions = ordered_tab_ids
            .iter()
            .enumerate()
            .map(|(index, tab_id)| (tab_id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let fallback = ordered_tab_ids.len();
        self.tabs
            .sort_by_key(|tab| positions.get(tab.id.as_str()).copied().unwrap_or(fallback));
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeWindowTopologyCommit {
    pub active_tab_id: Option<String>,
    pub hidden_tab_ids: HashSet<String>,
    pub tabs: Vec<RuntimeLiveTabRecord>,
    pub ui_sequence: u64,
    pub window_generation: u64,
    pub window_id: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeTopologyCommitInput {
    pub commit_id: String,
    pub source: String,
    pub primary_window_id: String,
    pub windows: Vec<RuntimeWindowTopologyCommit>,
}

#[derive(Clone, Debug)]
pub struct RuntimeWindowPlacementCommitInput {
    pub operation_id: String,
    pub placement: GameWindowPlacementRecord,
    pub source: String,
    pub target_display: DisplayTargetRecord,
    pub ui_sequence: u64,
    pub window_generation: u64,
    pub window_id: String,
}

#[derive(Clone, Debug)]
pub enum RuntimeIntent {
    BrowserRuntime(crate::model::BrowserRuntimeCommand),
    CommitTopology(RuntimeTopologyCommitInput),
    CommitPlacement(RuntimeWindowPlacementCommitInput),
    EnsureWindow {
        operation_id: String,
        window_id: String,
    },
    SetWindowGeneration {
        generation: u64,
        operation_id: String,
        window_id: String,
    },
    SetPersistedName {
        name: Option<String>,
        operation_id: String,
        window_id: String,
    },
    SetTabAudioMuted {
        audio_muted: bool,
        expected_revision: Option<u64>,
        operation_id: String,
        tab_id: String,
        window_id: String,
    },
    SetRoleZoom {
        browser_zoom_percent: Option<f64>,
        expected_revision: Option<u64>,
        operation_id: String,
        role_id: String,
        tab_id: String,
        window_id: String,
    },
    ReplaceTabRoleSlots {
        expected_revision: Option<u64>,
        operation_id: String,
        role_slots: Vec<GameWindowRoleSlotRecord>,
        tab_id: String,
        window_id: String,
    },
    SetWindowZoomFactor {
        expected_revision: Option<u64>,
        operation_id: String,
        window_id: String,
        zoom_factor: f64,
    },
    SeedDormantTabs {
        operation_id: String,
        tab_ids: Vec<String>,
        window_id: String,
    },
    ActivateTab {
        expected_revision: Option<u64>,
        operation_id: OperationId,
        tab_id: RuntimeTabId,
        window_id: String,
    },
    SetTabActivationPhase {
        activation_attempt_id: OperationId,
        operation_id: String,
        phase: RuntimeTabActivationPhaseRecord,
        tab_id: RuntimeTabId,
    },
    ReplaceWindow {
        expected_revision: Option<u64>,
        operation_id: String,
        source: String,
        window: RuntimeLiveWindowRecord,
    },
    RemoveWindow {
        operation_id: String,
        window_id: String,
    },
    BeginOperation(RuntimeOperationRecord),
    CloseTab {
        attempt_id: Option<LaunchAttemptId>,
        expected_revision: Option<u64>,
        operation_id: OperationId,
        surface_generation: RuntimeSurfaceGeneration,
        successor_tab_id: Option<RuntimeTabId>,
        tab_id: RuntimeTabId,
        window_generation: RuntimeWindowGeneration,
        window_id: String,
    },
    NativeEvent(NativeRuntimeEvent),
    FailEventStream {
        operation_ids: Vec<OperationId>,
        source: String,
        stream_id: OperationId,
        terminal_code: String,
    },
    TerminalizeOperation {
        operation_id: OperationId,
        phase: RuntimeOperationPhase,
        terminal_code: Option<String>,
    },
}

impl RuntimeIntent {
    pub(crate) fn operation_id(&self) -> Option<&str> {
        match self {
            Self::BrowserRuntime(_) => None,
            Self::CommitTopology(input) => Some(&input.commit_id),
            Self::CommitPlacement(input) => Some(&input.operation_id),
            Self::EnsureWindow { operation_id, .. }
            | Self::SetWindowGeneration { operation_id, .. }
            | Self::SetPersistedName { operation_id, .. }
            | Self::SetTabAudioMuted { operation_id, .. }
            | Self::SetRoleZoom { operation_id, .. }
            | Self::ReplaceTabRoleSlots { operation_id, .. }
            | Self::SetWindowZoomFactor { operation_id, .. }
            | Self::SeedDormantTabs { operation_id, .. }
            | Self::SetTabActivationPhase { operation_id, .. }
            | Self::ReplaceWindow { operation_id, .. }
            | Self::RemoveWindow { operation_id, .. } => Some(operation_id),
            Self::BeginOperation(operation) => Some(operation.operation_id.as_str()),
            Self::ActivateTab { operation_id, .. }
            | Self::CloseTab { operation_id, .. }
            | Self::TerminalizeOperation { operation_id, .. } => Some(operation_id.as_str()),
            Self::NativeEvent(event) => Some(event.operation_id.as_str()),
            Self::FailEventStream { stream_id, .. } => Some(stream_id.as_str()),
        }
    }

    pub(crate) fn idempotency_key(&self) -> Option<&str> {
        match self {
            Self::BrowserRuntime(_) | Self::NativeEvent(_) | Self::TerminalizeOperation { .. } => {
                None
            }
            _ => self.operation_id(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeCommitStatus {
    Applied,
    Duplicate,
    Superseded,
}

#[derive(Clone, Debug)]
pub struct RuntimeCommit {
    pub desired_effects: Vec<RuntimeDesiredEffect>,
    pub membership_changed: bool,
    pub operation_id: Option<String>,
    pub revision: u64,
    pub status: RuntimeCommitStatus,
    pub terminal_events: Vec<RuntimeTerminalEvent>,
    pub window_ids: Vec<String>,
    pub browser_result: Option<BrowserRuntimeResult>,
}

#[derive(Clone, Debug)]
pub struct RuntimeSnapshot {
    pub browser_runtime: BrowserRuntimeSnapshot,
    pub logical_surfaces: HashMap<String, RuntimeLogicalSurfaceRecord>,
    pub operations: HashMap<String, RuntimeOperationRecord>,
    pub revision: u64,
    pub tab_activations: HashMap<String, RuntimeTabActivationRecord>,
    pub trace: Vec<RuntimeOperationTraceRecord>,
    pub tombstones: HashMap<String, RuntimeTabTombstone>,
    pub windows: HashMap<String, RuntimeLiveWindowRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTabActivationRecord {
    pub attempt_id: OperationId,
    pub native_operation_id: Option<OperationId>,
    pub owner_window_id: String,
    pub phase: RuntimeTabActivationPhaseRecord,
    pub tab_id: RuntimeTabId,
    pub window_generation: RuntimeWindowGeneration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeInvariantAudit {
    pub live_tab_count: usize,
    pub live_window_count: usize,
    pub logical_surface_count: usize,
    pub pending_operation_count: usize,
    pub revision: u64,
    pub tombstone_count: usize,
    pub trace: Vec<RuntimeOperationTraceRecord>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeLaunchDisposition {
    Existing,
    Admitted,
    Joined,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLaunchAdmission {
    pub attempt_id: LaunchAttemptId,
    pub disposition: RuntimeLaunchDisposition,
    pub operation_id: OperationId,
    pub tab_id: RuntimeTabId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeEvent {
    pub attempt_id: LaunchAttemptId,
    pub event_kind: String,
    pub operation_id: OperationId,
    pub surface_generation: RuntimeSurfaceGeneration,
    pub tab_id: RuntimeTabId,
    pub window_generation: RuntimeWindowGeneration,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeOperationPhase {
    Pending,
    Completed,
    Failed,
    Cancelled,
    Indeterminate,
}

impl RuntimeOperationPhase {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOperationRecord {
    pub attempt_id: Option<LaunchAttemptId>,
    pub kind: String,
    pub operation_id: OperationId,
    pub phase: RuntimeOperationPhase,
    pub surface_generation: RuntimeSurfaceGeneration,
    pub tab_id: Option<RuntimeTabId>,
    pub terminal_code: Option<String>,
    pub window_generation: RuntimeWindowGeneration,
    #[serde(default)]
    pub window_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSurfaceLifecycle {
    Desired,
    Attached,
    Ready,
    Closing,
    Failed,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogicalSurfaceRecord {
    pub attempt_id: LaunchAttemptId,
    pub lifecycle: RuntimeSurfaceLifecycle,
    pub operation_id: OperationId,
    pub surface_generation: RuntimeSurfaceGeneration,
    pub tab_id: RuntimeTabId,
    pub window_generation: RuntimeWindowGeneration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTabTombstone {
    pub operation_id: OperationId,
    pub revision: u64,
    pub surface_generation: RuntimeSurfaceGeneration,
    pub tab_id: RuntimeTabId,
    pub window_generation: RuntimeWindowGeneration,
    pub window_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeDesiredEffect {
    ActivateTab {
        activation_attempt_id: OperationId,
        tab_id: RuntimeTabId,
        window_id: String,
    },
    TeardownTab {
        operation_id: OperationId,
        tab_id: RuntimeTabId,
        window_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTerminalEvent {
    pub operation_id: OperationId,
    pub phase: RuntimeOperationPhase,
    pub terminal_code: Option<String>,
}
