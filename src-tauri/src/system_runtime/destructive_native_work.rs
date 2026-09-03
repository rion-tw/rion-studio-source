use std::{
    collections::HashMap,
    sync::{Condvar, Mutex, MutexGuard, mpsc},
    time::Instant,
};

use rion_core::{CoreEffectCancellationRecord, CoreEffectResult};

use super::{RuntimeError, RuntimeResult};

// A System WebView clear has no trustworthy native interruption receipt. This registry makes
// shutdown admission and clear admission one mutex-serialized decision, then keeps shutdown
// event-bound until every clear that crossed the destructive boundary has finished native cleanup.

pub(super) const BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED: &str =
    "SYSTEM_BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED";
pub(super) const MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS: usize = 4_096;

#[derive(Clone, Debug)]
pub(super) enum DestructiveNativeWorkQueue {
    Accepted,
    CapacityExceeded,
    Draining,
    Duplicate,
    IdentityConflict,
    Replay(CoreEffectResult),
}

impl PartialEq for DestructiveNativeWorkQueue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Accepted, Self::Accepted)
            | (Self::CapacityExceeded, Self::CapacityExceeded)
            | (Self::Draining, Self::Draining)
            | (Self::Duplicate, Self::Duplicate)
            | (Self::IdentityConflict, Self::IdentityConflict) => true,
            (Self::Replay(left), Self::Replay(right)) => {
                left.effect_id == right.effect_id
                    && left.operation_id == right.operation_id
                    && left.ok == right.ok
                    && left.value_json == right.value_json
                    && left.error == right.error
            }
            _ => false,
        }
    }
}

impl Eq for DestructiveNativeWorkQueue {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DestructiveNativeWorkCancellation {
    Active,
    OperationMismatch,
    Queued,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DestructiveNativeSubmission {
    Admitted,
    Cancelled,
    Draining,
    IdentityMismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DestructiveNativeDrain {
    pub(super) native_work_drained: bool,
    pub(super) starts_shutdown: bool,
}

#[derive(Debug)]
pub(super) enum DestructiveNativeWorkBegin<'a> {
    AlreadyStarted,
    Cancelled,
    Draining,
    IdentityMismatch,
    Started(DestructiveNativeWorkPermit<'a>),
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DestructiveNativeWorkPhase {
    NativeOwnerAdmitted,
    NativeTerminalUnverified,
    NativeSubmitted,
    Preparing,
    Queued,
}

#[derive(Debug)]
struct DestructiveNativeWorkEntry {
    cancelled: bool,
    content_fingerprint: String,
    operation_id: String,
    phase: DestructiveNativeWorkPhase,
}

#[derive(Debug)]
struct DestructiveNativeWorkTerminal {
    content_fingerprint: String,
    operation_id: String,
    result: CoreEffectResult,
}

#[derive(Debug)]
struct DestructiveNativeWorkTombstone {
    content_fingerprint: String,
    operation_id: String,
}

#[derive(Debug, Default)]
struct DestructiveNativeWorkState {
    capacity_exhausted: bool,
    draining: bool,
    entries: HashMap<String, DestructiveNativeWorkEntry>,
    outstanding_count: usize,
    terminals: HashMap<String, DestructiveNativeWorkTerminal>,
    tombstones: HashMap<String, DestructiveNativeWorkTombstone>,
}

#[derive(Debug, Default)]
pub(super) struct DestructiveNativeWorkRegistry {
    changed: Condvar,
    state: Mutex<DestructiveNativeWorkState>,
}

#[derive(Debug)]
pub(super) struct DestructiveNativeWorkPermit<'a> {
    effect_id: String,
    operation_id: String,
    registry: &'a DestructiveNativeWorkRegistry,
}

impl DestructiveNativeWorkRegistry {
    fn state(&self) -> MutexGuard<'_, DestructiveNativeWorkState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn queue(
        &self,
        effect_id: &str,
        operation_id: &str,
        content_fingerprint: &str,
    ) -> DestructiveNativeWorkQueue {
        let mut state = self.state();
        if let Some(existing) = state.entries.get(effect_id) {
            return if existing.operation_id == operation_id
                && existing.content_fingerprint == content_fingerprint
            {
                DestructiveNativeWorkQueue::Duplicate
            } else {
                DestructiveNativeWorkQueue::IdentityConflict
            };
        }
        if let Some(existing) = state.terminals.get(effect_id) {
            return if existing.operation_id == operation_id
                && existing.content_fingerprint == content_fingerprint
            {
                DestructiveNativeWorkQueue::Replay(existing.result.clone())
            } else {
                DestructiveNativeWorkQueue::IdentityConflict
            };
        }
        if let Some(existing) = state.tombstones.get(effect_id) {
            return if existing.operation_id == operation_id
                && existing.content_fingerprint == content_fingerprint
            {
                DestructiveNativeWorkQueue::Duplicate
            } else {
                DestructiveNativeWorkQueue::IdentityConflict
            };
        }
        if state.draining {
            return DestructiveNativeWorkQueue::Draining;
        }
        // An active identity reserves its terminal replay slot at admission. Capacity failure is
        // safer than evicting an older destructive identity and making its mutation repeatable in
        // the same live adapter process.
        if state.capacity_exhausted
            || Self::retained_identity_count_in(&state)
                >= MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS
        {
            // A rejected destructive identity cannot be recorded once the bounded ledger is full.
            // Latch admission closed for the process lifetime so freeing a slot in a future
            // refactor cannot make that previously rejected envelope executable on replay.
            state.capacity_exhausted = true;
            return DestructiveNativeWorkQueue::CapacityExceeded;
        }
        state.entries.insert(
            effect_id.to_owned(),
            DestructiveNativeWorkEntry {
                cancelled: false,
                content_fingerprint: content_fingerprint.to_owned(),
                operation_id: operation_id.to_owned(),
                phase: DestructiveNativeWorkPhase::Queued,
            },
        );
        state.outstanding_count = state.outstanding_count.saturating_add(1);
        DestructiveNativeWorkQueue::Accepted
    }

    fn remember_terminal(
        state: &mut DestructiveNativeWorkState,
        effect_id: String,
        operation_id: String,
        content_fingerprint: String,
        result: CoreEffectResult,
    ) {
        state.terminals.insert(
            effect_id,
            DestructiveNativeWorkTerminal {
                content_fingerprint,
                operation_id,
                result,
            },
        );
        debug_assert!(
            Self::retained_identity_count_in(state)
                <= MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS
        );
    }

    fn remember_tombstone(
        state: &mut DestructiveNativeWorkState,
        effect_id: String,
        entry: DestructiveNativeWorkEntry,
    ) {
        state.tombstones.insert(
            effect_id,
            DestructiveNativeWorkTombstone {
                content_fingerprint: entry.content_fingerprint,
                operation_id: entry.operation_id,
            },
        );
        debug_assert!(
            Self::retained_identity_count_in(state)
                <= MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS
        );
    }

    fn retained_identity_count_in(state: &DestructiveNativeWorkState) -> usize {
        state
            .entries
            .len()
            .saturating_add(state.terminals.len())
            .saturating_add(state.tombstones.len())
    }

    #[cfg(test)]
    pub(super) fn retained_terminal_count(&self) -> usize {
        self.state().terminals.len()
    }

    #[cfg(test)]
    pub(super) fn retained_identity_count(&self) -> usize {
        Self::retained_identity_count_in(&self.state())
    }

    pub(super) fn complete_queued_from_effect_result(&self, result: &CoreEffectResult) -> bool {
        if !is_exact_destructive_failure(result) {
            return false;
        }
        let mut state = self.state();
        let Some(entry) = state.entries.get(&result.effect_id) else {
            return false;
        };
        if entry.operation_id != result.operation_id
            || entry.phase != DestructiveNativeWorkPhase::Queued
        {
            return false;
        }
        let entry = state
            .entries
            .remove(&result.effect_id)
            .expect("the exact queued destructive native work entry was just validated");
        state.outstanding_count = state.outstanding_count.saturating_sub(1);
        Self::remember_terminal(
            &mut state,
            result.effect_id.clone(),
            entry.operation_id,
            entry.content_fingerprint,
            result.clone(),
        );
        self.changed.notify_all();
        true
    }

    pub(super) fn cancel(
        &self,
        cancellation: &CoreEffectCancellationRecord,
    ) -> DestructiveNativeWorkCancellation {
        let mut state = self.state();
        let Some(entry) = state.entries.get_mut(&cancellation.effect_id) else {
            return DestructiveNativeWorkCancellation::Unknown;
        };
        if entry.operation_id != cancellation.operation_id {
            return DestructiveNativeWorkCancellation::OperationMismatch;
        }
        entry.cancelled = true;
        match entry.phase {
            DestructiveNativeWorkPhase::NativeSubmitted
            | DestructiveNativeWorkPhase::NativeOwnerAdmitted
            | DestructiveNativeWorkPhase::NativeTerminalUnverified
            | DestructiveNativeWorkPhase::Preparing => DestructiveNativeWorkCancellation::Active,
            DestructiveNativeWorkPhase::Queued => DestructiveNativeWorkCancellation::Queued,
        }
    }

    pub(super) fn begin(
        &self,
        effect_id: &str,
        operation_id: &str,
        content_fingerprint: &str,
    ) -> DestructiveNativeWorkBegin<'_> {
        let mut state = self.state();
        let Some(entry) = state.entries.get(effect_id) else {
            return DestructiveNativeWorkBegin::Unknown;
        };
        if entry.operation_id != operation_id || entry.content_fingerprint != content_fingerprint {
            return DestructiveNativeWorkBegin::IdentityMismatch;
        }
        if entry.phase != DestructiveNativeWorkPhase::Queued {
            return DestructiveNativeWorkBegin::AlreadyStarted;
        }
        if entry.cancelled {
            let entry = state
                .entries
                .remove(effect_id)
                .expect("the cancelled destructive native work entry was just validated");
            state.outstanding_count = state.outstanding_count.saturating_sub(1);
            Self::remember_tombstone(&mut state, effect_id.to_owned(), entry);
            self.changed.notify_all();
            return DestructiveNativeWorkBegin::Cancelled;
        }
        if state.draining {
            // The caller must retain and dispatch its exact shutdown failure before this queued
            // identity stops contributing to the native drain. If the caller disappears first,
            // shutdown remains fail-closed instead of silently losing pending Core work.
            return DestructiveNativeWorkBegin::Draining;
        }
        let entry = state
            .entries
            .get_mut(effect_id)
            .expect("the destructive native work entry was just validated");
        entry.phase = DestructiveNativeWorkPhase::Preparing;
        DestructiveNativeWorkBegin::Started(DestructiveNativeWorkPermit {
            effect_id: effect_id.to_owned(),
            operation_id: operation_id.to_owned(),
            registry: self,
        })
    }

    pub(super) fn admit_native_submission(
        &self,
        effect_id: &str,
        operation_id: &str,
    ) -> DestructiveNativeSubmission {
        let mut state = self.state();
        let Some(entry) = state.entries.get(effect_id) else {
            return DestructiveNativeSubmission::IdentityMismatch;
        };
        if entry.operation_id != operation_id
            || entry.phase != DestructiveNativeWorkPhase::Preparing
        {
            return DestructiveNativeSubmission::IdentityMismatch;
        }
        if entry.cancelled {
            return DestructiveNativeSubmission::Cancelled;
        }
        if state.draining {
            return DestructiveNativeSubmission::Draining;
        }
        state
            .entries
            .get_mut(effect_id)
            .expect("the destructive native work entry was just validated")
            .phase = DestructiveNativeWorkPhase::NativeOwnerAdmitted;
        DestructiveNativeSubmission::Admitted
    }

    pub(super) fn admit_destructive_mutation(
        &self,
        effect_id: &str,
        operation_id: &str,
    ) -> DestructiveNativeSubmission {
        let mut state = self.state();
        let Some(entry) = state.entries.get(effect_id) else {
            return DestructiveNativeSubmission::IdentityMismatch;
        };
        if entry.operation_id != operation_id
            || entry.phase != DestructiveNativeWorkPhase::NativeOwnerAdmitted
        {
            return DestructiveNativeSubmission::IdentityMismatch;
        }
        if entry.cancelled {
            return DestructiveNativeSubmission::Cancelled;
        }
        if state.draining {
            return DestructiveNativeSubmission::Draining;
        }
        state
            .entries
            .get_mut(effect_id)
            .expect("the destructive native work entry was just validated")
            .phase = DestructiveNativeWorkPhase::NativeSubmitted;
        DestructiveNativeSubmission::Admitted
    }

    pub(super) fn tombstone_core_terminal(&self, effect_id: &str, operation_id: &str) {
        let mut state = self.state();
        if state.entries.get(effect_id).is_some_and(|entry| {
            entry.operation_id == operation_id && entry.phase == DestructiveNativeWorkPhase::Queued
        }) {
            let entry = state
                .entries
                .remove(effect_id)
                .expect("the discarded destructive native work entry was just validated");
            state.outstanding_count = state.outstanding_count.saturating_sub(1);
            Self::remember_tombstone(&mut state, effect_id.to_owned(), entry);
            self.changed.notify_all();
        }
    }

    pub(super) fn begin_shutdown_and_wait(
        &self,
        deadline: Instant,
        begin_shutdown: impl FnOnce() -> bool,
    ) -> DestructiveNativeDrain {
        let mut state = self.state();
        let starts_shutdown = if state.draining {
            false
        } else {
            state.draining = true;
            begin_shutdown()
        };
        while state.outstanding_count > 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (next_state, wait) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next_state;
            if wait.timed_out() && state.outstanding_count > 0 {
                break;
            }
        }
        DestructiveNativeDrain {
            native_work_drained: state.outstanding_count == 0,
            starts_shutdown,
        }
    }
}

impl DestructiveNativeWorkPermit<'_> {
    pub(super) fn complete_from_effect_result(&mut self, result: &CoreEffectResult) {
        if result.effect_id != self.effect_id || result.operation_id != self.operation_id {
            return;
        }

        let mut state = self.registry.state();
        let Some(entry) = state.entries.get(&self.effect_id) else {
            return;
        };
        if entry.operation_id != self.operation_id
            || !matches!(
                entry.phase,
                DestructiveNativeWorkPhase::Preparing
                    | DestructiveNativeWorkPhase::NativeOwnerAdmitted
                    | DestructiveNativeWorkPhase::NativeSubmitted
            )
        {
            return;
        }
        if result.ok {
            if entry.phase != DestructiveNativeWorkPhase::NativeSubmitted {
                return;
            }
        } else if !is_exact_destructive_failure(result) {
            return;
        }
        let entry = state
            .entries
            .remove(&self.effect_id)
            .expect("the exact destructive native work entry was just validated");
        state.outstanding_count = state.outstanding_count.saturating_sub(1);
        DestructiveNativeWorkRegistry::remember_terminal(
            &mut state,
            self.effect_id.clone(),
            entry.operation_id,
            entry.content_fingerprint,
            result.clone(),
        );
        self.registry.changed.notify_all();
    }
}

fn is_exact_destructive_failure(result: &CoreEffectResult) -> bool {
    !result.ok
        && result
            .error
            .as_ref()
            .is_some_and(|error| error.code != BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED)
}

impl Drop for DestructiveNativeWorkPermit<'_> {
    fn drop(&mut self) {
        let mut state = self.registry.state();
        let Some(entry) = state.entries.get(&self.effect_id) else {
            return;
        };
        if entry.operation_id != self.operation_id {
            return;
        }
        match entry.phase {
            DestructiveNativeWorkPhase::Preparing => {
                // Core execution normally records an exact result before this permit drops. If
                // unwinding or an executor failure prevents that result, preserve a non-executable
                // identity receipt rather than making the destructive envelope fresh again.
                let entry = state
                    .entries
                    .remove(&self.effect_id)
                    .expect("the preparing destructive native work entry was just validated");
                state.outstanding_count = state.outstanding_count.saturating_sub(1);
                DestructiveNativeWorkRegistry::remember_tombstone(
                    &mut state,
                    self.effect_id.clone(),
                    entry,
                );
            }
            DestructiveNativeWorkPhase::NativeSubmitted => {
                // Dropping the owner after native submission without an exact callback plus
                // utility-window release fence is not a terminal event. Keep the work outstanding
                // so shutdown reaches its declared deadline and exits without unlocking Core.
                state
                    .entries
                    .get_mut(&self.effect_id)
                    .expect("the submitted destructive native work entry was just validated")
                    .phase = DestructiveNativeWorkPhase::NativeTerminalUnverified;
            }
            DestructiveNativeWorkPhase::NativeOwnerAdmitted => {
                // The utility WebView may already own the role store even though the clear call
                // has not started. Only its exact destroyed event and post-loop barrier prove
                // that rollback or Core unlock is safe.
                state
                    .entries
                    .get_mut(&self.effect_id)
                    .expect("the admitted destructive native work entry was just validated")
                    .phase = DestructiveNativeWorkPhase::NativeTerminalUnverified;
            }
            DestructiveNativeWorkPhase::NativeTerminalUnverified
            | DestructiveNativeWorkPhase::Queued => {}
        }
        self.registry.changed.notify_all();
    }
}

pub(super) fn role_browser_data_clear_fingerprint(
    role_id: &str,
    webview2_user_data_dir: &str,
    webkit_data_store_identifier: &str,
) -> String {
    // Length-prefix every value so distinct destructive targets cannot alias through delimiters.
    format!(
        "role-browser-data-clear:v1:{}:{role_id}:{}:{webview2_user_data_dir}:{}:{webkit_data_store_identifier}",
        role_id.len(),
        webview2_user_data_dir.len(),
        webkit_data_store_identifier.len(),
    )
}

pub(super) fn await_event_bound_native_terminal(
    submit: impl FnOnce(mpsc::SyncSender<RuntimeResult<()>>) -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    let (terminal_sender, terminal_receiver) = mpsc::sync_channel(1);
    submit(terminal_sender)?;
    terminal_receiver.recv().map_err(|_| {
        RuntimeError::new(
            BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED,
            "The native browser-data clear completion stream closed without a terminal event.",
        )
    })?
}

pub(super) fn await_utility_surface_release(
    destroyed_receiver: mpsc::Receiver<()>,
    request_destroy: impl FnOnce() -> RuntimeResult<()>,
    enqueue_post_destroy_barrier: impl FnOnce(mpsc::SyncSender<()>) -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    request_destroy().map_err(|error| {
        RuntimeError::new(
            BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED,
            format!(
                "The utility window destruction request did not reach an exact terminal: {}",
                error.message
            ),
        )
    })?;
    destroyed_receiver.recv().map_err(|_| {
        RuntimeError::new(
            BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED,
            "The utility window closed without its authoritative destroyed event.",
        )
    })?;
    let (released_sender, released_receiver) = mpsc::sync_channel(1);
    enqueue_post_destroy_barrier(released_sender).map_err(|error| {
        RuntimeError::new(
            BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED,
            format!(
                "The utility WebView release barrier could not be submitted: {}",
                error.message
            ),
        )
    })?;
    released_receiver.recv().map_err(|_| {
        RuntimeError::new(
            BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED,
            "The utility WebView release barrier closed without a terminal event.",
        )
    })
}

impl super::SystemRuntimeExecutor {
    pub(crate) fn consume_core_effect_cancellations(
        &self,
        cancellations: &[CoreEffectCancellationRecord],
    ) -> usize {
        cancellations
            .iter()
            .filter(|cancellation| {
                self.destructive_native_work.cancel(cancellation)
                    == DestructiveNativeWorkCancellation::OperationMismatch
            })
            .count()
    }
}
