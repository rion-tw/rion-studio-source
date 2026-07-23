use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreErrorPayload, CoreResult},
    model::{
        CoreEffectAction, CoreEffectDispatchReport, CoreEffectMetricsRecord, CoreEffectRequest,
        CoreEffectResult, CoreEffectTarget,
    },
};

const DEFAULT_PENDING_EFFECT_CAPACITY: usize = 512;
const DEFAULT_OPERATION_CAPACITY: usize = 128;
const COMPLETED_EFFECT_CAPACITY: usize = 1_024;

type EffectEmitter = Arc<dyn Fn(Vec<CoreEffectRequest>) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct OperationEffect {
    pub target: CoreEffectTarget,
    pub action: CoreEffectAction,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct OperationStep {
    pub effect: OperationEffect,
    pub compensation: Option<OperationEffect>,
}

#[derive(Debug, Clone, Default)]
pub struct OperationPlan {
    pub steps: Vec<OperationStep>,
}

#[derive(Debug, Clone)]
pub struct OperationOutcome {
    pub operation_id: String,
    pub results: Vec<CoreEffectResult>,
    pub compensation_results: Vec<CoreEffectResult>,
    pub error: Option<CoreErrorPayload>,
}

pub struct OperationHandle {
    pub operation_id: String,
    pub outcome: oneshot::Receiver<OperationOutcome>,
}

pub struct OperationActor {
    inner: Arc<ActorInner>,
}

struct ActorInner {
    emit: EffectEmitter,
    origin: Instant,
    pending_capacity: usize,
    operation_capacity: usize,
    state: Mutex<ActorState>,
}

#[derive(Default)]
struct ActorState {
    shutting_down: bool,
    pending: HashMap<String, PendingEffect>,
    operations: HashMap<String, Arc<AtomicBool>>,
    completed: HashMap<String, CompletedEffect>,
    completed_order: VecDeque<String>,
}

struct PendingEffect {
    operation_id: String,
    deadline: Instant,
    result: oneshot::Sender<CoreEffectResult>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompletedEffect {
    Completed,
    TimedOut,
}

impl OperationActor {
    pub fn new(emit: EffectEmitter) -> Self {
        Self::with_capacity(
            emit,
            DEFAULT_PENDING_EFFECT_CAPACITY,
            DEFAULT_OPERATION_CAPACITY,
        )
    }

    fn with_capacity(
        emit: EffectEmitter,
        pending_capacity: usize,
        operation_capacity: usize,
    ) -> Self {
        Self {
            inner: Arc::new(ActorInner {
                emit,
                origin: Instant::now(),
                pending_capacity: pending_capacity.max(1),
                operation_capacity: operation_capacity.max(1),
                state: Mutex::new(ActorState::default()),
            }),
        }
    }

    pub fn start(&self, plan: OperationPlan) -> CoreResult<OperationHandle> {
        let operation_id = Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state()?;
            if state.shutting_down {
                return Err(CoreError::ShuttingDown);
            }
            if state.operations.len() >= self.inner.operation_capacity {
                return Err(CoreError::Domain {
                    code: "CORE_OPERATION_BACKPRESSURE",
                    message: "The core operation queue is full.".to_owned(),
                });
            }
            state
                .operations
                .insert(operation_id.clone(), Arc::clone(&cancelled));
        }

        let (outcome_sender, outcome) = oneshot::channel();
        let actor = Arc::clone(&self.inner);
        let thread_operation_id = operation_id.clone();
        thread::Builder::new()
            .name(format!("rion-operation-{operation_id}"))
            .spawn(move || {
                let outcome = run_operation(
                    Arc::clone(&actor),
                    thread_operation_id.clone(),
                    cancelled,
                    plan,
                );
                if let Ok(mut state) = actor.state.lock() {
                    state.operations.remove(&thread_operation_id);
                }
                let _ = outcome_sender.send(outcome);
            })
            .map_err(|error| {
                if let Ok(mut state) = self.inner.state.lock() {
                    state.operations.remove(&operation_id);
                }
                CoreError::Internal(format!("failed to start operation actor task: {error}"))
            })?;

        Ok(OperationHandle {
            operation_id,
            outcome,
        })
    }

    pub fn cancel(&self, operation_id: &str) -> CoreResult<bool> {
        let wake = {
            let mut state = self.state()?;
            let Some(cancelled) = state.operations.get(operation_id).cloned() else {
                return Ok(false);
            };
            cancelled.store(true, Ordering::Release);
            let effect_ids = state
                .pending
                .iter()
                .filter_map(|(effect_id, pending)| {
                    (pending.operation_id == operation_id).then_some(effect_id.clone())
                })
                .collect::<Vec<_>>();
            effect_ids
                .into_iter()
                .filter_map(|effect_id| {
                    let pending = state.pending.remove(&effect_id)?;
                    remember_completed(&mut state, effect_id.clone(), CompletedEffect::Completed);
                    Some((effect_id, pending))
                })
                .collect::<Vec<_>>()
        };
        for (effect_id, pending) in wake {
            let _ = pending.result.send(failed_result(
                effect_id,
                operation_id.to_owned(),
                "CORE_OPERATION_CANCELLED",
                "The core operation was cancelled.",
            ));
        }
        Ok(true)
    }

    pub fn dispatch_results(
        &self,
        results: Vec<CoreEffectResult>,
    ) -> CoreResult<CoreEffectDispatchReport> {
        let mut report = CoreEffectDispatchReport::default();
        for result in results {
            let effect_id = result.effect_id.clone();
            let dispatch = {
                let mut state = self.state()?;
                let Some(pending) = state.pending.get(&effect_id) else {
                    match state.completed.get(&effect_id) {
                        Some(CompletedEffect::TimedOut) => report.late.push(effect_id),
                        Some(CompletedEffect::Completed) => report.duplicate.push(effect_id),
                        None => report.unknown.push(effect_id),
                    }
                    continue;
                };
                if pending.operation_id != result.operation_id {
                    report.operation_mismatch.push(effect_id);
                    continue;
                }
                if Instant::now() > pending.deadline {
                    let pending = state
                        .pending
                        .remove(&effect_id)
                        .expect("pending effect exists");
                    remember_completed(&mut state, effect_id.clone(), CompletedEffect::TimedOut);
                    report.late.push(effect_id.clone());
                    Some((
                        pending,
                        failed_result(
                            effect_id,
                            result.operation_id,
                            "CORE_EFFECT_TIMEOUT",
                            "The Electron effect result arrived after its deadline.",
                        ),
                    ))
                } else {
                    let pending = state
                        .pending
                        .remove(&effect_id)
                        .expect("pending effect exists");
                    remember_completed(&mut state, effect_id.clone(), CompletedEffect::Completed);
                    report.accepted.push(effect_id);
                    Some((pending, result))
                }
            };
            if let Some((pending, result)) = dispatch {
                let _ = pending.result.send(result);
            }
        }
        Ok(report)
    }

    pub fn metrics(&self) -> CoreEffectMetricsRecord {
        let Ok(state) = self.inner.state.lock() else {
            return CoreEffectMetricsRecord {
                pending_effect_count: 0,
                active_operation_count: 0,
                pending_effect_capacity: self.inner.pending_capacity as u32,
                operation_capacity: self.inner.operation_capacity as u32,
            };
        };
        CoreEffectMetricsRecord {
            pending_effect_count: state.pending.len() as u32,
            active_operation_count: state.operations.len() as u32,
            pending_effect_capacity: self.inner.pending_capacity as u32,
            operation_capacity: self.inner.operation_capacity as u32,
        }
    }

    pub fn shutdown(&self) {
        let wake = {
            let Ok(mut state) = self.inner.state.lock() else {
                return;
            };
            if state.shutting_down {
                return;
            }
            state.shutting_down = true;
            state
                .operations
                .values()
                .for_each(|cancelled| cancelled.store(true, Ordering::Release));
            let pending = state.pending.drain().collect::<Vec<_>>();
            for (effect_id, _) in &pending {
                remember_completed(&mut state, effect_id.clone(), CompletedEffect::Completed);
            }
            pending
        };
        for (effect_id, pending) in wake {
            let operation_id = pending.operation_id.clone();
            let _ = pending.result.send(failed_result(
                effect_id,
                operation_id,
                "CORE_SHUTTING_DOWN",
                "The core is shutting down.",
            ));
        }
    }

    fn state(&self) -> CoreResult<std::sync::MutexGuard<'_, ActorState>> {
        self.inner
            .state
            .lock()
            .map_err(|_| CoreError::Internal("operation actor lock poisoned".to_owned()))
    }
}

fn run_operation(
    actor: Arc<ActorInner>,
    operation_id: String,
    cancelled: Arc<AtomicBool>,
    plan: OperationPlan,
) -> OperationOutcome {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build();
    let Ok(runtime) = runtime else {
        return OperationOutcome {
            operation_id,
            results: Vec::new(),
            compensation_results: Vec::new(),
            error: Some(CoreErrorPayload {
                code: "CORE_OPERATION_RUNTIME_FAILED".to_owned(),
                message: "The operation runtime could not be created.".to_owned(),
            }),
        };
    };
    let mut results = Vec::new();
    let mut compensations = Vec::new();
    let mut failure = None;

    for step in plan.steps {
        if cancelled.load(Ordering::Acquire) {
            failure = Some(CoreErrorPayload {
                code: "CORE_OPERATION_CANCELLED".to_owned(),
                message: "The core operation was cancelled.".to_owned(),
            });
            break;
        }
        match execute_effect(&runtime, Arc::clone(&actor), &operation_id, step.effect) {
            Ok(result) if result.ok => {
                results.push(result);
                if let Some(compensation) = step.compensation {
                    compensations.push(compensation);
                }
            }
            Ok(result) => {
                failure = result.error.clone().or_else(|| {
                    Some(CoreErrorPayload {
                        code: "CORE_EFFECT_FAILED".to_owned(),
                        message: "The Electron effect failed.".to_owned(),
                    })
                });
                results.push(result);
                break;
            }
            Err(error) => {
                failure = Some(error.payload());
                break;
            }
        }
    }

    let mut compensation_results = Vec::new();
    if failure.is_some() {
        for compensation in compensations.into_iter().rev() {
            if let Ok(result) =
                execute_effect(&runtime, Arc::clone(&actor), &operation_id, compensation)
            {
                compensation_results.push(result);
            }
        }
    }

    OperationOutcome {
        operation_id,
        results,
        compensation_results,
        error: failure,
    }
}

fn execute_effect(
    runtime: &tokio::runtime::Runtime,
    actor: Arc<ActorInner>,
    operation_id: &str,
    effect: OperationEffect,
) -> CoreResult<CoreEffectResult> {
    let timeout = effect.timeout.max(Duration::from_millis(1));
    let deadline = Instant::now() + timeout;
    let effect_id = Uuid::new_v4().to_string();
    let (result_sender, result) = oneshot::channel();
    {
        let mut state = actor
            .state
            .lock()
            .map_err(|_| CoreError::Internal("operation actor lock poisoned".to_owned()))?;
        if state.shutting_down {
            return Err(CoreError::ShuttingDown);
        }
        if state.pending.len() >= actor.pending_capacity {
            return Err(CoreError::Domain {
                code: "CORE_EFFECT_BACKPRESSURE",
                message: "The Electron effect queue is full.".to_owned(),
            });
        }
        state.pending.insert(
            effect_id.clone(),
            PendingEffect {
                operation_id: operation_id.to_owned(),
                deadline,
                result: result_sender,
            },
        );
    }
    let deadline_ms = actor
        .origin
        .elapsed()
        .saturating_add(timeout)
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    (actor.emit)(vec![CoreEffectRequest {
        effect_id: effect_id.clone(),
        operation_id: operation_id.to_owned(),
        target: effect.target,
        deadline_ms,
        action: effect.action,
    }]);

    match runtime.block_on(async move { tokio::time::timeout(timeout, result).await }) {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Err(CoreError::ShuttingDown),
        Err(_) => {
            if let Ok(mut state) = actor.state.lock()
                && state.pending.remove(&effect_id).is_some()
            {
                remember_completed(&mut state, effect_id, CompletedEffect::TimedOut);
            }
            Err(CoreError::Domain {
                code: "CORE_EFFECT_TIMEOUT",
                message: "The Electron effect timed out.".to_owned(),
            })
        }
    }
}

fn failed_result(
    effect_id: String,
    operation_id: String,
    code: &str,
    message: &str,
) -> CoreEffectResult {
    CoreEffectResult {
        effect_id,
        operation_id,
        ok: false,
        value_json: None,
        error: Some(CoreErrorPayload {
            code: code.to_owned(),
            message: message.to_owned(),
        }),
    }
}

fn remember_completed(state: &mut ActorState, effect_id: String, completion: CompletedEffect) {
    state.completed.insert(effect_id.clone(), completion);
    state.completed_order.push_back(effect_id);
    while state.completed_order.len() > COMPLETED_EFFECT_CAPACITY {
        if let Some(expired) = state.completed_order.pop_front() {
            state.completed.remove(&expired);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use serde_json::json;

    use super::*;

    fn target() -> CoreEffectTarget {
        CoreEffectTarget {
            kind: "view".to_owned(),
            handle_id: "view-1".to_owned(),
        }
    }

    fn effect(action: CoreEffectAction) -> OperationEffect {
        OperationEffect {
            target: target(),
            action,
            timeout: Duration::from_secs(1),
        }
    }

    fn actor() -> (OperationActor, mpsc::Receiver<Vec<CoreEffectRequest>>) {
        let (sender, receiver) = mpsc::channel();
        (
            OperationActor::new(Arc::new(move |effects| {
                sender.send(effects).expect("effect receiver");
            })),
            receiver,
        )
    }

    fn success(request: &CoreEffectRequest) -> CoreEffectResult {
        CoreEffectResult {
            effect_id: request.effect_id.clone(),
            operation_id: request.operation_id.clone(),
            ok: true,
            value_json: Some(json!({ "loaded": true }).to_string()),
            error: None,
        }
    }

    #[test]
    fn waits_for_effect_results_without_blocking_event_delivery() {
        let (actor, effects) = actor();
        let handle = actor
            .start(OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::LoadUrl {
                        url: "https://example.test".to_owned(),
                    }),
                    compensation: None,
                }],
            })
            .unwrap();
        let batch = effects.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(batch.len(), 1);
        let report = actor.dispatch_results(vec![success(&batch[0])]).unwrap();
        assert_eq!(report.accepted, vec![batch[0].effect_id.clone()]);
        let outcome = handle.outcome.blocking_recv().unwrap();
        assert!(outcome.error.is_none());
        assert_eq!(outcome.results.len(), 1);
    }

    #[test]
    fn classifies_duplicate_unknown_late_and_operation_mismatch_results() {
        let (actor, effects) = actor();
        let handle = actor
            .start(OperationPlan {
                steps: vec![OperationStep {
                    effect: OperationEffect {
                        timeout: Duration::from_millis(20),
                        ..effect(CoreEffectAction::Focus)
                    },
                    compensation: None,
                }],
            })
            .unwrap();
        let request = effects
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        let mismatch = CoreEffectResult {
            operation_id: "another-operation".to_owned(),
            ..success(&request)
        };
        let report = actor.dispatch_results(vec![mismatch]).unwrap();
        assert_eq!(report.operation_mismatch, vec![request.effect_id.clone()]);
        thread::sleep(Duration::from_millis(30));
        let report = actor.dispatch_results(vec![success(&request)]).unwrap();
        assert_eq!(report.late, vec![request.effect_id.clone()]);
        let outcome = handle.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_EFFECT_TIMEOUT")
        );
        let report = actor
            .dispatch_results(vec![
                success(&request),
                CoreEffectResult {
                    effect_id: "missing-effect".to_owned(),
                    operation_id: request.operation_id,
                    ok: true,
                    value_json: None,
                    error: None,
                },
            ])
            .unwrap();
        assert_eq!(report.late, vec![request.effect_id]);
        assert_eq!(report.unknown, vec!["missing-effect"]);
    }

    #[test]
    fn runs_compensations_in_reverse_after_a_failed_effect() {
        let (actor, effects) = actor();
        let handle = actor
            .start(OperationPlan {
                steps: vec![
                    OperationStep {
                        effect: effect(CoreEffectAction::SetVisible { visible: true }),
                        compensation: Some(effect(CoreEffectAction::SetVisible { visible: false })),
                    },
                    OperationStep {
                        effect: effect(CoreEffectAction::LoadUrl {
                            url: "https://failure.test".to_owned(),
                        }),
                        compensation: None,
                    },
                ],
            })
            .unwrap();
        let first = effects
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        actor.dispatch_results(vec![success(&first)]).unwrap();
        let second = effects
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        actor
            .dispatch_results(vec![CoreEffectResult {
                effect_id: second.effect_id,
                operation_id: second.operation_id,
                ok: false,
                value_json: None,
                error: Some(CoreErrorPayload {
                    code: "ELECTRON_LOAD_FAILED".to_owned(),
                    message: "load failed".to_owned(),
                }),
            }])
            .unwrap();
        let compensation = effects
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        assert!(matches!(
            compensation.action,
            CoreEffectAction::SetVisible { visible: false }
        ));
        actor
            .dispatch_results(vec![success(&compensation)])
            .unwrap();
        let outcome = handle.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("ELECTRON_LOAD_FAILED")
        );
        assert_eq!(outcome.compensation_results.len(), 1);
    }

    #[test]
    fn cancellation_and_shutdown_release_pending_oneshots() {
        let (actor, effects) = actor();
        let cancelled = actor
            .start(OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::Focus),
                    compensation: None,
                }],
            })
            .unwrap();
        let _ = effects.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(actor.cancel(&cancelled.operation_id).unwrap());
        let outcome = cancelled.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_OPERATION_CANCELLED")
        );

        let shutting_down = actor
            .start(OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::Focus),
                    compensation: None,
                }],
            })
            .unwrap();
        let _ = effects.recv_timeout(Duration::from_secs(1)).unwrap();
        actor.shutdown();
        let outcome = shutting_down.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_SHUTTING_DOWN")
        );
        assert!(matches!(
            actor.start(OperationPlan::default()),
            Err(CoreError::ShuttingDown)
        ));
    }

    #[test]
    fn bounds_pending_effects_and_active_operations() {
        let (sender, receiver) = mpsc::channel();
        let actor = OperationActor::with_capacity(
            Arc::new(move |effects| sender.send(effects).unwrap()),
            1,
            1,
        );
        let handle = actor
            .start(OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::Focus),
                    compensation: None,
                }],
            })
            .unwrap();
        let _ = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            actor.start(OperationPlan::default()),
            Err(CoreError::Domain {
                code: "CORE_OPERATION_BACKPRESSURE",
                ..
            })
        ));
        let metrics = actor.metrics();
        assert_eq!(metrics.pending_effect_count, 1);
        assert_eq!(metrics.active_operation_count, 1);
        actor.shutdown();
        let _ = handle.outcome.blocking_recv().unwrap();
    }
}
