use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::Instant,
};

use rion_core::MacroRunStatus;
use serde::Deserialize;

const MAX_PENDING_TRACES: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MacroBadgeTimingPhase {
    AnimationStart,
    WebviewResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroBadgeTimingObservation {
    pub animation_delay_ms: Option<i32>,
    pub animation_duration_ms: Option<u32>,
    pub animation_elapsed_ms: Option<u32>,
    pub client_monotonic_ms: u64,
    pub iteration: u32,
    pub macro_id: String,
    pub phase: MacroBadgeTimingPhase,
    pub refresh_round_trip_ms: u32,
    pub response_to_animation_ms: Option<u32>,
    pub started_at: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RunKey {
    macro_id: String,
    role_id: String,
    started_at: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TraceKey {
    iteration: u32,
    run: RunKey,
}

#[derive(Clone, Debug)]
pub(super) struct MacroBadgeTimingTrace {
    pub(super) iteration: u32,
    pub(super) macro_id: String,
    pub(super) role_id: String,
    pub(super) started_at: String,
    pub(super) status_updated_at: String,
    pub(super) status_observed_at: Instant,
}

impl MacroBadgeTimingTrace {
    pub(super) fn trace_id(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.role_id, self.macro_id, self.started_at, self.iteration
        )
    }
}

impl MacroBadgeTimingObservation {
    pub(super) fn is_valid(&self) -> bool {
        if self.macro_id.is_empty()
            || self.macro_id.len() > 128
            || !self.macro_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            || self.iteration == 0
            || self.started_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&self.started_at).is_err()
            || self.refresh_round_trip_ms > 60_000
        {
            return false;
        }
        let durations_are_bounded = [
            self.animation_duration_ms,
            self.animation_elapsed_ms,
            self.response_to_animation_ms,
        ]
        .into_iter()
        .flatten()
        .all(|value| value <= 60_000);
        let delay_is_bounded = self
            .animation_delay_ms
            .is_none_or(|value| (-60_000..=60_000).contains(&value));
        durations_are_bounded && delay_is_bounded
    }
}

#[derive(Default)]
pub(super) struct MacroBadgeTimingTracker {
    latest_iterations: HashMap<RunKey, u32>,
    pending_order: VecDeque<TraceKey>,
    pending_traces: HashMap<TraceKey, MacroBadgeTimingTrace>,
}

impl MacroBadgeTimingTracker {
    pub(super) fn observe_statuses(
        &mut self,
        statuses: &[MacroRunStatus],
        observed_at: Instant,
    ) -> Vec<MacroBadgeTimingTrace> {
        let active_runs = statuses
            .iter()
            .filter(is_active)
            .map(run_key)
            .collect::<HashSet<_>>();
        self.latest_iterations
            .retain(|run, _| active_runs.contains(run));

        let mut traces = Vec::new();
        for status in statuses.iter().filter(is_active) {
            let iteration = status.iteration.unwrap_or_default();
            let run = run_key(status);
            let previous = self.latest_iterations.insert(run.clone(), iteration);
            if iteration == 0 || previous.is_some_and(|previous| iteration <= previous) {
                continue;
            }

            let trace = MacroBadgeTimingTrace {
                iteration,
                macro_id: status.macro_id.clone(),
                role_id: status.role_id.clone(),
                started_at: status.started_at.clone(),
                status_updated_at: status.updated_at.clone(),
                status_observed_at: observed_at,
            };
            self.insert_pending(trace.clone());
            traces.push(trace);
        }
        traces
    }

    pub(super) fn take_refreshes(&mut self, role_ids: &[String]) -> Vec<MacroBadgeTimingTrace> {
        let refresh_all = role_ids.is_empty();
        let mut traces = Vec::new();
        let pending = std::mem::take(&mut self.pending_order);
        for key in pending {
            let Some(trace) = self.pending_traces.remove(&key) else {
                continue;
            };
            if refresh_all || role_ids.iter().any(|role_id| role_id == &trace.role_id) {
                traces.push(trace);
            } else {
                self.pending_order.push_back(key.clone());
                self.pending_traces.insert(key, trace);
            }
        }
        traces
    }

    fn insert_pending(&mut self, trace: MacroBadgeTimingTrace) {
        let key = TraceKey {
            iteration: trace.iteration,
            run: RunKey {
                macro_id: trace.macro_id.clone(),
                role_id: trace.role_id.clone(),
                started_at: trace.started_at.clone(),
            },
        };
        if self.pending_traces.contains_key(&key) {
            return;
        }
        while self.pending_order.len() >= MAX_PENDING_TRACES {
            if let Some(expired) = self.pending_order.pop_front() {
                self.pending_traces.remove(&expired);
            }
        }
        self.pending_order.push_back(key.clone());
        self.pending_traces.insert(key, trace);
    }
}

fn is_active(status: &&MacroRunStatus) -> bool {
    matches!(status.state.as_str(), "running" | "recovering")
}

fn run_key(status: &MacroRunStatus) -> RunKey {
    RunKey {
        macro_id: status.macro_id.clone(),
        role_id: status.role_id.clone(),
        started_at: status.started_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use rion_core::MacroRunStatus;

    use super::MacroBadgeTimingTracker;

    fn status(iteration: u32, started_at: &str) -> MacroRunStatus {
        MacroRunStatus {
            error: None,
            iteration: Some(iteration),
            last_click: None,
            macro_id: "macro-a".to_owned(),
            role_id: "role-a".to_owned(),
            started_at: started_at.to_owned(),
            state: "running".to_owned(),
            updated_at: "2026-08-19T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn tracks_each_iteration_once_and_consumes_the_matching_refresh() {
        let mut tracker = MacroBadgeTimingTracker::default();
        let started_at = "2026-08-19T00:00:00.000Z";
        assert!(
            tracker
                .observe_statuses(&[status(0, started_at)], Instant::now())
                .is_empty()
        );

        let traces = tracker.observe_statuses(&[status(1, started_at)], Instant::now());
        assert_eq!(traces.len(), 1);
        assert_eq!(
            traces[0].trace_id(),
            "role-a:macro-a:2026-08-19T00:00:00.000Z:1"
        );
        assert!(
            tracker
                .observe_statuses(&[status(1, started_at)], Instant::now())
                .is_empty()
        );

        assert!(tracker.take_refreshes(&["role-b".to_owned()]).is_empty());
        let refreshed = tracker.take_refreshes(&["role-a".to_owned()]);
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].iteration, 1);
    }
}
