use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::future::join_all;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore};

use crate::{
    error::{CoreError, CoreResult},
    external_chrome::ExternalChromeCdpSession,
    model::{
        BrowserAction, BrowserActionRequest, BrowserActionResult, ExternalBrowserActionDispatch,
    },
};

const MAX_PENDING_ACTIONS: usize = 512;
const DIAGNOSTIC_REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const BEST_EFFORT_EVALUATE_TIMEOUT: Duration = Duration::from_millis(250);
type PartitionedActions = (
    Vec<(BrowserActionRequest, Arc<ExternalTarget>)>,
    Vec<BrowserActionRequest>,
);

#[derive(Default)]
struct InputState {
    held_key_owners: HashMap<String, HashSet<String>>,
    shortcut_suppression_owners: HashMap<String, HashSet<String>>,
}

struct ExternalTarget {
    cdp: Arc<ExternalChromeCdpSession>,
    execution_context_ids: RwLock<HashSet<i64>>,
    input: Mutex<InputState>,
    input_sequence: Mutex<()>,
    overlay_source: RwLock<Option<String>>,
    platform: String,
}

pub struct ExternalAutomationRuntime {
    pending: Arc<Semaphore>,
    platform: String,
    targets: RwLock<HashMap<String, Arc<ExternalTarget>>>,
}

impl ExternalAutomationRuntime {
    pub fn new(platform: String) -> Self {
        Self {
            pending: Arc::new(Semaphore::new(MAX_PENDING_ACTIONS)),
            platform,
            targets: RwLock::new(HashMap::new()),
        }
    }

    pub fn register(&self, role_id: String, cdp: Arc<ExternalChromeCdpSession>) -> CoreResult<()> {
        if role_id.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "external Chrome roleId is required".to_owned(),
            ));
        }
        let mut targets = self
            .targets
            .write()
            .map_err(|_| CoreError::Internal("external target lock poisoned".to_owned()))?;
        if let Some(previous) = targets.insert(
            role_id,
            Arc::new(ExternalTarget {
                cdp,
                execution_context_ids: RwLock::new(HashSet::new()),
                input: Mutex::new(InputState::default()),
                input_sequence: Mutex::new(()),
                overlay_source: RwLock::new(None),
                platform: self.platform.clone(),
            }),
        ) {
            previous.cdp.close();
        }
        Ok(())
    }

    pub fn is_active_session(
        &self,
        role_id: &str,
        session: &Arc<ExternalChromeCdpSession>,
    ) -> bool {
        self.targets
            .read()
            .ok()
            .and_then(|targets| targets.get(role_id).map(|t| Arc::ptr_eq(&t.cdp, session)))
            .unwrap_or(false)
    }

    pub fn unregister(&self, role_id: &str) -> CoreResult<()> {
        if let Some(target) = self
            .targets
            .write()
            .map_err(|_| CoreError::Internal("external target lock poisoned".to_owned()))?
            .remove(role_id)
        {
            target.cdp.close();
        }
        Ok(())
    }

    pub async fn focus(&self, role_id: &str) -> CoreResult<()> {
        self.target(role_id)?.focus().await
    }

    pub async fn set_window_bounds(
        &self,
        role_id: &str,
        bounds: crate::model::StatePixelBoundsRecord,
    ) -> CoreResult<()> {
        if bounds.width <= 0 || bounds.height <= 0 {
            return Err(CoreError::InvalidInput(
                "external Chrome bounds must have a positive size".to_owned(),
            ));
        }
        let target = self.target(role_id)?;
        let window = target
            .cdp
            .send("Browser.getWindowForTarget".to_owned(), None, None, None)
            .await?;
        let window_id = window
            .get("windowId")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                CoreError::ExternalChrome("external Chrome window id is unavailable".to_owned())
            })?;
        if window
            .get("bounds")
            .and_then(|value| value.get("windowState"))
            .and_then(Value::as_str)
            .is_some_and(|state| state != "normal")
        {
            target
                .cdp
                .send(
                    "Browser.setWindowBounds".to_owned(),
                    Some(json!({"windowId":window_id,"bounds":{"windowState":"normal"}})),
                    None,
                    None,
                )
                .await?;
        }
        target
            .cdp
            .send(
                "Browser.setWindowBounds".to_owned(),
                Some(json!({
                    "windowId":window_id,
                    "bounds":{"left":bounds.x,"top":bounds.y,"width":bounds.width,"height":bounds.height}
                })),
                None,
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn diagnostics(&self, role_id: &str) -> CoreResult<Value> {
        let target = self.target(role_id)?;
        let (browser, metrics, page, window) = tokio::join!(
            target.cdp.send(
                "Browser.getVersion".to_owned(),
                None,
                Some(DIAGNOSTIC_REQUEST_TIMEOUT),
                None
            ),
            target.cdp.send(
                "Performance.getMetrics".to_owned(),
                None,
                Some(DIAGNOSTIC_REQUEST_TIMEOUT),
                None
            ),
            target.cdp.send(
                "Runtime.evaluate".to_owned(),
                Some(json!({
                    "expression":"({ fullscreen: Boolean(document.fullscreenElement), hasFocus: document.hasFocus(), hidden: document.hidden, monotonicMs: performance.now(), visibilityState: document.visibilityState })",
                    "returnByValue":true
                })),
                Some(DIAGNOSTIC_REQUEST_TIMEOUT),
                None,
            ),
            target.cdp.send(
                "Browser.getWindowForTarget".to_owned(),
                None,
                Some(DIAGNOSTIC_REQUEST_TIMEOUT),
                None
            )
        );
        let mut errors = Vec::new();
        let browser = match browser {
            Ok(value) => Some(value),
            Err(error) => {
                errors.push(format_diagnostic_error("Browser.getVersion", &error));
                None
            }
        };
        let performance_metrics = match metrics {
            Ok(value) => value
                .get("metrics")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            Some((
                                item.get("name")?.as_str()?.to_owned(),
                                Value::from(item.get("value")?.as_f64()?),
                            ))
                        })
                        .collect::<serde_json::Map<String, Value>>()
                })
                .filter(|items| !items.is_empty())
                .map(Value::Object),
            Err(error) => {
                errors.push(format_diagnostic_error("Performance.getMetrics", &error));
                None
            }
        };
        let page = match page {
            Ok(value) => value
                .get("result")
                .and_then(|result| result.get("value"))
                .cloned(),
            Err(error) => {
                errors.push(format_diagnostic_error("Runtime.evaluate", &error));
                None
            }
        };
        let window = match window {
            Ok(value) => value.get("bounds").cloned(),
            Err(error) => {
                errors.push(format_diagnostic_error(
                    "Browser.getWindowForTarget",
                    &error,
                ));
                None
            }
        };
        Ok(json!({
            "capturedAt": chrono::Utc::now().to_rfc3339(),
            "browser":browser,
            "cdp":{"consecutiveEvaluateFailures":0},
            "performanceMetrics":performance_metrics,
            "page":page,
            "window":window,
            "errors":errors
        }))
    }

    pub async fn evaluate(&self, role_id: &str, source: &str) -> CoreResult<Value> {
        let value = self.target(role_id)?.evaluate(source).await?;
        serde_json::from_str(&value).map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub fn role_ids(&self) -> CoreResult<Vec<String>> {
        let mut role_ids = self
            .targets
            .read()
            .map_err(|_| CoreError::Internal("external target lock poisoned".to_owned()))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        role_ids.sort();
        Ok(role_ids)
    }

    pub async fn refresh_overlay(&self, role_id: &str) -> CoreResult<()> {
        let target = self.target(role_id)?;
        let source = target
            .overlay_source
            .read()
            .map_err(|_| CoreError::Internal("external overlay source lock poisoned".to_owned()))?
            .clone();
        let expression = match source {
            Some(source) => format!(
                "(() => {{ if (window.__rionStudioMacroOverlay?.refresh) return window.__rionStudioMacroOverlay.refresh(); {source} }})()"
            ),
            None => "void window.__rionStudioMacroOverlay?.refresh?.()".to_owned(),
        };
        tokio::time::timeout(
            Duration::from_secs(2),
            target.cdp.send(
                "Runtime.evaluate".to_owned(),
                Some(json!({"expression":expression})),
                None,
                None,
            ),
        )
        .await
        .map_err(|_| {
            CoreError::ExternalChrome("external overlay refresh timed out".to_owned())
        })??;
        Ok(())
    }

    pub fn set_overlay_source(&self, role_id: &str, source: String) -> CoreResult<()> {
        *self.target(role_id)?.overlay_source.write().map_err(|_| {
            CoreError::Internal("external overlay source lock poisoned".to_owned())
        })? = Some(source);
        Ok(())
    }

    pub fn overlay_source(&self, role_id: &str) -> CoreResult<Option<String>> {
        Ok(self
            .target(role_id)?
            .overlay_source
            .read()
            .map_err(|_| CoreError::Internal("external overlay source lock poisoned".to_owned()))?
            .clone())
    }

    pub fn execution_context_ids(&self, role_id: &str) -> CoreResult<Vec<i64>> {
        let mut context_ids = self
            .target(role_id)?
            .execution_context_ids
            .read()
            .map_err(|_| {
                CoreError::Internal("external execution context lock poisoned".to_owned())
            })?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        context_ids.sort_unstable();
        Ok(context_ids)
    }

    pub fn reset_execution_contexts(&self, role_id: &str) -> CoreResult<()> {
        self.target(role_id)?
            .execution_context_ids
            .write()
            .map_err(|_| {
                CoreError::Internal("external execution context lock poisoned".to_owned())
            })?
            .clear();
        Ok(())
    }

    pub async fn handle_notification(
        &self,
        role_id: &str,
        method: &str,
        params: Option<&Value>,
    ) -> CoreResult<()> {
        self.target(role_id)?
            .handle_notification(method, params)
            .await
    }

    pub async fn dispatch(
        &self,
        actions: Vec<BrowserActionRequest>,
    ) -> CoreResult<ExternalBrowserActionDispatch> {
        let (actions, unhandled) = self.partition_actions(actions)?;
        let mut tasks = Vec::new();
        for (action, target) in actions {
            let pending = Arc::clone(&self.pending);
            tasks.push(async move {
                let Ok(_permit) = pending.try_acquire_owned() else {
                    return failure(
                        action.request_id,
                        "BROWSER_ACTION_BACKPRESSURE",
                        "External browser action queue is full.",
                    );
                };
                target.execute(action).await
            });
        }
        Ok(ExternalBrowserActionDispatch {
            results: join_all(tasks).await,
            unhandled,
        })
    }

    pub fn split_actions(
        &self,
        actions: Vec<BrowserActionRequest>,
    ) -> CoreResult<(Vec<BrowserActionRequest>, Vec<BrowserActionRequest>)> {
        let (handled, unhandled) = self.partition_actions(actions)?;
        Ok((
            handled.into_iter().map(|(action, _)| action).collect(),
            unhandled,
        ))
    }

    fn partition_actions(
        &self,
        actions: Vec<BrowserActionRequest>,
    ) -> CoreResult<PartitionedActions> {
        let targets = self
            .targets
            .read()
            .map_err(|_| CoreError::Internal("external target lock poisoned".to_owned()))?
            .clone();
        let mut unhandled = Vec::new();
        let mut handled = Vec::new();
        for action in actions {
            let Some(target) = targets.get(&action.role_id).cloned() else {
                unhandled.push(action);
                continue;
            };
            if matches!(
                action.action,
                BrowserAction::Cookies { .. }
                    | BrowserAction::Session { .. }
                    | BrowserAction::Debugger { .. }
            ) {
                unhandled.push(action);
                continue;
            }
            handled.push((action, target));
        }
        Ok((handled, unhandled))
    }

    pub fn shutdown(&self) {
        if let Ok(mut targets) = self.targets.write() {
            for (_, target) in targets.drain() {
                target.cdp.close();
            }
        }
    }

    fn target(&self, role_id: &str) -> CoreResult<Arc<ExternalTarget>> {
        self.targets
            .read()
            .map_err(|_| CoreError::Internal("external target lock poisoned".to_owned()))?
            .get(role_id)
            .cloned()
            .ok_or_else(|| {
                domain(
                    "BROWSER_TARGET_UNAVAILABLE",
                    "External Chrome automation is unavailable.",
                )
            })
    }
}

impl ExternalTarget {
    async fn execute(&self, request: BrowserActionRequest) -> BrowserActionResult {
        if epoch_millis() > request.deadline_ms {
            return failure(
                request.request_id,
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            );
        }
        let result = match request.action {
            BrowserAction::Focus => self.ensure_input_focus().await.map(|_| None),
            BrowserAction::Key {
                phase,
                key,
                code,
                modifiers,
                owner_id,
                suppress_overlay_shortcut,
            } => {
                let _sequence = self.input_sequence.lock().await;
                self.key_with_suppression(
                    &phase,
                    code.as_deref().unwrap_or(&key),
                    &modifiers,
                    &owner_id,
                    suppress_overlay_shortcut,
                )
                .await
                .map(|_| None)
            }
            BrowserAction::Click {
                anchor,
                unit,
                x,
                y,
                button,
            } => {
                let _sequence = self.input_sequence.lock().await;
                self.click(anchor.as_deref(), &unit, x, y, &button)
                    .await
                    .map(|_| None)
            }
            BrowserAction::Evaluate { source } => self.evaluate(&source).await.map(Some),
            BrowserAction::Cookies { .. }
            | BrowserAction::Session { .. }
            | BrowserAction::Debugger { .. } => unreachable!("unsupported actions are unhandled"),
        };
        match result {
            Ok(value_json) => BrowserActionResult {
                request_id: request.request_id,
                ok: true,
                value_json,
                error_code: None,
                error_message: None,
            },
            Err(error) => failure(request.request_id, error.code(), &error.to_string()),
        }
    }

    async fn focus(&self) -> CoreResult<()> {
        self.cdp
            .send("Page.bringToFront".to_owned(), None, None, None)
            .await?;
        let _ = tokio::time::timeout(
            BEST_EFFORT_EVALUATE_TIMEOUT,
            self.cdp.send(
                "Runtime.evaluate".to_owned(),
                Some(json!({"expression":external_focus_source(true)})),
                Some(BEST_EFFORT_EVALUATE_TIMEOUT),
                None,
            ),
        )
        .await;
        Ok(())
    }

    async fn ensure_input_focus(&self) -> CoreResult<()> {
        let _ = tokio::time::timeout(
            BEST_EFFORT_EVALUATE_TIMEOUT,
            self.cdp.send(
                "Runtime.evaluate".to_owned(),
                Some(json!({
                    "expression":external_focus_source(false),
                    "awaitPromise":true,
                    "returnByValue":true
                })),
                Some(BEST_EFFORT_EVALUATE_TIMEOUT),
                None,
            ),
        )
        .await;
        Ok(())
    }

    async fn handle_notification(&self, method: &str, params: Option<&Value>) -> CoreResult<()> {
        match method {
            "Runtime.executionContextCreated" => {
                if let Some(context_id) = params
                    .and_then(|value| value.pointer("/context/id"))
                    .and_then(Value::as_i64)
                {
                    self.execution_context_ids
                        .write()
                        .map_err(|_| {
                            CoreError::Internal(
                                "external execution context lock poisoned".to_owned(),
                            )
                        })?
                        .insert(context_id);
                }
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(context_id) = params
                    .and_then(|value| value.get("executionContextId"))
                    .and_then(Value::as_i64)
                {
                    self.execution_context_ids
                        .write()
                        .map_err(|_| {
                            CoreError::Internal(
                                "external execution context lock poisoned".to_owned(),
                            )
                        })?
                        .remove(&context_id);
                }
            }
            "Runtime.executionContextsCleared" => {
                self.execution_context_ids
                    .write()
                    .map_err(|_| {
                        CoreError::Internal("external execution context lock poisoned".to_owned())
                    })?
                    .clear();
            }
            "Page.lifecycleEvent"
                if params
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    .is_some_and(|name| matches!(name, "frozen" | "resumed")) =>
            {
                self.reassert_held_keys().await?;
            }
            "Runtime.bindingCalled"
                if params
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    == Some("rionStudioExternalDiagnostics") =>
            {
                let should_reassert = params
                    .and_then(|value| value.get("payload"))
                    .and_then(Value::as_str)
                    .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                    .and_then(|payload| {
                        payload
                            .get("event")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .is_some_and(|event| {
                        matches!(
                            event.as_str(),
                            "blur"
                                | "focus"
                                | "pagehide"
                                | "pageshow"
                                | "visibilitychange"
                                | "freeze"
                                | "resume"
                        )
                    });
                if should_reassert {
                    self.reassert_held_keys().await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn reassert_held_keys(&self) -> CoreResult<()> {
        let _sequence = self.input_sequence.lock().await;
        let input = self.input.lock().await;
        if input.held_key_owners.is_empty() {
            return Ok(());
        }
        for code in input.held_key_owners.keys() {
            let suppress_shortcut = input
                .shortcut_suppression_owners
                .get(code)
                .is_some_and(|owners| !owners.is_empty());
            if suppress_shortcut {
                self.set_shortcut_suppression(code, "keydown", true).await;
            }
            let result =
                send_key(&self.cdp, "rawKeyDown", code, &input.held_key_owners, false).await;
            if suppress_shortcut {
                self.set_shortcut_suppression(code, "keydown", false).await;
            }
            result?;
        }
        Ok(())
    }

    #[cfg(test)]
    async fn key(
        &self,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
    ) -> CoreResult<()> {
        self.key_with_suppression(phase, code, modifiers, owner_id, true)
            .await
    }

    async fn key_with_suppression(
        &self,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
        suppress_overlay_shortcut: bool,
    ) -> CoreResult<()> {
        let mut input = self.input.lock().await;
        let modifier_codes = resolve_modifier_codes(modifiers, &self.platform);
        match phase {
            "hold" => {
                let mut acquired = Vec::new();
                for current in modifier_codes
                    .iter()
                    .chain(std::iter::once(&code.to_owned()))
                {
                    if input
                        .held_key_owners
                        .get(current)
                        .is_some_and(|owners| owners.contains(owner_id))
                    {
                        continue;
                    }
                    let existing = input
                        .held_key_owners
                        .get(current)
                        .is_some_and(|owners| !owners.is_empty());
                    input
                        .held_key_owners
                        .entry(current.clone())
                        .or_default()
                        .insert(owner_id.to_owned());
                    if current == code && suppress_overlay_shortcut {
                        input
                            .shortcut_suppression_owners
                            .entry(current.clone())
                            .or_default()
                            .insert(owner_id.to_owned());
                    }
                    acquired.push(current.clone());
                    if !existing {
                        if current == code && suppress_overlay_shortcut {
                            self.set_shortcut_suppression(code, "keydown", true).await;
                        }
                        let result = send_key(
                            &self.cdp,
                            "rawKeyDown",
                            current,
                            &input.held_key_owners,
                            false,
                        )
                        .await;
                        if current == code && suppress_overlay_shortcut {
                            self.set_shortcut_suppression(code, "keydown", false).await;
                        }
                        if let Err(error) = result {
                            for acquired_code in acquired.into_iter().rev() {
                                let _ = self
                                    .release_owned_key(
                                        &mut input,
                                        &acquired_code,
                                        owner_id,
                                        acquired_code == code && suppress_overlay_shortcut,
                                    )
                                    .await;
                            }
                            return Err(error);
                        }
                    }
                }
            }
            "release" => {
                for current in
                    std::iter::once(code.to_owned()).chain(modifier_codes.into_iter().rev())
                {
                    self.release_owned_key(
                        &mut input,
                        &current,
                        owner_id,
                        current == code && suppress_overlay_shortcut,
                    )
                    .await?;
                }
            }
            "tap" => {
                let mut active = input.held_key_owners.clone();
                let mut temporary_modifiers = Vec::new();
                for modifier in &modifier_codes {
                    if !active.contains_key(modifier) {
                        active.insert(modifier.clone(), HashSet::new());
                        temporary_modifiers.push(modifier.clone());
                        send_key(&self.cdp, "rawKeyDown", modifier, &active, false).await?;
                    }
                }
                if suppress_overlay_shortcut {
                    self.set_shortcut_suppression(code, "keydown", true).await;
                }
                let code_was_held = active.contains_key(code);
                let key_down =
                    send_key(&self.cdp, "rawKeyDown", code, &active, code_was_held).await;
                if suppress_overlay_shortcut {
                    self.set_shortcut_suppression(code, "keydown", false).await;
                }
                key_down?;
                if !code_was_held {
                    if suppress_overlay_shortcut {
                        self.set_shortcut_suppression(code, "keyup", true).await;
                    }
                    if let Err(error) = send_key(&self.cdp, "keyUp", code, &active, false).await {
                        let _ = send_key(&self.cdp, "keyUp", code, &active, false).await;
                        if suppress_overlay_shortcut {
                            self.set_shortcut_suppression(code, "keyup", false).await;
                        }
                        return Err(error);
                    }
                    if suppress_overlay_shortcut {
                        self.set_shortcut_suppression(code, "keyup", false).await;
                    }
                }
                for modifier in temporary_modifiers.into_iter().rev() {
                    if !input.held_key_owners.contains_key(&modifier) {
                        active.remove(&modifier);
                        send_key(&self.cdp, "keyUp", &modifier, &active, false).await?;
                    }
                }
            }
            _ => {
                return Err(domain(
                    "BROWSER_KEY_PHASE_INVALID",
                    "Browser key action phase is invalid.",
                ));
            }
        }
        Ok(())
    }

    async fn release_owned_key(
        &self,
        input: &mut InputState,
        code: &str,
        owner_id: &str,
        suppress_shortcut: bool,
    ) -> CoreResult<()> {
        let Some(owners) = input.held_key_owners.get_mut(code) else {
            return Ok(());
        };
        if !owners.remove(owner_id) {
            return Ok(());
        }
        if let Some(suppression_owners) = input.shortcut_suppression_owners.get_mut(code) {
            suppression_owners.remove(owner_id);
            if suppression_owners.is_empty() {
                input.shortcut_suppression_owners.remove(code);
            }
        }
        if !owners.is_empty() {
            return Ok(());
        }
        let mut owners = input.held_key_owners.remove(code).unwrap_or_default();
        if suppress_shortcut {
            self.set_shortcut_suppression(code, "keyup", true).await;
        }
        let first = send_key(&self.cdp, "keyUp", code, &input.held_key_owners, false).await;
        let result = match first {
            Ok(()) => Ok(()),
            Err(first_error) => send_key(&self.cdp, "keyUp", code, &input.held_key_owners, false)
                .await
                .map_err(|_| first_error),
        };
        if suppress_shortcut {
            self.set_shortcut_suppression(code, "keyup", false).await;
        }
        if result.is_err() {
            owners.insert(owner_id.to_owned());
            input.held_key_owners.insert(code.to_owned(), owners);
        }
        result
    }

    async fn set_shortcut_suppression(&self, code: &str, phase: &str, enabled: bool) {
        let method = if enabled {
            "suppressNextShortcut"
        } else {
            "clearSuppressedShortcut"
        };
        let expression = format!(
            "window[\"__rionStudioMacroOverlay\"]?.{method}?.({code}, {phase})",
            code = serde_json::to_string(code).unwrap_or_else(|_| "\"\"".to_owned()),
            phase = serde_json::to_string(phase).unwrap_or_else(|_| "\"keydown\"".to_owned()),
        );
        let context_ids = self
            .execution_context_ids
            .read()
            .map(|ids| ids.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        if context_ids.is_empty() {
            let _ = tokio::time::timeout(
                BEST_EFFORT_EVALUATE_TIMEOUT,
                self.cdp.send(
                    "Runtime.evaluate".to_owned(),
                    Some(json!({"expression":expression})),
                    Some(BEST_EFFORT_EVALUATE_TIMEOUT),
                    None,
                ),
            )
            .await;
            return;
        }
        let evaluations = context_ids.into_iter().map(|context_id| {
            let cdp = Arc::clone(&self.cdp);
            let expression = expression.clone();
            async move {
                let _ = tokio::time::timeout(
                    BEST_EFFORT_EVALUATE_TIMEOUT,
                    cdp.send(
                        "Runtime.evaluate".to_owned(),
                        Some(json!({"expression":expression,"contextId":context_id})),
                        Some(BEST_EFFORT_EVALUATE_TIMEOUT),
                        None,
                    ),
                )
                .await;
            }
        });
        join_all(evaluations).await;
    }

    async fn click(
        &self,
        anchor: Option<&str>,
        unit: &str,
        x: f64,
        y: f64,
        button: &str,
    ) -> CoreResult<()> {
        if !matches!(unit, "percent" | "px") {
            return Err(domain(
                "BROWSER_CLICK_UNIT_INVALID",
                "Browser click unit is invalid.",
            ));
        }
        let metrics = self
            .cdp
            .send("Page.getLayoutMetrics".to_owned(), None, None, None)
            .await?;
        let viewport = metrics.get("cssVisualViewport").unwrap_or(&Value::Null);
        let width = viewport
            .get("clientWidth")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .max(1.0);
        let height = viewport
            .get("clientHeight")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .max(1.0);
        let (anchor_x, anchor_y) = anchor_base(anchor)?;
        let resolved_x = if unit == "percent" {
            width * (anchor_x + x) / 100.0
        } else {
            width * anchor_x / 100.0 + x
        };
        let resolved_y = if unit == "percent" {
            height * (anchor_y + y) / 100.0
        } else {
            height * anchor_y / 100.0 + y
        };
        let x = resolved_x.round().clamp(0.0, width - 1.0);
        let y = resolved_y.round().clamp(0.0, height - 1.0);
        let button = if matches!(button, "left" | "middle" | "right") {
            button
        } else {
            "left"
        };
        self.cdp
            .send(
                "Input.dispatchMouseEvent".to_owned(),
                Some(json!({"type":"mousePressed","button":button,"clickCount":1,"x":x,"y":y})),
                None,
                None,
            )
            .await?;
        self.cdp
            .send(
                "Input.dispatchMouseEvent".to_owned(),
                Some(json!({"type":"mouseReleased","button":button,"clickCount":1,"x":x,"y":y})),
                None,
                None,
            )
            .await?;
        Ok(())
    }

    async fn evaluate(&self, source: &str) -> CoreResult<String> {
        let response = self
            .cdp
            .send(
                "Runtime.evaluate".to_owned(),
                Some(json!({
                    "expression": source,
                    "awaitPromise": true,
                    "returnByValue": true,
                    "userGesture": true
                })),
                None,
                None,
            )
            .await?;
        if let Some(exception) = response.get("exceptionDetails") {
            return Err(CoreError::ExternalChrome(format!(
                "Runtime.evaluate failed: {exception}"
            )));
        }
        let value = response
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        serde_json::to_string(&value).map_err(|error| CoreError::Internal(error.to_string()))
    }
}

fn failure(request_id: String, code: &str, message: &str) -> BrowserActionResult {
    BrowserActionResult {
        request_id,
        ok: false,
        value_json: None,
        error_code: Some(code.to_owned()),
        error_message: Some(message.to_owned()),
    }
}

fn format_diagnostic_error(method: &str, error: &CoreError) -> String {
    let message = redact_diagnostic_message(&error.to_string());
    let mut formatted = format!("{method}: {message}");
    if formatted.chars().count() > 256 {
        formatted = formatted.chars().take(256).collect();
    }
    formatted
}

fn redact_diagnostic_message(message: &str) -> String {
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    static WINDOWS_PATH: OnceLock<regex::Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<regex::Regex> = OnceLock::new();
    let message = URL
        .get_or_init(|| regex::Regex::new(r#"(?i)\bhttps?://[^\s"']+"#).unwrap())
        .replace_all(message, "<URL>");
    let message = WINDOWS_PATH
        .get_or_init(|| {
            regex::Regex::new(r#"(?:[A-Za-z]:)?[\\](?:[^\s"'\\]+[\\])+[^\s"'\\]*"#).unwrap()
        })
        .replace_all(&message, "<PATH>");
    UNIX_PATH
        .get_or_init(|| regex::Regex::new(r#"/(?:[^\s"'/]+/)+[^\s"']*"#).unwrap())
        .replace_all(&message, "<PATH>")
        .into_owned()
}

fn external_focus_source(allow_body_fallback: bool) -> String {
    format!(
        r#"(() => {{
  const visible = (element) => {{
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }};
  const target = [...document.querySelectorAll("canvas, iframe")]
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || ({allow_body_fallback} ? document.body : null);
  if (!(target instanceof HTMLElement)) return false;
  if (document.activeElement === target) return true;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  try {{ target.focus({{ preventScroll: true }}); }} catch {{ target.focus(); }}
  return document.activeElement === target;
}})()"#
    )
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn resolve_modifier_codes(modifiers: &[String], platform: &str) -> Vec<String> {
    let mut result = Vec::new();
    for modifier in modifiers {
        let code = match modifier.as_str() {
            "primary" if platform == "darwin" => "MetaLeft",
            "primary" | "ctrl" => "ControlLeft",
            "meta" => "MetaLeft",
            "alt" => "AltLeft",
            "shift" => "ShiftLeft",
            _ => continue,
        };
        if !result.iter().any(|candidate| candidate == code) {
            result.push(code.to_owned());
        }
    }
    result
}

async fn send_key(
    cdp: &ExternalChromeCdpSession,
    event_type: &str,
    code: &str,
    active: &HashMap<String, HashSet<String>>,
    auto_repeat: bool,
) -> CoreResult<()> {
    let modifiers = modifier_mask(active.keys().map(String::as_str));
    let (key, virtual_key, location) = key_descriptor(code, modifiers);
    let mut params = json!({"type":event_type,"code":code,"key":key});
    if auto_repeat {
        params["autoRepeat"] = json!(true);
    }
    if modifiers > 0 {
        params["modifiers"] = json!(modifiers);
    }
    if let Some(virtual_key) = virtual_key {
        params["windowsVirtualKeyCode"] = json!(virtual_key);
    }
    if let Some(location) = location {
        params["location"] = json!(location);
    }
    cdp.send(
        "Input.dispatchKeyEvent".to_owned(),
        Some(params),
        None,
        None,
    )
    .await?;
    Ok(())
}

fn modifier_mask<'a>(codes: impl Iterator<Item = &'a str>) -> u8 {
    codes.fold(0, |mask, code| {
        mask | match code {
            "AltLeft" | "AltRight" => 1,
            "ControlLeft" | "ControlRight" => 2,
            "MetaLeft" | "MetaRight" => 4,
            "ShiftLeft" | "ShiftRight" => 8,
            _ => 0,
        }
    })
}

fn key_descriptor(code: &str, modifiers: u8) -> (String, Option<u32>, Option<u8>) {
    let shift = modifiers & 8 != 0;
    let key = if let Some(letter) = code.strip_prefix("Key").filter(|value| value.len() == 1) {
        if shift {
            letter.to_owned()
        } else {
            letter.to_ascii_lowercase()
        }
    } else if let Some(digit) = code.strip_prefix("Digit").filter(|value| value.len() == 1) {
        if shift {
            shifted_digit(digit).unwrap_or(digit).to_owned()
        } else {
            digit.to_owned()
        }
    } else {
        special_key(code, shift).unwrap_or(code).to_owned()
    };
    let virtual_key = if code.starts_with("Key") && code.len() == 4 {
        code.as_bytes().get(3).copied().map(u32::from)
    } else if code.starts_with("Digit") && code.len() == 6 {
        code.as_bytes().get(5).copied().map(u32::from)
    } else {
        virtual_key(code).or_else(|| {
            (key.chars().count() == 1).then(|| key.to_uppercase().chars().next().unwrap() as u32)
        })
    };
    let location = if code.ends_with("Left") && is_modifier(code) {
        Some(1)
    } else if code.ends_with("Right") && is_modifier(code) {
        Some(2)
    } else if code.starts_with("Numpad") {
        Some(3)
    } else {
        None
    };
    (key, virtual_key, location)
}

fn is_modifier(code: &str) -> bool {
    ["Alt", "Control", "Meta", "Shift"]
        .iter()
        .any(|prefix| code.starts_with(prefix))
}

fn shifted_digit(value: &str) -> Option<&'static str> {
    Some(match value {
        "0" => ")",
        "1" => "!",
        "2" => "@",
        "3" => "#",
        "4" => "$",
        "5" => "%",
        "6" => "^",
        "7" => "&",
        "8" => "*",
        "9" => "(",
        _ => return None,
    })
}

fn special_key(code: &str, shift: bool) -> Option<&'static str> {
    if shift {
        match code {
            "Backquote" => return Some("~"),
            "Backslash" => return Some("|"),
            "BracketLeft" => return Some("{"),
            "BracketRight" => return Some("}"),
            "Comma" => return Some("<"),
            "Equal" => return Some("+"),
            "Minus" => return Some("_"),
            "Period" => return Some(">"),
            "Quote" => return Some("\""),
            "Semicolon" => return Some(":"),
            "Slash" => return Some("?"),
            _ => {}
        }
    }
    Some(match code {
        "AltLeft" | "AltRight" => "Alt",
        "ControlLeft" | "ControlRight" => "Control",
        "MetaLeft" | "MetaRight" => "Meta",
        "ShiftLeft" | "ShiftRight" => "Shift",
        "Backquote" => "`",
        "Backslash" => "\\",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Comma" => ",",
        "Equal" => "=",
        "Minus" => "-",
        "Period" => ".",
        "Quote" => "'",
        "Semicolon" => ";",
        "Slash" => "/",
        "Space" => " ",
        "NumpadAdd" => "+",
        "NumpadDecimal" => ".",
        "NumpadDivide" => "/",
        "NumpadMultiply" => "*",
        "NumpadSubtract" => "-",
        "Backspace" => "Backspace",
        "Tab" => "Tab",
        "Enter" => "Enter",
        "Escape" => "Escape",
        "ArrowLeft" => "ArrowLeft",
        "ArrowUp" => "ArrowUp",
        "ArrowRight" => "ArrowRight",
        "ArrowDown" => "ArrowDown",
        _ => return None,
    })
}

fn virtual_key(code: &str) -> Option<u32> {
    if let Some(function) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=12).contains(value))
    {
        return Some(111 + function);
    }
    Some(match code {
        "AltLeft" | "AltRight" => 18,
        "ControlLeft" | "ControlRight" => 17,
        "MetaLeft" => 91,
        "MetaRight" => 92,
        "ShiftLeft" | "ShiftRight" => 16,
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" => 13,
        "Escape" => 27,
        "Space" => 32,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Semicolon" => 186,
        "Equal" => 187,
        "Comma" => 188,
        "Minus" => 189,
        "Period" => 190,
        "Slash" => 191,
        "Backquote" => 192,
        "BracketLeft" => 219,
        "Backslash" => 220,
        "BracketRight" => 221,
        "Quote" => 222,
        "NumpadMultiply" => 106,
        "NumpadAdd" => 107,
        "NumpadSubtract" => 109,
        "NumpadDecimal" => 110,
        "NumpadDivide" => 111,
        _ => return None,
    })
}

fn anchor_base(anchor: Option<&str>) -> CoreResult<(f64, f64)> {
    Ok(match anchor.unwrap_or("top-left") {
        "top-left" => (0.0, 0.0),
        "top-center" => (50.0, 0.0),
        "top-right" => (100.0, 0.0),
        "center-left" => (0.0, 50.0),
        "center" => (50.0, 50.0),
        "center-right" => (100.0, 50.0),
        "bottom-left" => (0.0, 100.0),
        "bottom-center" => (50.0, 100.0),
        "bottom-right" => (100.0, 100.0),
        _ => {
            return Err(domain(
                "BROWSER_CLICK_ANCHOR_INVALID",
                "Browser click anchor is invalid.",
            ));
        }
    })
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[test]
    fn resolves_cross_platform_modifiers_and_complete_cdp_key_descriptors() {
        assert_eq!(
            resolve_modifier_codes(&["primary".to_owned(), "shift".to_owned()], "darwin"),
            ["MetaLeft", "ShiftLeft"]
        );
        assert_eq!(
            resolve_modifier_codes(&["primary".to_owned(), "alt".to_owned()], "win32"),
            ["ControlLeft", "AltLeft"]
        );
        assert_eq!(key_descriptor("KeyK", 0), ("k".to_owned(), Some(75), None));
        assert_eq!(key_descriptor("KeyK", 8), ("K".to_owned(), Some(75), None));
        assert_eq!(
            key_descriptor("ControlRight", 2),
            ("Control".to_owned(), Some(17), Some(2))
        );
        assert_eq!(key_descriptor("Digit1", 8).0, "!");
        crate::v1_case!("external-chrome-cdn-6974e84181fb", {
            let codes = resolve_modifier_codes(&["primary".to_owned()], "darwin");
            assert_eq!(codes, ["MetaLeft"]);
            assert_eq!(modifier_mask(codes.iter().map(String::as_str)), 4);
        });
        crate::v1_case!("external-chrome-cdn-9dd9d097e59b", {
            let codes = resolve_modifier_codes(&["primary".to_owned()], "win32");
            assert_eq!(codes, ["ControlLeft"]);
            assert_eq!(modifier_mask(codes.iter().map(String::as_str)), 2);
        });
        crate::v1_case!("external-chrome-cdn-0ce0cce42c01", {
            assert_eq!(key_descriptor("F2", 0), ("F2".to_owned(), Some(113), None));
            assert_eq!(
                key_descriptor("Minus", 0),
                ("-".to_owned(), Some(189), None)
            );
            assert_eq!(
                key_descriptor("Slash", 8),
                ("?".to_owned(), Some(191), None)
            );
            assert_eq!(
                key_descriptor("Custom1", 0),
                ("Custom1".to_owned(), None, None)
            );
        });
    }

    #[test]
    fn validates_all_supported_click_anchors() {
        assert_eq!(anchor_base(Some("top-left")).unwrap(), (0.0, 0.0));
        assert_eq!(anchor_base(Some("center")).unwrap(), (50.0, 50.0));
        assert_eq!(anchor_base(Some("bottom-right")).unwrap(), (100.0, 100.0));
        assert_eq!(
            anchor_base(Some("outside")).unwrap_err().code(),
            "BROWSER_CLICK_ANCHOR_INVALID"
        );
    }

    #[tokio::test]
    async fn preserves_physical_key_combinations_and_held_owner_reference_counts() {
        crate::v1_case!("external-chrome-cdn-2a775aca1edd", {
            let (target, calls) = recording_target("linux");
            target.key("tap", "KeyQ", &[], "tap").await.unwrap();
            assert_eq!(
                input_params(&calls),
                [
                    json!({"type":"rawKeyDown","code":"KeyQ","key":"q","windowsVirtualKeyCode":81}),
                    json!({"type":"keyUp","code":"KeyQ","key":"q","windowsVirtualKeyCode":81}),
                ]
            );
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
            assert!(!expressions(&calls).contains("querySelectorAll(\"canvas, iframe\")"));
        });

        crate::v1_case!("external-chrome-cdn-b6a9e8e42ba4", {
            let (target, calls) = recording_target("linux");
            target.key("hold", "Digit1", &[], "owner").await.unwrap();
            target.key("tap", "Digit1", &[], "tap").await.unwrap();
            target.key("release", "Digit1", &[], "owner").await.unwrap();
            assert_eq!(
                input_params(&calls),
                [
                    json!({"type":"rawKeyDown","code":"Digit1","key":"1","windowsVirtualKeyCode":49}),
                    json!({"type":"rawKeyDown","code":"Digit1","key":"1","windowsVirtualKeyCode":49,"autoRepeat":true}),
                    json!({"type":"keyUp","code":"Digit1","key":"1","windowsVirtualKeyCode":49}),
                ]
            );
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
        });

        crate::v1_case!("external-chrome-cdn-bafa7d7e2b88", {
            let (target, calls) = recording_target("win32");
            target
                .key(
                    "tap",
                    "KeyK",
                    &["ctrl".to_owned(), "shift".to_owned()],
                    "tap",
                )
                .await
                .unwrap();
            assert_eq!(
                input_params(&calls),
                [
                    json!({"type":"rawKeyDown","code":"ControlLeft","key":"Control","windowsVirtualKeyCode":17,"location":1,"modifiers":2}),
                    json!({"type":"rawKeyDown","code":"ShiftLeft","key":"Shift","windowsVirtualKeyCode":16,"location":1,"modifiers":10}),
                    json!({"type":"rawKeyDown","code":"KeyK","key":"K","windowsVirtualKeyCode":75,"modifiers":10}),
                    json!({"type":"keyUp","code":"KeyK","key":"K","windowsVirtualKeyCode":75,"modifiers":10}),
                    json!({"type":"keyUp","code":"ShiftLeft","key":"Shift","windowsVirtualKeyCode":16,"location":1,"modifiers":2}),
                    json!({"type":"keyUp","code":"ControlLeft","key":"Control","windowsVirtualKeyCode":17,"location":1}),
                ]
            );
        });

        crate::v1_case!("external-chrome-cdn-1c8e16b12f08", {
            let (target, calls) = recording_target("win32");
            let modifiers = ["ctrl".to_owned()];
            target
                .key("hold", "KeyK", &modifiers, "owner-1")
                .await
                .unwrap();
            target
                .key("hold", "KeyL", &modifiers, "owner-2")
                .await
                .unwrap();
            target
                .key("release", "KeyK", &modifiers, "owner-1")
                .await
                .unwrap();
            target
                .key("release", "KeyL", &modifiers, "owner-2")
                .await
                .unwrap();
            assert_eq!(
                input_types_and_codes(&calls),
                [
                    ("rawKeyDown".to_owned(), "ControlLeft".to_owned()),
                    ("rawKeyDown".to_owned(), "KeyK".to_owned()),
                    ("rawKeyDown".to_owned(), "KeyL".to_owned()),
                    ("keyUp".to_owned(), "KeyK".to_owned()),
                    ("keyUp".to_owned(), "KeyL".to_owned()),
                    ("keyUp".to_owned(), "ControlLeft".to_owned()),
                ]
            );
        });

        crate::v1_case!("external-chrome-cdn-d068fda7e200", {
            let (target, calls) = recording_target("linux");
            target.key("hold", "KeyW", &[], "owner-1").await.unwrap();
            target.key("hold", "KeyW", &[], "owner-2").await.unwrap();
            target.key("release", "KeyW", &[], "owner-1").await.unwrap();
            target.key("tap", "KeyW", &[], "tap").await.unwrap();
            target.key("release", "KeyW", &[], "owner-2").await.unwrap();
            assert_eq!(
                input_params(&calls),
                [
                    json!({"type":"rawKeyDown","code":"KeyW","key":"w","windowsVirtualKeyCode":87}),
                    json!({"type":"rawKeyDown","code":"KeyW","key":"w","windowsVirtualKeyCode":87,"autoRepeat":true}),
                    json!({"type":"keyUp","code":"KeyW","key":"w","windowsVirtualKeyCode":87}),
                ]
            );
        });
    }

    #[tokio::test]
    async fn reasserts_only_currently_held_keys_for_page_lifecycle_events() {
        let (target, calls) = recording_target("win32");
        target.key("hold", "KeyW", &[], "owner").await.unwrap();
        for event in ["blur", "visibilitychange", "focus", "pageshow"] {
            let payload = json!({
                "name":"rionStudioExternalDiagnostics",
                "payload":json!({"event":event}).to_string()
            });
            target
                .handle_notification("Runtime.bindingCalled", Some(&payload))
                .await
                .unwrap();
        }
        crate::v1_case!("external-chrome-cdn-458946352d1c", {
            assert_eq!(key_down_count(&calls, "KeyW"), 5);
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
        });

        let lifecycle = json!({"name":"resumed"});
        target
            .handle_notification("Page.lifecycleEvent", Some(&lifecycle))
            .await
            .unwrap();
        crate::v1_case!("external-chrome-cdn-af93c98e1613", {
            assert_eq!(key_down_count(&calls, "KeyW"), 6);
        });
        target.key("release", "KeyW", &[], "owner").await.unwrap();
        target
            .handle_notification("Page.lifecycleEvent", Some(&lifecycle))
            .await
            .unwrap();
        assert_eq!(key_down_count(&calls, "KeyW"), 6);
        assert_eq!(key_up_count(&calls, "KeyW"), 1);
    }

    #[tokio::test]
    async fn suppresses_shortcuts_in_every_execution_context_and_separates_focus_intents() {
        let (target, calls) = recording_target("linux");
        for context_id in [7, 8] {
            let params = json!({"context":{"id":context_id}});
            target
                .handle_notification("Runtime.executionContextCreated", Some(&params))
                .await
                .unwrap();
        }
        target.key("tap", "F2", &[], "tap").await.unwrap();
        crate::v1_case!("external-chrome-cdn-b7779dea84de", {
            let calls = calls.lock().unwrap();
            for context_id in [7, 8] {
                assert!(calls.iter().any(|(method, params)| {
                    method == "Runtime.evaluate"
                        && params.as_ref().and_then(|value| value.get("contextId"))
                            == Some(&json!(context_id))
                        && params
                            .as_ref()
                            .and_then(|value| value.get("expression"))
                            .and_then(Value::as_str)
                            .is_some_and(|source| {
                                source.contains("suppressNextShortcut") && source.contains("\"F2\"")
                            })
                }));
            }
        });

        target.ensure_input_focus().await.unwrap();
        crate::v1_case!("external-chrome-cdn-595bc637c8d8", {
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
            assert!(expressions(&calls).contains("querySelectorAll(\"canvas, iframe\")"));
            assert!(expressions(&calls).contains("(false ? document.body : null)"));
        });
        target.focus().await.unwrap();
        crate::v1_case!("external-chrome-cdn-090947a66406", {
            assert_eq!(
                methods(&calls)
                    .iter()
                    .filter(|method| method.as_str() == "Page.bringToFront")
                    .count(),
                1
            );
            assert!(expressions(&calls).contains("(true ? document.body : null)"));
        });
        crate::v1_case!("external-chrome-cdn-ed0bb1aa2cde", {
            assert!(
                methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
        });
        crate::v1_case!("external-chrome-cdn-dabd24bf5abf", {
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Target.setAutoAttach")
            );
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Emulation.setCPUThrottlingRate")
            );
            assert!(!calls.lock().unwrap().iter().any(|(method, params)| {
                method == "Runtime.addBinding"
                    && params.as_ref().and_then(|value| value.get("name"))
                        == Some(&json!("rionStudioWindowFocus"))
            }));
        });
    }

    #[tokio::test]
    async fn skips_overlay_suppression_without_a_shortcut_collision() {
        let (target, calls) = recording_target("linux");
        target
            .key_with_suppression("tap", "KeyQ", &[], "tap", false)
            .await
            .unwrap();
        assert_eq!(
            input_types_and_codes(&calls),
            [
                ("rawKeyDown".to_owned(), "KeyQ".to_owned()),
                ("keyUp".to_owned(), "KeyQ".to_owned()),
            ]
        );
        assert!(
            !methods(&calls)
                .iter()
                .any(|method| method == "Runtime.evaluate")
        );
    }

    #[tokio::test]
    async fn focus_evaluate_timeout_does_not_block_later_input_dispatch() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let cdp = Arc::new(ExternalChromeCdpSession::test_session_with_handler(
            move |method, params| {
                output
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params.cloned()));
                if method == "Runtime.evaluate" {
                    std::thread::sleep(Duration::from_millis(350));
                }
                Ok(json!({}))
            },
        ));
        let target = make_target(cdp, "linux");
        let started = std::time::Instant::now();
        target.ensure_input_focus().await.unwrap();
        assert!(started.elapsed() < Duration::from_millis(325));
        target
            .key_with_suppression("tap", "KeyQ", &[], "tap", false)
            .await
            .unwrap();
        assert_eq!(
            input_types_and_codes(&calls),
            [
                ("rawKeyDown".to_owned(), "KeyQ".to_owned()),
                ("keyUp".to_owned(), "KeyQ".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn collects_bounded_redacted_diagnostics_without_page_content() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let cdp = Arc::new(ExternalChromeCdpSession::test_session_with_handler(
            move |method, params| {
                output
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params.cloned()));
                Ok(match method {
                    "Browser.getVersion" => {
                        json!({"product":"Chrome/596.36","protocolVersion":"1.3"})
                    }
                    "Performance.getMetrics" => json!({
                        "metrics":[
                            {"name":"TaskDuration","value":12.5},
                            {"name":"JSHeapUsedSize","value":2048}
                        ]
                    }),
                    "Runtime.evaluate" => json!({"result":{"value":{
                        "fullscreen":true,
                        "hasFocus":true,
                        "hidden":false,
                        "monotonicMs":123.4,
                        "visibilityState":"visible"
                    }}}),
                    "Browser.getWindowForTarget" => json!({
                        "windowId":1,
                        "bounds":{"height":1440,"width":2560,"windowState":"fullscreen"}
                    }),
                    _ => json!({}),
                })
            },
        ));
        let runtime = ExternalAutomationRuntime::new("linux".to_owned());
        runtime.register("role-1".to_owned(), cdp).unwrap();
        let diagnostics = runtime.diagnostics("role-1").await.unwrap();
        crate::v1_case!("external-chrome-cdn-25cb43eedd32", {
            assert_eq!(diagnostics["performanceMetrics"]["TaskDuration"], 12.5);
            assert_eq!(
                diagnostics["performanceMetrics"]["JSHeapUsedSize"].as_f64(),
                Some(2048.0)
            );
            assert_eq!(diagnostics["page"]["fullscreen"], true);
            assert_eq!(diagnostics["window"]["windowState"], "fullscreen");
            assert!(!diagnostics.to_string().contains("https://"));
            assert!(!expressions(&calls).contains("document.body.inner"));
        });
        crate::v1_case!("external-chrome-cdn-eb69bf979e3f", {
            assert_eq!(diagnostics["browser"]["product"], "Chrome/596.36");
            assert_eq!(diagnostics["cdp"]["consecutiveEvaluateFailures"], 0);
            assert!(
                methods(&calls)
                    .iter()
                    .any(|method| method == "Performance.getMetrics")
            );
            assert!(
                methods(&calls)
                    .iter()
                    .any(|method| method == "Browser.getWindowForTarget")
            );
        });

        crate::v1_case!("external-chrome-cdn-11953eb9d48b", {
            let redacted = redact_diagnostic_message(
                r#"https://game.example.test failed while reading C:\profiles\role-1\browser and /Users/test/profile/Default"#,
            );
            assert!(!redacted.contains("https://"));
            assert!(!redacted.contains("game.example.test"));
            assert!(!redacted.contains(r"C:\profiles"));
            assert!(!redacted.contains("/Users/test"));
            assert!(redacted.contains("<URL>"));
            assert!(redacted.contains("<PATH>"));
        });
    }

    #[tokio::test]
    async fn rolls_back_failed_holds_and_retries_key_release() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let failed_down = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler_failed_down = Arc::clone(&failed_down);
        let target = make_target(
            Arc::new(ExternalChromeCdpSession::test_session_with_handler(
                move |method, params| {
                    output
                        .lock()
                        .unwrap()
                        .push((method.to_owned(), params.cloned()));
                    if method == "Input.dispatchKeyEvent"
                        && params
                            .and_then(|value| value.get("type"))
                            .and_then(Value::as_str)
                            == Some("rawKeyDown")
                        && params
                            .and_then(|value| value.get("code"))
                            .and_then(Value::as_str)
                            == Some("KeyW")
                        && !handler_failed_down.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        return Err(CoreError::ExternalChrome("cancelled keyDown".to_owned()));
                    }
                    Ok(json!({"result":{"value":true}}))
                },
            )),
            "linux",
        );
        let error = target
            .key("hold", "KeyW", &["shift".to_owned()], "owner")
            .await
            .unwrap_err();
        crate::v1_case!("external-chrome-cdn-bb00d21a344e", {
            assert!(error.to_string().contains("cancelled keyDown"));
            assert_eq!(
                input_types_and_codes(&calls),
                [
                    ("rawKeyDown".to_owned(), "ShiftLeft".to_owned()),
                    ("rawKeyDown".to_owned(), "KeyW".to_owned()),
                    ("keyUp".to_owned(), "KeyW".to_owned()),
                    ("keyUp".to_owned(), "ShiftLeft".to_owned()),
                ]
            );
            assert!(target.input.lock().await.held_key_owners.is_empty());
        });

        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let key_up_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler_key_up_calls = Arc::clone(&key_up_calls);
        let target = make_target(
            Arc::new(ExternalChromeCdpSession::test_session_with_handler(
                move |method, params| {
                    output
                        .lock()
                        .unwrap()
                        .push((method.to_owned(), params.cloned()));
                    if method == "Input.dispatchKeyEvent"
                        && params
                            .and_then(|value| value.get("type"))
                            .and_then(Value::as_str)
                            == Some("keyUp")
                        && handler_key_up_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                            == 0
                    {
                        return Err(CoreError::ExternalChrome("keyUp timed out".to_owned()));
                    }
                    Ok(json!({"result":{"value":true}}))
                },
            )),
            "linux",
        );
        let error = target.key("tap", "F2", &[], "tap").await.unwrap_err();
        crate::v1_case!("external-chrome-cdn-ce346e3e7fde", {
            assert!(error.to_string().contains("keyUp timed out"));
            assert_eq!(key_up_calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolves_clicks_in_css_viewport_without_focus_and_serializes_pairs() {
        let (target, calls) = recording_target("linux");
        target
            .click(None, "percent", 25.0, 75.0, "left")
            .await
            .unwrap();
        crate::v1_case!("external-chrome-cdn-91ff4d243176", {
            assert_eq!(
                mouse_params(&calls),
                [
                    json!({"type":"mousePressed","button":"left","clickCount":1,"x":320.0,"y":540.0}),
                    json!({"type":"mouseReleased","button":"left","clickCount":1,"x":320.0,"y":540.0}),
                ]
            );
        });
        target
            .click(Some("bottom-right"), "px", -24.0, -32.0, "left")
            .await
            .unwrap();
        target
            .click(Some("bottom-right"), "percent", -10.0, -10.0, "left")
            .await
            .unwrap();
        crate::v1_case!("external-chrome-cdn-0415dea1f374", {
            let pressed = mouse_params(&calls)
                .into_iter()
                .filter(|params| params["type"] == "mousePressed")
                .collect::<Vec<_>>();
            assert_eq!(
                (pressed[1]["x"].as_f64(), pressed[1]["y"].as_f64()),
                (Some(1256.0), Some(688.0))
            );
            assert_eq!(
                (pressed[2]["x"].as_f64(), pressed[2]["y"].as_f64()),
                (Some(1152.0), Some(648.0))
            );
        });
        crate::v1_case!("external-chrome-cdn-4ae20a942120", {
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
            assert!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|(method, _)| method != "Runtime.evaluate")
            );
        });

        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let (first_pressed, first_pressed_receiver) = std::sync::mpsc::channel();
        let (release_first, release_first_receiver) = std::sync::mpsc::channel();
        let cdp = Arc::new(ExternalChromeCdpSession::test_session_with_handler(
            move |method, params| {
                output
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params.cloned()));
                if method == "Input.dispatchMouseEvent"
                    && params
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str)
                        == Some("mousePressed")
                    && params
                        .and_then(|value| value.get("x"))
                        .and_then(Value::as_f64)
                        == Some(10.0)
                {
                    let _ = first_pressed.send(());
                    let _ = release_first_receiver.recv();
                }
                Ok(match method {
                    "Page.getLayoutMetrics" => {
                        json!({"cssVisualViewport":{"clientWidth":100.0,"clientHeight":100.0}})
                    }
                    _ => json!({}),
                })
            },
        ));
        let target = Arc::new(make_target(cdp, "linux"));
        let first_target = Arc::clone(&target);
        let first = tokio::spawn(async move {
            first_target
                .execute(action_request(
                    "first",
                    BrowserAction::Click {
                        anchor: None,
                        unit: "percent".to_owned(),
                        x: 10.0,
                        y: 10.0,
                        button: "left".to_owned(),
                    },
                ))
                .await
        });
        first_pressed_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let second_target = Arc::clone(&target);
        let second = tokio::spawn(async move {
            second_target
                .execute(action_request(
                    "second",
                    BrowserAction::Click {
                        anchor: None,
                        unit: "percent".to_owned(),
                        x: 90.0,
                        y: 90.0,
                        button: "left".to_owned(),
                    },
                ))
                .await
        });
        tokio::task::yield_now().await;
        assert!(!mouse_params(&calls).iter().any(|params| {
            params["type"] == "mousePressed" && params["x"].as_f64() == Some(90.0)
        }));
        release_first.send(()).unwrap();
        assert!(first.await.unwrap().ok);
        assert!(second.await.unwrap().ok);
        crate::v1_case!("external-chrome-cdn-8febda3da9ca", {
            assert_eq!(
                mouse_params(&calls)
                    .iter()
                    .map(|params| (
                        params["type"].as_str().unwrap().to_owned(),
                        params["x"].as_f64().unwrap() as i32,
                    ))
                    .collect::<Vec<_>>(),
                [
                    ("mousePressed".to_owned(), 10),
                    ("mouseReleased".to_owned(), 10),
                    ("mousePressed".to_owned(), 90),
                    ("mouseReleased".to_owned(), 90),
                ]
            );
        });
    }

    #[tokio::test]
    async fn repeated_input_stays_physical_and_window_bounds_are_exact() {
        let (target, calls) = recording_target("linux");
        for _ in 0..50 {
            target.key("tap", "Digit1", &[], "tap").await.unwrap();
            target
                .click(None, "percent", 50.0, 50.0, "left")
                .await
                .unwrap();
        }
        crate::v1_case!("external-chrome-cdn-9ce15c25cd97", {
            assert_eq!(input_params(&calls).len(), 100);
            assert_eq!(mouse_params(&calls).len(), 100);
            let evaluated = expressions(&calls);
            assert!(!evaluated.contains("document.activeElement"));
            assert!(!evaluated.contains(".focus("));
            assert!(!evaluated.contains("querySelectorAll(\"canvas, iframe\")"));
            assert!(
                !methods(&calls)
                    .iter()
                    .any(|method| method == "Page.bringToFront")
            );
        });

        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let cdp = Arc::new(ExternalChromeCdpSession::test_session_with_handler(
            move |method, params| {
                output
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params.cloned()));
                Ok(if method == "Browser.getWindowForTarget" {
                    json!({"windowId":42,"bounds":{"windowState":"maximized"}})
                } else {
                    json!({})
                })
            },
        ));
        let runtime = ExternalAutomationRuntime::new("linux".to_owned());
        runtime.register("role-1".to_owned(), cdp).unwrap();
        runtime
            .set_window_bounds(
                "role-1",
                crate::model::StatePixelBoundsRecord {
                    x: -1280,
                    y: -120,
                    width: 800,
                    height: 900,
                },
            )
            .await
            .unwrap();
        crate::v1_case!("external-chrome-cdn-dd54876492b8", {
            assert_eq!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| method.starts_with("Browser."))
                    .cloned()
                    .collect::<Vec<_>>(),
                [
                    ("Browser.getWindowForTarget".to_owned(), None),
                    (
                        "Browser.setWindowBounds".to_owned(),
                        Some(json!({"windowId":42,"bounds":{"windowState":"normal"}}))
                    ),
                    (
                        "Browser.setWindowBounds".to_owned(),
                        Some(
                            json!({"windowId":42,"bounds":{"left":-1280,"top":-120,"width":800,"height":900}})
                        )
                    ),
                ]
            );
        });
        crate::v1_case!("external-chrome-cdn-aacbc8a2ed2c", {
            let browser_calls = calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method.starts_with("Browser."))
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(browser_calls[0].0, "Browser.getWindowForTarget");
            assert_eq!(
                browser_calls[1].1.as_ref().unwrap()["bounds"]["windowState"],
                "normal"
            );
            assert_eq!(
                browser_calls[2].1.as_ref().unwrap()["bounds"],
                json!({"left":-1280,"top":-120,"width":800,"height":900})
            );
        });
    }

    fn make_target(cdp: Arc<ExternalChromeCdpSession>, platform: &str) -> ExternalTarget {
        ExternalTarget {
            cdp,
            execution_context_ids: RwLock::new(HashSet::new()),
            input: Mutex::new(InputState::default()),
            input_sequence: Mutex::new(()),
            overlay_source: RwLock::new(None),
            platform: platform.to_owned(),
        }
    }

    type RecordedCalls = Arc<StdMutex<Vec<(String, Option<Value>)>>>;

    fn recording_target(platform: &str) -> (ExternalTarget, RecordedCalls) {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let output = Arc::clone(&calls);
        let cdp = Arc::new(ExternalChromeCdpSession::test_session_with_handler(
            move |method, params| {
                output
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params.cloned()));
                Ok(match method {
                    "Page.getLayoutMetrics" => {
                        json!({"cssVisualViewport":{"clientWidth":1280.0,"clientHeight":720.0}})
                    }
                    "Browser.getWindowForTarget" => {
                        json!({"windowId":42,"bounds":{"windowState":"normal"}})
                    }
                    "Runtime.evaluate" => json!({"result":{"value":true}}),
                    _ => json!({}),
                })
            },
        ));
        (make_target(cdp, platform), calls)
    }

    fn input_params(calls: &RecordedCalls) -> Vec<Value> {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(method, params)| {
                (method == "Input.dispatchKeyEvent")
                    .then(|| params.clone())
                    .flatten()
            })
            .collect()
    }

    fn mouse_params(calls: &RecordedCalls) -> Vec<Value> {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(method, params)| {
                (method == "Input.dispatchMouseEvent")
                    .then(|| params.clone())
                    .flatten()
            })
            .collect()
    }

    fn action_request(request_id: &str, action: BrowserAction) -> BrowserActionRequest {
        BrowserActionRequest {
            request_id: request_id.to_owned(),
            role_id: "role-1".to_owned(),
            origin: "macro".to_owned(),
            scheduled_at_ms: epoch_millis(),
            deadline_ms: epoch_millis().saturating_add(10_000),
            action,
        }
    }

    fn input_types_and_codes(calls: &RecordedCalls) -> Vec<(String, String)> {
        input_params(calls)
            .into_iter()
            .filter_map(|params| {
                Some((
                    params.get("type")?.as_str()?.to_owned(),
                    params.get("code")?.as_str()?.to_owned(),
                ))
            })
            .collect()
    }

    fn methods(calls: &RecordedCalls) -> Vec<String> {
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect()
    }

    fn expressions(calls: &RecordedCalls) -> String {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(method, params)| {
                (method == "Runtime.evaluate")
                    .then(|| params.as_ref()?.get("expression")?.as_str())
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn key_down_count(calls: &RecordedCalls, code: &str) -> usize {
        input_params(calls)
            .iter()
            .filter(|params| {
                params["type"] == "rawKeyDown" && params["code"].as_str() == Some(code)
            })
            .count()
    }

    fn key_up_count(calls: &RecordedCalls, code: &str) -> usize {
        input_params(calls)
            .iter()
            .filter(|params| params["type"] == "keyUp" && params["code"].as_str() == Some(code))
            .count()
    }
}
