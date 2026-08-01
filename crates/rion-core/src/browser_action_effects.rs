use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};

use crossbeam_channel::{Receiver, Sender, bounded};

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserActionRequest, BrowserActionResult, CoreEffectAction, CoreEffectRequest,
        CoreEffectResult, CoreEffectTarget, CoreEffectTargetKind, CoreEvent,
    },
};

const ACTION_QUEUE_CAPACITY: usize = 128;
const EFFECT_OPERATION_PREFIX: &str = "browser-action:";

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;

pub fn action_queue() -> (
    Sender<Vec<BrowserActionRequest>>,
    Receiver<Vec<BrowserActionRequest>>,
) {
    bounded(ACTION_QUEUE_CAPACITY)
}

pub struct BrowserActionEffectRuntime {
    control: Sender<()>,
    join: Mutex<Option<JoinHandle<()>>>,
    stopped: AtomicBool,
}

impl BrowserActionEffectRuntime {
    pub fn start(
        actions: Receiver<Vec<BrowserActionRequest>>,
        events: EventSink,
    ) -> CoreResult<Self> {
        let (control, control_receiver) = bounded(1);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-browser-actions".to_owned())
            .spawn(move || {
                if ready_sender.send(Ok(())).is_err() {
                    return;
                }
                loop {
                    crossbeam_channel::select! {
                        recv(control_receiver) -> _ => break,
                        recv(actions) -> batch => {
                            let Ok(batch) = batch else { break };
                            if !batch.is_empty() {
                                events(vec![CoreEvent::CoreEffects {
                                    effects: batch.into_iter().map(effect_request).collect(),
                                }]);
                            }
                        }
                    }
                }
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        match ready_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = join.join();
                return Err(CoreError::Internal(error));
            }
            Err(_) => {
                let _ = join.join();
                return Err(CoreError::Internal(
                    "browser action worker stopped during startup".to_owned(),
                ));
            }
        }
        Ok(Self {
            control,
            join: Mutex::new(Some(join)),
            stopped: AtomicBool::new(false),
        })
    }

    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.control.try_send(());
        if let Ok(mut join) = self.join.lock()
            && let Some(join) = join.take()
        {
            let _ = join.join();
        }
    }
}

impl Drop for BrowserActionEffectRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn effect_operation_id(request_id: &str) -> String {
    format!("{EFFECT_OPERATION_PREFIX}{request_id}")
}

pub fn result_as_browser_action(result: CoreEffectResult) -> Option<BrowserActionResult> {
    let request_id = result.operation_id.strip_prefix(EFFECT_OPERATION_PREFIX)?;
    if request_id != result.effect_id {
        return None;
    }
    Some(BrowserActionResult {
        request_id: request_id.to_owned(),
        ok: result.ok,
        value_json: result.value_json,
        error_code: result.error.as_ref().map(|error| error.code.clone()),
        error_message: result.error.map(|error| error.message),
    })
}

fn effect_request(request: BrowserActionRequest) -> CoreEffectRequest {
    CoreEffectRequest {
        effect_id: request.request_id.clone(),
        operation_id: effect_operation_id(&request.request_id),
        target: CoreEffectTarget {
            kind: CoreEffectTargetKind::WebContents,
            handle_id: request.role_id.clone(),
        },
        deadline_ms: request.deadline_ms,
        action: CoreEffectAction::BrowserAction {
            request: Box::new(request),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CoreErrorPayload, model::BrowserAction};

    #[test]
    fn browser_effect_results_round_trip_without_a_specialized_protocol() {
        let request = BrowserActionRequest {
            request_id: "request-1".to_owned(),
            role_id: "role-1".to_owned(),
            origin: "macro".to_owned(),
            input_epoch: 0,
            intent: "normal".to_owned(),
            scheduled_at_ms: 10,
            deadline_ms: 20,
            action: BrowserAction::Focus,
        };
        let effect = effect_request(request);
        assert_eq!(effect.effect_id, "request-1");
        assert_eq!(effect.operation_id, "browser-action:request-1");
        assert!(matches!(
            effect.action,
            CoreEffectAction::BrowserAction { .. }
        ));

        let result = result_as_browser_action(CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "EMBEDDED_FAILED".to_owned(),
                message: "failed".to_owned(),
            }),
        })
        .unwrap();
        assert_eq!(result.request_id, "request-1");
        assert_eq!(result.error_code.as_deref(), Some("EMBEDDED_FAILED"));
    }

    #[test]
    fn rejects_forged_browser_effect_operation_ids() {
        assert!(
            result_as_browser_action(CoreEffectResult {
                effect_id: "request-2".to_owned(),
                operation_id: "browser-action:request-1".to_owned(),
                ok: true,
                value_json: None,
                error: None,
            })
            .is_none()
        );
    }
}
