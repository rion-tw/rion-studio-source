use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, bounded};

use crate::{
    error::{CoreError, CoreResult},
    external_automation::ExternalAutomationRuntime,
    external_health::ExternalHealthRuntime,
    macro_runtime::MacroRuntime,
    model::{
        BrowserActionRequest, BrowserActionResult, CoreEffectAction, CoreEffectRequest,
        CoreEffectResult, CoreEffectTarget, CoreEvent,
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
        external: Arc<ExternalAutomationRuntime>,
        health: Arc<Mutex<ExternalHealthRuntime>>,
        macros: Arc<MacroRuntime>,
    ) -> CoreResult<Self> {
        let (control, control_receiver) = bounded(1);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-browser-actions".to_owned())
            .spawn(move || {
                let io_runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .thread_name("rion-browser-actions-io")
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_sender.send(Err(error.to_string()));
                        return;
                    }
                };
                if ready_sender.send(Ok(())).is_err() {
                    return;
                }
                loop {
                    crossbeam_channel::select! {
                        recv(control_receiver) -> _ => break,
                        recv(actions) -> batch => {
                            let Ok(batch) = batch else { break };
                            dispatch_batch(
                                batch,
                                &events,
                                &external,
                                &health,
                                &macros,
                                &io_runtime,
                            );
                        }
                    }
                }
                io_runtime.shutdown_timeout(Duration::from_secs(3));
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

fn dispatch_batch(
    batch: Vec<BrowserActionRequest>,
    events: &EventSink,
    external: &Arc<ExternalAutomationRuntime>,
    health: &Arc<Mutex<ExternalHealthRuntime>>,
    macros: &Arc<MacroRuntime>,
    io: &tokio::runtime::Runtime,
) {
    let (external_actions, unhandled) = match external.split_actions(batch.clone()) {
        Ok(partitioned) => partitioned,
        Err(_) => (Vec::new(), batch),
    };
    if !unhandled.is_empty() {
        events(vec![CoreEvent::CoreEffects {
            effects: unhandled.into_iter().map(effect_request).collect(),
        }]);
    }
    if external_actions.is_empty() {
        return;
    }
    let dispatch = io.block_on(external.dispatch(external_actions.clone()));
    let (results, unhandled) = match dispatch {
        Ok(dispatch) => (dispatch.results, dispatch.unhandled),
        Err(_) => (Vec::new(), external_actions),
    };
    if !results.is_empty() {
        dispatch_results(results, health, macros);
    }
    if !unhandled.is_empty() {
        events(vec![CoreEvent::CoreEffects {
            effects: unhandled.into_iter().map(effect_request).collect(),
        }]);
    }
}

fn dispatch_results(
    results: Vec<BrowserActionResult>,
    health: &Arc<Mutex<ExternalHealthRuntime>>,
    macros: &Arc<MacroRuntime>,
) {
    if let Ok(runtime) = health.lock() {
        runtime.dispatch_results(results.clone());
    }
    let _ = macros.dispatch_results(results);
}

fn effect_request(request: BrowserActionRequest) -> CoreEffectRequest {
    CoreEffectRequest {
        effect_id: request.request_id.clone(),
        operation_id: effect_operation_id(&request.request_id),
        target: CoreEffectTarget {
            kind: "webContents".to_owned(),
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
    use std::sync::atomic::AtomicBool;

    use super::*;
    use crate::{CoreErrorPayload, model::BrowserAction};

    #[test]
    fn browser_effect_results_round_trip_without_a_specialized_protocol() {
        let request = BrowserActionRequest {
            request_id: "request-1".to_owned(),
            role_id: "role-1".to_owned(),
            origin: "macro".to_owned(),
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

    #[test]
    fn mixed_batches_publish_embedded_effects_before_waiting_for_external_cdp() {
        let external_responded = Arc::new(AtomicBool::new(false));
        let external = Arc::new(ExternalAutomationRuntime::new("darwin".to_owned()));
        external
            .register(
                "external-role".to_owned(),
                Arc::new(crate::ExternalChromeCdpSession::test_session(
                    Duration::from_millis(50),
                    Arc::clone(&external_responded),
                )),
            )
            .unwrap();
        let effect_was_early = Arc::new(AtomicBool::new(false));
        let effect_was_early_output = Arc::clone(&effect_was_early);
        let external_responded_output = Arc::clone(&external_responded);
        let events: EventSink =
            Arc::new(move |events| {
                if events.iter().any(|event| matches!(
                event,
                CoreEvent::CoreEffects { effects }
                    if effects.iter().any(|effect| effect.target.handle_id == "embedded-role")
            )) && !external_responded_output.load(Ordering::Acquire)
            {
                effect_was_early_output.store(true, Ordering::Release);
            }
            });
        let health = Arc::new(Mutex::new(
            ExternalHealthRuntime::new(Arc::new(|_| {})).unwrap(),
        ));
        let macros = Arc::new(MacroRuntime::new(Arc::new(|_| {})));
        let io = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        dispatch_batch(
            vec![
                BrowserActionRequest {
                    request_id: "external".to_owned(),
                    role_id: "external-role".to_owned(),
                    origin: "macro".to_owned(),
                    scheduled_at_ms: 0,
                    deadline_ms: u64::MAX,
                    action: BrowserAction::Focus,
                },
                BrowserActionRequest {
                    request_id: "embedded".to_owned(),
                    role_id: "embedded-role".to_owned(),
                    origin: "macro".to_owned(),
                    scheduled_at_ms: 0,
                    deadline_ms: u64::MAX,
                    action: BrowserAction::Focus,
                },
            ],
            &events,
            &external,
            &health,
            &macros,
            &io,
        );
        crate::v1_case!("macro-33b99c83bf8e", {
            assert!(effect_was_early.load(Ordering::Acquire));
            assert!(external_responded.load(Ordering::Acquire));
        });
        health.lock().unwrap().shutdown();
        external.shutdown();
    }
}
