//! Debug-only desktop E2E control plane.
//!
//! This module is deliberately outside the product bridge. It is compiled only
//! for the `desktop-e2e` feature and refuses to compile in release profiles.

#[cfg(not(debug_assertions))]
compile_error!("the desktop-e2e feature is restricted to debug builds");

use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

const EVENT_CAPACITY: usize = 4_096;
const MAX_WAIT_MS: u64 = 60_000;
const SESSION_TOKEN_ENV: &str = "RION_STUDIO_E2E_SESSION_TOKEN";

static CONTROL: OnceLock<Arc<DesktopE2eControl>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopE2eWaitRequest {
    pub after_sequence: u64,
    pub kind: Option<String>,
    pub minimum_generation: Option<u64>,
    pub minimum_revision: Option<u64>,
    pub presentation: Option<String>,
    pub timeout_ms: u64,
    pub window_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopE2eEvent {
    pub details: Value,
    pub generation: Option<u64>,
    pub kind: String,
    pub revision: Option<u64>,
    pub sequence: u64,
    pub timestamp: String,
    pub window_id: Option<String>,
}

#[derive(Debug)]
struct DesktopE2eEventState {
    events: VecDeque<DesktopE2eEvent>,
    next_sequence: u64,
    transcript: File,
}

pub(crate) struct DesktopE2eControl {
    accepted_close_labels: Mutex<HashSet<String>>,
    changed: Condvar,
    event_state: Mutex<DesktopE2eEventState>,
    session_id: String,
    token: String,
    transcript_path: PathBuf,
    user_data_dir: PathBuf,
}

impl DesktopE2eControl {
    fn authenticate(&self, provided: &str) -> Result<(), String> {
        let expected = self.token.as_bytes();
        let provided = provided.as_bytes();
        if expected.len() != provided.len() {
            return Err("The desktop E2E session token is invalid.".to_owned());
        }
        let mismatch = expected
            .iter()
            .zip(provided)
            .fold(0_u8, |value, (left, right)| value | (left ^ right));
        if mismatch == 0 {
            Ok(())
        } else {
            Err("The desktop E2E session token is invalid.".to_owned())
        }
    }

    fn probe(&self) -> Value {
        let latest_sequence = self
            .event_state
            .lock()
            .map(|state| state.next_sequence.saturating_sub(1))
            .unwrap_or_default();
        json!({
            "latestSequence": latest_sequence,
            "pid": std::process::id(),
            "sessionId": self.session_id,
            "transcriptPath": self.transcript_path,
            "userDataDir": self.user_data_dir,
        })
    }

    fn record(
        &self,
        kind: &str,
        window_id: Option<&str>,
        generation: Option<u64>,
        revision: Option<u64>,
        details: Value,
    ) -> DesktopE2eEvent {
        let mut state = self
            .event_state
            .lock()
            .expect("desktop E2E event state poisoned");
        let event = DesktopE2eEvent {
            details,
            generation,
            kind: kind.to_owned(),
            revision,
            sequence: state.next_sequence,
            timestamp: chrono::Utc::now().to_rfc3339(),
            window_id: window_id.map(str::to_owned),
        };
        state.next_sequence = state.next_sequence.saturating_add(1).max(1);
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(state.transcript, "{line}");
            let _ = state.transcript.flush();
        }
        state.events.push_back(event.clone());
        while state.events.len() > EVENT_CAPACITY {
            state.events.pop_front();
        }
        drop(state);
        self.changed.notify_all();
        event
    }

    fn wait_for_event(&self, request: &DesktopE2eWaitRequest) -> Result<DesktopE2eEvent, String> {
        if request.timeout_ms == 0 || request.timeout_ms > MAX_WAIT_MS {
            return Err(format!(
                "desktop E2E event waits require timeoutMs between 1 and {MAX_WAIT_MS}"
            ));
        }
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let mut state = self
            .event_state
            .lock()
            .map_err(|_| "The desktop E2E event state is unavailable.".to_owned())?;
        loop {
            if let Some(event) = state
                .events
                .iter()
                .find(|event| event_matches(event, request))
            {
                return Ok(event.clone());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "Timed out waiting for desktop E2E event after sequence {}.",
                    request.after_sequence
                ));
            }
            let (next_state, wait) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "The desktop E2E event wait was interrupted.".to_owned())?;
            state = next_state;
            if wait.timed_out()
                && state
                    .events
                    .iter()
                    .all(|event| !event_matches(event, request))
            {
                return Err(format!(
                    "Timed out waiting for desktop E2E event after sequence {}.",
                    request.after_sequence
                ));
            }
        }
    }
}

fn event_matches(event: &DesktopE2eEvent, request: &DesktopE2eWaitRequest) -> bool {
    event.sequence > request.after_sequence
        && request
            .kind
            .as_deref()
            .is_none_or(|kind| event.kind == kind)
        && request
            .window_id
            .as_deref()
            .is_none_or(|window_id| event.window_id.as_deref() == Some(window_id))
        && request
            .minimum_generation
            .is_none_or(|minimum| event.generation.is_some_and(|value| value >= minimum))
        && request
            .minimum_revision
            .is_none_or(|minimum| event.revision.is_some_and(|value| value >= minimum))
        && request.presentation.as_deref().is_none_or(|presentation| {
            event.details.get("presentation").and_then(Value::as_str) == Some(presentation)
        })
}

pub(crate) fn initialize(user_data_dir: &Path) -> Result<Arc<DesktopE2eControl>, String> {
    if let Some(control) = CONTROL.get() {
        return Ok(Arc::clone(control));
    }
    let token = std::env::var(SESSION_TOKEN_ENV)
        .map_err(|_| format!("{SESSION_TOKEN_ENV} is required for desktop E2E builds."))?;
    if token.len() < 32 || token.chars().any(char::is_whitespace) {
        return Err(format!(
            "{SESSION_TOKEN_ENV} must contain at least 32 non-whitespace characters."
        ));
    }
    let configured_dir = std::env::var_os("RION_STUDIO_USER_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "RION_STUDIO_USER_DATA_DIR is required for desktop E2E builds.".to_owned()
        })?;
    if !configured_dir.is_absolute() || configured_dir != user_data_dir {
        return Err(
            "The desktop E2E build requires its exact absolute isolated user data directory."
                .to_owned(),
        );
    }
    let artifact_dir = user_data_dir.join("desktop-e2e");
    fs::create_dir_all(&artifact_dir)
        .map_err(|error| format!("Desktop E2E artifact directory failed: {error}"))?;
    let transcript_path = artifact_dir.join("events.ndjson");
    let transcript = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&transcript_path)
        .map_err(|error| format!("Desktop E2E event transcript failed: {error}"))?;
    let session_id = format!("{:x}", Sha256::digest(token.as_bytes()))[..16].to_owned();
    let control = Arc::new(DesktopE2eControl {
        accepted_close_labels: Mutex::new(HashSet::new()),
        changed: Condvar::new(),
        event_state: Mutex::new(DesktopE2eEventState {
            events: VecDeque::new(),
            next_sequence: 1,
            transcript,
        }),
        session_id,
        token,
        transcript_path,
        user_data_dir: user_data_dir.to_owned(),
    });
    CONTROL
        .set(Arc::clone(&control))
        .map_err(|_| "The desktop E2E control plane was initialized twice.".to_owned())?;
    Ok(control)
}

pub(crate) fn permit_close_confirmation_once(label: &str) {
    if let Some(control) = CONTROL.get()
        && let Ok(mut labels) = control.accepted_close_labels.lock()
    {
        labels.insert(label.to_owned());
    }
}

pub(crate) fn consume_close_confirmation(label: &str) -> bool {
    CONTROL
        .get()
        .and_then(|control| control.accepted_close_labels.lock().ok())
        .is_some_and(|mut labels| labels.remove(label))
}

pub(crate) fn record_event(
    kind: &str,
    window_id: Option<&str>,
    generation: Option<u64>,
    revision: Option<u64>,
    details: Value,
) {
    if let Some(control) = CONTROL.get() {
        control.record(kind, window_id, generation, revision, details);
    }
}

#[tauri::command]
pub(crate) fn desktop_e2e_probe(
    control: State<'_, Arc<DesktopE2eControl>>,
    token: String,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    Ok(control.probe())
}

#[tauri::command]
pub(crate) async fn desktop_e2e_wait_event(
    control: State<'_, Arc<DesktopE2eControl>>,
    token: String,
    request: DesktopE2eWaitRequest,
) -> Result<DesktopE2eEvent, String> {
    control.authenticate(&token)?;
    let control = Arc::clone(control.inner());
    tauri::async_runtime::spawn_blocking(move || control.wait_for_event(&request))
        .await
        .map_err(|error| format!("Desktop E2E event task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn desktop_e2e_window_snapshot(
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
    window_id: String,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    let snapshot = state.runtime.desktop_e2e_window_snapshot(&window_id)?;
    let generation = snapshot.get("windowGeneration").and_then(Value::as_u64);
    let revision = snapshot.pointer("/kernel/revision").and_then(Value::as_u64);
    record_event(
        "window-snapshot-read",
        Some(&window_id),
        generation,
        revision,
        snapshot.clone(),
    );
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn desktop_e2e_inject_duplicate_role_cookie_checkpoint(
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
    role_id: String,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    state
        .runtime
        .desktop_e2e_inject_duplicate_role_cookie_checkpoint(&role_id)
}

#[tauri::command]
pub(crate) fn desktop_e2e_control_window(
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
    window_id: String,
    request: crate::system_runtime::DesktopE2eWindowControlRequest,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    state
        .runtime
        .desktop_e2e_control_window(&window_id, request)
}

#[tauri::command]
pub(crate) fn desktop_e2e_runtime_ui_action(
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
    window_id: String,
    request: crate::system_runtime::DesktopE2eRuntimeUiActionRequest,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    state
        .runtime
        .desktop_e2e_runtime_ui_action(&window_id, request)
}

#[tauri::command]
pub(crate) fn desktop_e2e_input_diagnostics(
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
) -> Result<Value, String> {
    control.authenticate(&token)?;
    serde_json::to_value(
        state
            .core
            .macro_input_diagnostics()
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn desktop_e2e_shutdown(
    app: AppHandle,
    control: State<'_, Arc<DesktopE2eControl>>,
    state: State<'_, crate::CoreState>,
    token: String,
    confirm: bool,
) -> Result<(), String> {
    control.authenticate(&token)?;
    record_event(
        "application-shutdown-requested",
        None,
        None,
        None,
        json!({ "confirm": confirm }),
    );
    if confirm {
        crate::confirm_application_shutdown(&app, &state);
    } else {
        crate::request_application_shutdown(&app, &state);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> DesktopE2eEvent {
        DesktopE2eEvent {
            details: Value::Null,
            generation: Some(3),
            kind: "placement-accepted".to_owned(),
            revision: Some(9),
            sequence: 12,
            timestamp: String::new(),
            window_id: Some("window-a".to_owned()),
        }
    }

    #[test]
    fn event_filter_requires_every_requested_fence() {
        let request = DesktopE2eWaitRequest {
            after_sequence: 11,
            kind: Some("placement-accepted".to_owned()),
            minimum_generation: Some(3),
            minimum_revision: Some(9),
            presentation: Some("normal".to_owned()),
            timeout_ms: 1,
            window_id: Some("window-a".to_owned()),
        };
        let matching = DesktopE2eEvent {
            details: json!({ "presentation": "normal" }),
            ..event()
        };
        assert!(event_matches(&matching, &request));
        assert!(!event_matches(
            &DesktopE2eEvent {
                revision: Some(8),
                ..event()
            },
            &request
        ));
    }
}
