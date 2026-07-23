use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
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
type PartitionedActions = (
    Vec<(BrowserActionRequest, Arc<ExternalTarget>)>,
    Vec<BrowserActionRequest>,
);

#[derive(Default)]
struct InputState {
    held_key_owners: HashMap<String, HashSet<String>>,
}

struct ExternalTarget {
    cdp: Arc<ExternalChromeCdpSession>,
    input: Mutex<InputState>,
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
                input: Mutex::new(InputState::default()),
                platform: self.platform.clone(),
            }),
        ) {
            previous.cdp.close();
        }
        Ok(())
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
        let (metrics, page, window) = tokio::join!(
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
                errors.push(format!("Performance.getMetrics: {error}"));
                None
            }
        };
        let page = match page {
            Ok(value) => value
                .get("result")
                .and_then(|result| result.get("value"))
                .cloned(),
            Err(error) => {
                errors.push(format!("Runtime.evaluate: {error}"));
                None
            }
        };
        let window = match window {
            Ok(value) => value.get("bounds").cloned(),
            Err(error) => {
                errors.push(format!("Browser.getWindowForTarget: {error}"));
                None
            }
        };
        Ok(json!({
            "capturedAt": chrono::Utc::now().to_rfc3339(),
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
        tokio::time::timeout(
            Duration::from_secs(2),
            target.cdp.send(
                "Runtime.evaluate".to_owned(),
                Some(json!({
                    "expression":"void window.__rionStudioMacroOverlay?.refresh?.()"
                })),
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
            BrowserAction::Focus => self.focus().await.map(|_| None),
            BrowserAction::Key {
                phase,
                key,
                code,
                modifiers,
                owner_id,
            } => self
                .key(
                    &phase,
                    code.as_deref().unwrap_or(&key),
                    &modifiers,
                    &owner_id,
                )
                .await
                .map(|_| None),
            BrowserAction::Click {
                anchor,
                unit,
                x,
                y,
                button,
            } => self
                .click(anchor.as_deref(), &unit, x, y, &button)
                .await
                .map(|_| None),
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
        self.cdp
            .send(
                "Runtime.evaluate".to_owned(),
                Some(json!({"expression":"globalThis.focus?.(); document.activeElement?.focus?.();"})),
                None,
                None,
            )
            .await?;
        Ok(())
    }

    async fn key(
        &self,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
    ) -> CoreResult<()> {
        let mut input = self.input.lock().await;
        let modifier_codes = resolve_modifier_codes(modifiers, &self.platform);
        match phase {
            "hold" => {
                for current in modifier_codes
                    .iter()
                    .chain(std::iter::once(&code.to_owned()))
                {
                    let existing = input
                        .held_key_owners
                        .get(current)
                        .is_some_and(|owners| !owners.is_empty());
                    input
                        .held_key_owners
                        .entry(current.clone())
                        .or_default()
                        .insert(owner_id.to_owned());
                    if !existing {
                        send_key(&self.cdp, "rawKeyDown", current, &input.held_key_owners).await?;
                    }
                }
            }
            "release" => {
                for current in
                    std::iter::once(code.to_owned()).chain(modifier_codes.into_iter().rev())
                {
                    let should_release =
                        if let Some(owners) = input.held_key_owners.get_mut(&current) {
                            owners.remove(owner_id);
                            owners.is_empty()
                        } else {
                            false
                        };
                    if should_release {
                        input.held_key_owners.remove(&current);
                        send_key(&self.cdp, "keyUp", &current, &input.held_key_owners).await?;
                    }
                }
            }
            "tap" => {
                let mut active = input.held_key_owners.clone();
                for modifier in &modifier_codes {
                    if !active.contains_key(modifier) {
                        active.insert(modifier.clone(), HashSet::new());
                        send_key(&self.cdp, "rawKeyDown", modifier, &active).await?;
                    }
                }
                send_key(&self.cdp, "rawKeyDown", code, &active).await?;
                send_key(&self.cdp, "keyUp", code, &active).await?;
                for modifier in modifier_codes.into_iter().rev() {
                    if !input.held_key_owners.contains_key(&modifier) {
                        active.remove(&modifier);
                        send_key(&self.cdp, "keyUp", &modifier, &active).await?;
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
) -> CoreResult<()> {
    let modifiers = modifier_mask(active.keys().map(String::as_str));
    let (key, virtual_key, location) = key_descriptor(code, modifiers);
    let mut params = json!({"type":event_type,"code":code,"key":key});
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
}
