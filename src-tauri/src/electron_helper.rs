use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use rion_core::{
    AppCore, CoreCommand, CoreEffectRequest, CoreEffectResult, CoreErrorPayload, CoreEvent,
    SystemWebViewRuntimeRegistrationRecord,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use uuid::Uuid;

const HELPER_PROTOCOL_VERSION: u64 = 1;
const HELPER_MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(30);
const HELPER_EFFECT_GRACE: Duration = Duration::from_secs(5);

pub const HELPER_RUNTIME_STATE_EVENT: &str = "rion://helper-runtime-state";
pub const HELPER_MACRO_PAGE_EVENT: &str = "rion://helper-macro-page-request";
pub const HELPER_WORKSPACE_LAUNCH_EVENT: &str = "rion://helper-workspace-launch-request";

pub struct ElectronHelperClient {
    inner: Arc<HelperInner>,
    registration: SystemWebViewRuntimeRegistrationRecord,
    versions: HelperVersions,
}

#[derive(Clone)]
pub struct HelperVersions {
    pub chromium: String,
    pub electron: String,
    pub node: String,
}

struct HelperInner {
    alive: AtomicBool,
    app: AppHandle,
    child: Mutex<Option<Child>>,
    core: Arc<AppCore>,
    pending_effects: Mutex<HashMap<String, mpsc::Sender<CoreEffectResult>>>,
    pending_macro_page: Mutex<Option<Value>>,
    pending_runtime_state: Mutex<Option<Value>>,
    pending_workspace_launch: Mutex<Option<Value>>,
    token: String,
    writer: Mutex<ChildStdin>,
}

impl ElectronHelperClient {
    pub fn start(
        app: AppHandle,
        core: Arc<AppCore>,
        user_data_dir: &Path,
    ) -> Result<Self, String> {
        let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
        let (mut command, working_directory) = helper_command(&app)?;
        command
            .current_dir(working_directory)
            .env("RION_RUNTIME_HELPER_TOKEN", &token)
            .env("RION_RUNTIME_HELPER_USER_DATA_DIR", user_data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start the Electron runtime helper: {error}"))?;
        let writer = child
            .stdin
            .take()
            .ok_or_else(|| "Electron runtime helper stdin is unavailable.".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Electron runtime helper stdout is unavailable.".to_owned())?;
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let inner = Arc::new(HelperInner {
            alive: AtomicBool::new(true),
            app,
            child: Mutex::new(Some(child)),
            core,
            pending_effects: Mutex::new(HashMap::new()),
            pending_macro_page: Mutex::new(None),
            pending_runtime_state: Mutex::new(None),
            pending_workspace_launch: Mutex::new(None),
            token,
            writer: Mutex::new(writer),
        });
        let reader_inner = Arc::clone(&inner);
        thread::Builder::new()
            .name("rion-electron-helper-reader".to_owned())
            .spawn(move || read_helper_messages(reader_inner, stdout, ready_sender))
            .map_err(|error| error.to_string())?;
        let ready = ready_receiver
            .recv_timeout(HELPER_READY_TIMEOUT)
            .map_err(|_| "Electron runtime helper did not become ready in time.".to_owned())??;
        Ok(Self {
            inner,
            registration: ready.registration,
            versions: ready.versions,
        })
    }

    pub fn registration(&self) -> SystemWebViewRuntimeRegistrationRecord {
        self.registration.clone()
    }

    pub fn versions(&self) -> HelperVersions {
        self.versions.clone()
    }

    pub fn execute(&self, effect: CoreEffectRequest) -> CoreEffectResult {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        if !self.inner.alive.load(Ordering::Acquire) {
            return failed_result(
                effect_id,
                operation_id,
                "TAURI_ELECTRON_HELPER_CRASHED",
                "The Electron runtime helper is not running.",
            );
        }
        let (sender, receiver) = mpsc::channel();
        if let Ok(mut pending) = self.inner.pending_effects.lock() {
            pending.insert(effect_id.clone(), sender);
        } else {
            return failed_result(
                effect_id,
                operation_id,
                "TAURI_ELECTRON_HELPER_FAILED",
                "The Electron runtime helper state is unavailable.",
            );
        }
        if let Err(error) = self.inner.send(json!({
            "type": "effect",
            "effect": effect
        })) {
            self.inner.remove_pending_effect(&effect_id);
            return failed_result(
                effect_id,
                operation_id,
                "TAURI_ELECTRON_HELPER_FAILED",
                error,
            );
        }
        let timeout = Duration::from_millis(effect.deadline_ms.max(1))
            .saturating_add(HELPER_EFFECT_GRACE);
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.inner.remove_pending_effect(&effect_id);
                failed_result(
                    effect_id,
                    operation_id,
                    "TAURI_ELECTRON_HELPER_TIMEOUT",
                    "The Electron runtime helper effect timed out.",
                )
            }
        }
    }

    pub fn forward_events(&self, events: &[CoreEvent]) {
        if !self.inner.alive.load(Ordering::Acquire) {
            return;
        }
        let forwarded = events
            .iter()
            .filter(|event| !matches!(event, CoreEvent::CoreEffects { .. }))
            .collect::<Vec<_>>();
        if !forwarded.is_empty() {
            let _ = self.inner.send(json!({
                "type": "coreEvents",
                "events": forwarded
            }));
        }
    }

    pub fn runtime_state(&self) -> Option<Value> {
        self.inner
            .pending_runtime_state
            .lock()
            .ok()
            .and_then(|state| state.clone())
    }

    pub fn take_macro_page_request(&self) -> Option<Value> {
        self.inner
            .pending_macro_page
            .lock()
            .ok()
            .and_then(|mut request| request.take())
    }

    pub fn take_workspace_launch_request(&self) -> Option<Value> {
        self.inner
            .pending_workspace_launch
            .lock()
            .ok()
            .and_then(|mut request| request.take())
    }

    pub fn close(&self) {
        if self.inner.alive.swap(false, Ordering::AcqRel) {
            let _ = self.inner.send(json!({ "type": "shutdown" }));
        }
        if let Ok(mut child) = self.inner.child.lock()
            && let Some(mut child) = child.take()
        {
            for _ in 0..20 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ElectronHelperClient {
    fn drop(&mut self) {
        self.close();
    }
}

impl HelperInner {
    fn send(&self, body: Value) -> Result<(), String> {
        let mut message = body;
        let object = message
            .as_object_mut()
            .ok_or_else(|| "Runtime helper protocol message must be an object.".to_owned())?;
        object.insert("protocol".to_owned(), HELPER_PROTOCOL_VERSION.into());
        object.insert("token".to_owned(), self.token.clone().into());
        let encoded = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        if encoded.len() > HELPER_MAX_MESSAGE_BYTES {
            return Err("Runtime helper protocol message is too large.".to_owned());
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Runtime helper writer lock poisoned.".to_owned())?;
        writer.write_all(&encoded).map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn remove_pending_effect(&self, effect_id: &str) {
        if let Ok(mut pending) = self.pending_effects.lock() {
            pending.remove(effect_id);
        }
    }

    fn fail_all(&self, message: &str) {
        self.alive.store(false, Ordering::Release);
        let pending = self
            .pending_effects
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for (effect_id, sender) in pending {
            let _ = sender.send(failed_result(
                effect_id,
                String::new(),
                "TAURI_ELECTRON_HELPER_CRASHED",
                message,
            ));
        }
    }
}

fn read_helper_messages(
    inner: Arc<HelperInner>,
    stdout: impl std::io::Read,
    ready_sender: mpsc::SyncSender<Result<HelperReady, String>>,
) {
    let mut ready_sender = Some(ready_sender);
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                inner.fail_all("The Electron runtime helper exited.");
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(Err("The Electron runtime helper exited.".to_owned()));
                }
                return;
            }
            Ok(_) => {}
            Err(error) => {
                inner.fail_all(&error.to_string());
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(Err(error.to_string()));
                }
                return;
            }
        }
        if line.len() > HELPER_MAX_MESSAGE_BYTES {
            inner.fail_all("The Electron runtime helper sent an oversized message.");
            return;
        }
        let message = match serde_json::from_str::<Value>(&line) {
            Ok(message) => message,
            Err(error) => {
                inner.fail_all(&format!("Invalid Electron helper message: {error}"));
                return;
            }
        };
        if message["protocol"].as_u64() != Some(HELPER_PROTOCOL_VERSION)
            || message["token"].as_str() != Some(inner.token.as_str())
        {
            inner.fail_all("Electron runtime helper authentication failed.");
            return;
        }
        match message["type"].as_str() {
            Some("ready") => {
                let result = (|| {
                    let registration = serde_json::from_value(message["registration"].clone())
                        .map_err(|error| error.to_string())?;
                    let versions = HelperVersions {
                        chromium: required_string(&message, "/versions/chromium")?,
                        electron: required_string(&message, "/versions/electron")?,
                        node: required_string(&message, "/versions/node")?,
                    };
                    Ok(HelperReady {
                        registration,
                        versions,
                    })
                })();
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(result);
                }
            }
            Some("effectResult") => {
                if let Ok(result) =
                    serde_json::from_value::<CoreEffectResult>(message["result"].clone())
                    && let Ok(mut pending) = inner.pending_effects.lock()
                    && let Some(sender) = pending.remove(&result.effect_id)
                {
                    let _ = sender.send(result);
                }
            }
            Some("coreInvoke") => {
                let request_id = message["requestId"].as_str().unwrap_or_default().to_owned();
                let command = serde_json::from_value::<CoreCommand>(message["command"].clone());
                let result = command
                    .map_err(|error| CoreErrorPayload {
                        code: "HELPER_CORE_INPUT_INVALID".to_owned(),
                        message: error.to_string(),
                    })
                    .and_then(|command| invoke_helper_core(&inner.core, command));
                let response = match result {
                    Ok(value) => json!({
                        "type": "coreInvokeResult",
                        "requestId": request_id,
                        "ok": true,
                        "value": value
                    }),
                    Err(error) => json!({
                        "type": "coreInvokeResult",
                        "requestId": request_id,
                        "ok": false,
                        "error": error
                    }),
                };
                let _ = inner.send(response);
            }
            Some("shellEvent") => handle_shell_event(&inner, &message),
            Some("log") => {
                eprintln!(
                    "Electron runtime helper: {}",
                    message["message"].as_str().unwrap_or("unknown helper error")
                );
            }
            _ => {}
        }
    }
}

struct HelperReady {
    registration: SystemWebViewRuntimeRegistrationRecord,
    versions: HelperVersions,
}

fn required_string(message: &Value, pointer: &str) -> Result<String, String> {
    message
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| format!("Electron runtime helper field {pointer} is invalid."))
}

fn invoke_helper_core(core: &Arc<AppCore>, command: CoreCommand) -> Result<Value, CoreErrorPayload> {
    if !helper_command_allowed(&command) {
        return Err(CoreErrorPayload {
            code: "HELPER_CORE_COMMAND_DENIED".to_owned(),
            message: "The Electron helper requested a command outside its runtime scope.".to_owned(),
        });
    }
    let result = if command.requires_async_dispatch() {
        tauri::async_runtime::block_on(core.invoke_async(command))
    } else {
        core.invoke(command)
    };
    result.map_err(|error| error.payload())
}

fn helper_command_allowed(command: &CoreCommand) -> bool {
    matches!(
        command,
        CoreCommand::RoleGet { .. }
            | CoreCommand::RolesList
            | CoreCommand::RolePathsResolve { .. }
            | CoreCommand::WorkspacesList
            | CoreCommand::WorkspaceGet { .. }
            | CoreCommand::WorkspaceSetRoleBrowserZoom { .. }
            | CoreCommand::GameBrowserSettingsGet
            | CoreCommand::BrowserPreferencesApply { .. }
            | CoreCommand::CdnResolveSession { .. }
            | CoreCommand::LayoutResolve { .. }
            | CoreCommand::LayoutCreateDividers { .. }
            | CoreCommand::LayoutResizeDivider { .. }
            | CoreCommand::LayoutAdaptiveZoom { .. }
            | CoreCommand::EmbeddedKeyPrepare { .. }
            | CoreCommand::EmbeddedKeyComplete { .. }
            | CoreCommand::EmbeddedKeysReassert { .. }
            | CoreCommand::EmbeddedKeysHeld { .. }
            | CoreCommand::EmbeddedKeysClear { .. }
            | CoreCommand::OverlayRequest { .. }
            | CoreCommand::MacroReleaseRole { .. }
            | CoreCommand::CompatibilityStatuses
            | CoreCommand::CompatibilityCancel { .. }
            | CoreCommand::EmbeddedWindowsShow { .. }
            | CoreCommand::EmbeddedTabActivate { .. }
            | CoreCommand::EmbeddedTabActivateAdjacent { .. }
            | CoreCommand::EmbeddedTabHide { .. }
            | CoreCommand::EmbeddedTabReorder { .. }
            | CoreCommand::EmbeddedTabMove { .. }
            | CoreCommand::BrowserRoleLaunch { .. }
            | CoreCommand::BrowserWorkspaceLaunch { .. }
            | CoreCommand::BrowserRoleStop { .. }
            | CoreCommand::BrowserWorkspaceStop { .. }
    )
}

fn handle_shell_event(inner: &HelperInner, message: &Value) {
    let payload = message["payload"].clone();
    match message["event"].as_str() {
        Some("runtimeState") => {
            if let Ok(mut state) = inner.pending_runtime_state.lock() {
                *state = Some(payload.clone());
            }
            let _ = inner.app.emit(HELPER_RUNTIME_STATE_EVENT, payload);
        }
        Some("macroPageRequest") => {
            if let Ok(mut request) = inner.pending_macro_page.lock() {
                *request = Some(payload.clone());
            }
            let _ = inner.app.emit(HELPER_MACRO_PAGE_EVENT, payload);
        }
        Some("workspaceLaunchRequest") => {
            if let Ok(mut request) = inner.pending_workspace_launch.lock() {
                *request = Some(payload.clone());
            }
            let _ = inner.app.emit(HELPER_WORKSPACE_LAUNCH_EVENT, payload);
        }
        _ => {}
    }
}

fn helper_command(_app: &AppHandle) -> Result<(Command, PathBuf), String> {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Repository root could not be resolved.".to_owned())?
            .to_path_buf();
        let executable = if cfg!(target_os = "macos") {
            root.join("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
        } else {
            root.join("node_modules/electron/dist/electron.exe")
        };
        if !executable.is_file() {
            return Err(format!(
                "Electron runtime helper executable is missing: {}",
                executable.display()
            ));
        }
        let mut command = Command::new(executable);
        command.arg(root.join("build/tauri-helper-dev"));
        return Ok((command, root));
    }
    #[cfg(not(debug_assertions))]
    {
        let resources = _app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let executable = if cfg!(target_os = "macos") {
            resources.join(
                "electron-helper/Rion Studio Runtime Helper.app/Contents/MacOS/Rion Studio Runtime Helper",
            )
        } else {
            resources.join("electron-helper/Rion Studio Runtime Helper.exe")
        };
        if !executable.is_file() {
            return Err(format!(
                "Bundled Electron runtime helper is missing: {}",
                executable.display()
            ));
        }
        let mut command = Command::new(executable);
        command.arg("--rion-runtime-helper");
        Ok((command, resources))
    }
}

fn failed_result(
    effect_id: String,
    operation_id: String,
    code: &str,
    message: impl Into<String>,
) -> CoreEffectResult {
    CoreEffectResult {
        effect_id,
        operation_id,
        ok: false,
        value_json: None,
        error: Some(CoreErrorPayload {
            code: code.to_owned(),
            message: message.into(),
        }),
    }
}
