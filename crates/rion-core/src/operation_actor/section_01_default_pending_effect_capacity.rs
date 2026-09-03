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
        CoreEffectAction, CoreEffectCancellationReason, CoreEffectCancellationRecord,
        CoreEffectDispatchReport, CoreEffectMetricsRecord, CoreEffectRequest, CoreEffectResult,
        CoreEffectTarget, OperationCompletionPolicy,
    },
};

const DEFAULT_PENDING_EFFECT_CAPACITY: usize = 512;
const DEFAULT_OPERATION_CAPACITY: usize = 128;
const COMPLETED_EFFECT_CAPACITY: usize = 1_024;

type EffectEmitter = Arc<dyn Fn(Vec<CoreEffectRequest>) + Send + Sync>;
type CancellationEmitter = Arc<dyn Fn(Vec<CoreEffectCancellationRecord>) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct OperationEffect {
    pub target: CoreEffectTarget,
    pub action: CoreEffectAction,
    pub timeout: Duration,
    pub compensate_on_rejected_result: bool,
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
    pub compensation_failures: Vec<OperationCompensationFailure>,
    pub error: Option<CoreErrorPayload>,
}

#[derive(Debug, Clone)]
pub struct OperationCompensationFailure {
    pub effect: OperationEffect,
    pub error: CoreErrorPayload,
}

pub struct OperationHandle {
    pub operation_id: String,
    pub outcome: oneshot::Receiver<OperationOutcome>,
    first_effect_dispatch: Option<oneshot::Receiver<Result<(), CoreErrorPayload>>>,
}

impl OperationHandle {
    /// Waits until this operation's first effect has passed through the effect
    /// emitter. Callers may then release their admission lane without allowing
    /// a later operation to overtake the emitted CoreEffects event.
    ///
    /// This fence does not wait for the native effect result. If the operation
    /// ends before emitting an effect, it returns that pre-dispatch failure.
    pub fn wait_for_first_effect_dispatch(&mut self) -> CoreResult<()> {
        let dispatch = self.first_effect_dispatch.take().ok_or_else(|| {
            CoreError::Internal("first effect dispatch fence was already consumed".to_owned())
        })?;
        match dispatch.blocking_recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(CoreError::Effect {
                code: error.code,
                message: error.message,
            }),
            Err(_) => Err(CoreError::Internal(
                "operation actor stopped before resolving its first effect dispatch fence"
                    .to_owned(),
            )),
        }
    }
}

pub struct OperationActor {
    inner: Arc<ActorInner>,
}

struct ActorInner {
    emit: EffectEmitter,
    emit_cancellations: CancellationEmitter,
    origin: Instant,
    pending_capacity: usize,
    operation_capacity: usize,
    state: Mutex<ActorState>,
}

#[derive(Default)]
struct ActorState {
    shutting_down: bool,
    pending: HashMap<String, PendingEffect>,
    operations: HashMap<String, ActiveOperation>,
    completed: HashMap<String, CompletedEffect>,
    completed_order: VecDeque<String>,
    peak_pending_effect_count: usize,
    emitted_effect_count: u64,
    acknowledged_effect_count: u64,
    effect_ack_latency_ms: VecDeque<f64>,
    launch_operation_count: u64,
    launch_effect_count: u64,
}

struct ActiveOperation {
    cancelled: Arc<AtomicBool>,
    kind: OperationKind,
}

struct PendingEffect {
    operation_id: String,
    deadline: Option<Instant>,
    enqueued_at: Instant,
    result: oneshot::Sender<CoreEffectResult>,
    dispatch_phase: PendingEffectDispatchPhase,
    cancellation_reason: Option<CoreEffectCancellationReason>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingEffectDispatchPhase {
    Emitting,
    Dispatched,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    General,
    Launch,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompletedEffect {
    Completed,
    TimedOut,
}

struct FirstEffectDispatchSignal {
    sender: Option<oneshot::Sender<Result<(), CoreErrorPayload>>>,
}

impl FirstEffectDispatchSignal {
    fn dispatched(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Ok(()));
        }
    }

    fn failed(&mut self, error: CoreErrorPayload) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Err(error));
        }
    }

    fn is_pending(&self) -> bool {
        self.sender.is_some()
    }
}

impl OperationActor {
    pub fn new(emit: EffectEmitter) -> Self {
        Self::with_capacity(
            emit,
            DEFAULT_PENDING_EFFECT_CAPACITY,
            DEFAULT_OPERATION_CAPACITY,
        )
    }

    pub fn new_with_cancellation_emitter(
        emit: EffectEmitter,
        emit_cancellations: CancellationEmitter,
    ) -> Self {
        Self::with_capacity_and_cancellation_emitter(
            emit,
            emit_cancellations,
            DEFAULT_PENDING_EFFECT_CAPACITY,
            DEFAULT_OPERATION_CAPACITY,
        )
    }

    fn with_capacity(
        emit: EffectEmitter,
        pending_capacity: usize,
        operation_capacity: usize,
    ) -> Self {
        Self::with_capacity_and_cancellation_emitter(
            emit,
            Arc::new(|_| {}),
            pending_capacity,
            operation_capacity,
        )
    }

    fn with_capacity_and_cancellation_emitter(
        emit: EffectEmitter,
        emit_cancellations: CancellationEmitter,
        pending_capacity: usize,
        operation_capacity: usize,
    ) -> Self {
        Self {
            inner: Arc::new(ActorInner {
                emit,
                emit_cancellations,
                origin: Instant::now(),
                pending_capacity: pending_capacity.max(1),
                operation_capacity: operation_capacity.max(1),
                state: Mutex::new(ActorState::default()),
            }),
        }
    }

    pub fn start(&self, plan: OperationPlan) -> CoreResult<OperationHandle> {
        self.start_with_kind(plan, OperationKind::General, None)
    }

    pub fn start_with_parent(
        &self,
        plan: OperationPlan,
        parent_operation_id: String,
    ) -> CoreResult<OperationHandle> {
        self.start_with_kind(plan, OperationKind::General, Some(parent_operation_id))
    }

    pub fn start_launch(&self, plan: OperationPlan) -> CoreResult<OperationHandle> {
        self.start_with_kind(plan, OperationKind::Launch, None)
    }

    fn start_with_kind(
        &self,
        plan: OperationPlan,
        kind: OperationKind,
        parent_operation_id: Option<String>,
    ) -> CoreResult<OperationHandle> {
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
            state.operations.insert(
                operation_id.clone(),
                ActiveOperation {
                    cancelled: Arc::clone(&cancelled),
                    kind,
                },
            );
            if kind == OperationKind::Launch {
                state.launch_operation_count = state.launch_operation_count.saturating_add(1);
            }
        }

        let (outcome_sender, outcome) = oneshot::channel();
        let (first_effect_dispatch_sender, first_effect_dispatch) = oneshot::channel();
        let actor = Arc::clone(&self.inner);
        let thread_operation_id = operation_id.clone();
        thread::Builder::new()
            .name(format!("rion-operation-{operation_id}"))
            .spawn(move || {
                let outcome = run_operation(
                    Arc::clone(&actor),
                    thread_operation_id.clone(),
                    parent_operation_id,
                    cancelled,
                    plan,
                    FirstEffectDispatchSignal {
                        sender: Some(first_effect_dispatch_sender),
                    },
                );
                if let Ok(mut state) = actor.state.lock() {
                    state.operations.remove(&thread_operation_id);
                }
                let _ = outcome_sender.send(outcome);
            })
            .map_err(|error| {
                if let Ok(mut state) = self.inner.state.lock()
                    && state
                        .operations
                        .remove(&operation_id)
                        .is_some_and(|operation| operation.kind == OperationKind::Launch)
                {
                    state.launch_operation_count = state.launch_operation_count.saturating_sub(1);
                }
                CoreError::Internal(format!("failed to start operation actor task: {error}"))
            })?;

        Ok(OperationHandle {
            operation_id,
            outcome,
            first_effect_dispatch: Some(first_effect_dispatch),
        })
    }

    pub fn cancel(&self, operation_id: &str) -> CoreResult<bool> {
        let cancellations = {
            let mut state = self.state()?;
            let Some(cancelled) = state
                .operations
                .get(operation_id)
                .map(|operation| Arc::clone(&operation.cancelled))
            else {
                return Ok(false);
            };
            cancelled.store(true, Ordering::Release);
            state
                .pending
                .iter_mut()
                .filter_map(|(effect_id, pending)| {
                    if pending.operation_id != operation_id
                        || pending.cancellation_reason.is_some()
                    {
                        return None;
                    }
                    pending.cancellation_reason =
                        Some(CoreEffectCancellationReason::OperationCancelled);
                    (pending.dispatch_phase == PendingEffectDispatchPhase::Dispatched).then(|| {
                        CoreEffectCancellationRecord {
                            effect_id: effect_id.clone(),
                            operation_id: operation_id.to_owned(),
                            reason: CoreEffectCancellationReason::OperationCancelled,
                        }
                    })
                })
                .collect::<Vec<_>>()
        };
        emit_cancellations(&self.inner, cancellations);
        Ok(true)
    }

    pub fn effect_is_pending(&self, effect_id: &str, operation_id: &str) -> CoreResult<bool> {
        let state = self.state()?;
        Ok(state.pending.get(effect_id).is_some_and(|pending| {
            pending.operation_id == operation_id
                && pending
                    .deadline
                    .is_none_or(|deadline| Instant::now() <= deadline)
        }))
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
                if pending
                    .deadline
                    .is_some_and(|deadline| Instant::now() > deadline)
                {
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
                            "The desktop shell effect result arrived after its deadline.",
                        ),
                    ))
                } else {
                    let pending = state
                        .pending
                        .remove(&effect_id)
                        .expect("pending effect exists");
                    record_effect_ack(&mut state, &pending);
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
                peak_pending_effect_count: 0,
                active_operation_count: 0,
                pending_effect_capacity: self.inner.pending_capacity as u32,
                operation_capacity: self.inner.operation_capacity as u32,
                emitted_effect_count: 0,
                acknowledged_effect_count: 0,
                effect_ack_latency: Default::default(),
                launch_operation_count: 0,
                launch_effect_count: 0,
            };
        };
        CoreEffectMetricsRecord {
            pending_effect_count: state.pending.len() as u32,
            peak_pending_effect_count: state.peak_pending_effect_count as u32,
            active_operation_count: state.operations.len() as u32,
            pending_effect_capacity: self.inner.pending_capacity as u32,
            operation_capacity: self.inner.operation_capacity as u32,
            emitted_effect_count: state.emitted_effect_count,
            acknowledged_effect_count: state.acknowledged_effect_count,
            effect_ack_latency: latency_summary(&state.effect_ack_latency_ms),
            launch_operation_count: state.launch_operation_count,
            launch_effect_count: state.launch_effect_count,
        }
    }

    pub fn shutdown(&self) {
        let cancellations = {
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
                .for_each(|operation| operation.cancelled.store(true, Ordering::Release));
            state.operations.clear();
            state
                .pending
                .iter_mut()
                .filter_map(|(effect_id, pending)| {
                    if pending.cancellation_reason.is_some() {
                        return None;
                    }
                    pending.cancellation_reason = Some(CoreEffectCancellationReason::ActorStopped);
                    (pending.dispatch_phase == PendingEffectDispatchPhase::Dispatched).then(|| {
                        CoreEffectCancellationRecord {
                            effect_id: effect_id.clone(),
                            operation_id: pending.operation_id.clone(),
                            reason: CoreEffectCancellationReason::ActorStopped,
                        }
                    })
                })
                .collect::<Vec<_>>()
        };
        emit_cancellations(&self.inner, cancellations);
    }

    fn state(&self) -> CoreResult<std::sync::MutexGuard<'_, ActorState>> {
        self.inner
            .state
            .lock()
            .map_err(|_| CoreError::Internal("operation actor lock poisoned".to_owned()))
    }
}

fn emit_cancellations(
    actor: &ActorInner,
    cancellations: Vec<CoreEffectCancellationRecord>,
) {
    if cancellations.is_empty() {
        return;
    }
    (actor.emit_cancellations)(cancellations);
}

fn run_operation(
    actor: Arc<ActorInner>,
    operation_id: String,
    parent_operation_id: Option<String>,
    cancelled: Arc<AtomicBool>,
    plan: OperationPlan,
    mut first_effect_dispatch: FirstEffectDispatchSignal,
) -> OperationOutcome {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build();
    let Ok(runtime) = runtime else {
        let error = CoreErrorPayload {
            code: "CORE_OPERATION_RUNTIME_FAILED".to_owned(),
            message: "The operation runtime could not be created.".to_owned(),
        };
        first_effect_dispatch.failed(error.clone());
        return OperationOutcome {
            operation_id,
            results: Vec::new(),
            compensation_results: Vec::new(),
            compensation_failures: Vec::new(),
            error: Some(error),
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
        let compensate_on_rejected_result = step.effect.compensate_on_rejected_result;
        match execute_effect(
            &runtime,
            Arc::clone(&actor),
            &operation_id,
            parent_operation_id.as_deref(),
            step.effect,
            first_effect_dispatch
                .is_pending()
                .then_some(&mut first_effect_dispatch),
        ) {
            Ok(result) if result.ok => {
                results.push(result);
                if let Some(compensation) = step.compensation {
                    compensations.push(compensation);
                }
            }
            Ok(result) => {
                if compensate_on_rejected_result
                    && let Some(compensation) = step.compensation
                {
                    compensations.push(compensation);
                }
                failure = result.error.clone().or_else(|| {
                    Some(CoreErrorPayload {
                        code: "CORE_EFFECT_FAILED".to_owned(),
                        message: "The desktop shell effect failed.".to_owned(),
                    })
                });
                results.push(result);
                break;
            }
            Err(error) => {
                // A transport timeout has indeterminate commit status, so retain the
                // compensation even for effects that explicitly rejected their own result.
                if let Some(compensation) = step.compensation {
                    compensations.push(compensation);
                }
                failure = Some(error.payload());
                break;
            }
        }
    }

    let mut compensation_results = Vec::new();
    let mut compensation_failures = Vec::new();
    if failure.is_some() {
        for compensation in compensations.into_iter().rev() {
            let recorded_effect = compensation.clone();
            match execute_effect(
                &runtime,
                Arc::clone(&actor),
                &operation_id,
                parent_operation_id.as_deref(),
                compensation,
                None,
            ) {
                Ok(result) => {
                    if !result.ok {
                        compensation_failures.push(OperationCompensationFailure {
                            effect: recorded_effect,
                            error: result.error.clone().unwrap_or_else(|| CoreErrorPayload {
                                code: "CORE_COMPENSATION_EFFECT_FAILED".to_owned(),
                                message: "The desktop shell compensation effect failed.".to_owned(),
                            }),
                        });
                    }
                    compensation_results.push(result);
                }
                Err(error) => {
                    compensation_failures.push(OperationCompensationFailure {
                        effect: recorded_effect,
                        error: error.payload(),
                    });
                }
            }
        }
    }

    if first_effect_dispatch.is_pending() {
        first_effect_dispatch.failed(failure.clone().unwrap_or_else(|| CoreErrorPayload {
            code: "CORE_OPERATION_NO_EFFECT_DISPATCHED".to_owned(),
            message: "The operation completed without dispatching an effect.".to_owned(),
        }));
    }

    OperationOutcome {
        operation_id,
        results,
        compensation_results,
        compensation_failures,
        error: failure,
    }
}

fn execute_effect(
    runtime: &tokio::runtime::Runtime,
    actor: Arc<ActorInner>,
    operation_id: &str,
    parent_operation_id: Option<&str>,
    effect: OperationEffect,
    mut first_effect_dispatch: Option<&mut FirstEffectDispatchSignal>,
) -> CoreResult<CoreEffectResult> {
    let completion_policy = effect.action.completion_policy();
    let timeout = effect.timeout.max(Duration::from_millis(1));
    let deadline = (completion_policy == OperationCompletionPolicy::DeadlineBound)
        .then(|| Instant::now() + timeout);
    let effect_id = Uuid::new_v4().to_string();
    let (result_sender, result) = oneshot::channel();
    let admission = (|| {
        let mut state = actor
            .state
            .lock()
            .map_err(|_| CoreError::Internal("operation actor lock poisoned".to_owned()))?;
        if state.shutting_down {
            return Err(CoreError::ShuttingDown);
        }
        if state
            .operations
            .get(operation_id)
            .is_none_or(|operation| operation.cancelled.load(Ordering::Acquire))
        {
            return Err(CoreError::Domain {
                code: "CORE_OPERATION_CANCELLED",
                message: "The core operation was cancelled before effect dispatch.".to_owned(),
            });
        }
        if state.pending.len() >= actor.pending_capacity {
            return Err(CoreError::Domain {
                code: "CORE_EFFECT_BACKPRESSURE",
                message: "The desktop shell effect queue is full.".to_owned(),
            });
        }
        state.pending.insert(
            effect_id.clone(),
            PendingEffect {
                operation_id: operation_id.to_owned(),
                deadline,
                enqueued_at: Instant::now(),
                result: result_sender,
                dispatch_phase: PendingEffectDispatchPhase::Emitting,
                cancellation_reason: None,
            },
        );
        state.emitted_effect_count = state.emitted_effect_count.saturating_add(1);
        if state
            .operations
            .get(operation_id)
            .is_some_and(|operation| operation.kind == OperationKind::Launch)
        {
            state.launch_effect_count = state.launch_effect_count.saturating_add(1);
        }
        state.peak_pending_effect_count = state.peak_pending_effect_count.max(state.pending.len());
        Ok(())
    })();
    if let Err(error) = admission {
        if let Some(dispatch) = first_effect_dispatch.as_deref_mut() {
            dispatch.failed(error.payload());
        }
        return Err(error);
    }
    let deadline_ms = (completion_policy == OperationCompletionPolicy::DeadlineBound).then(|| {
        actor
            .origin
            .elapsed()
            .saturating_add(timeout)
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    });
    (actor.emit)(vec![CoreEffectRequest {
        effect_id: effect_id.clone(),
        operation_id: operation_id.to_owned(),
        parent_operation_id: parent_operation_id.map(str::to_owned),
        target: effect.target,
        completion_policy,
        deadline_ms,
        action: effect.action,
    }]);
    let deferred_cancellation = {
        let mut state = actor
            .state
            .lock()
            .map_err(|_| CoreError::Internal("operation actor lock poisoned".to_owned()))?;
        state.pending.get_mut(&effect_id).and_then(|pending| {
            pending.dispatch_phase = PendingEffectDispatchPhase::Dispatched;
            pending
                .cancellation_reason
                .map(|reason| CoreEffectCancellationRecord {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.to_owned(),
                    reason,
                })
        })
    };
    if let Some(cancellation) = deferred_cancellation {
        emit_cancellations(&actor, vec![cancellation]);
    }
    if let Some(dispatch) = first_effect_dispatch {
        dispatch.dispatched();
    }

    match completion_policy {
        OperationCompletionPolicy::EventBound => runtime
            .block_on(result)
            .map_err(|_| CoreError::ShuttingDown),
        OperationCompletionPolicy::DeadlineBound => {
            match runtime.block_on(async move { tokio::time::timeout(timeout, result).await }) {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(_)) => Err(CoreError::ShuttingDown),
                Err(_) => {
                    let cancellation = if let Ok(mut state) = actor.state.lock()
                        && let Some(pending) = state.pending.remove(&effect_id)
                    {
                        remember_completed(
                            &mut state,
                            effect_id.clone(),
                            CompletedEffect::TimedOut,
                        );
                        pending.cancellation_reason.is_none().then(|| {
                            CoreEffectCancellationRecord {
                                effect_id: effect_id.clone(),
                                operation_id: operation_id.to_owned(),
                                reason: CoreEffectCancellationReason::DeadlineElapsed,
                            }
                        })
                    } else {
                        None
                    };
                    if let Some(cancellation) = cancellation {
                        emit_cancellations(&actor, vec![cancellation]);
                    }
                    Err(CoreError::Domain {
                        code: "CORE_EFFECT_TIMEOUT",
                        message: "The desktop shell effect timed out.".to_owned(),
                    })
                }
            }
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

const EFFECT_ACK_SAMPLE_CAPACITY: usize = 1_024;

fn record_effect_ack(state: &mut ActorState, pending: &PendingEffect) {
    state.acknowledged_effect_count = state.acknowledged_effect_count.saturating_add(1);
    if state.effect_ack_latency_ms.len() >= EFFECT_ACK_SAMPLE_CAPACITY {
        state.effect_ack_latency_ms.pop_front();
    }
    state
        .effect_ack_latency_ms
        .push_back(pending.enqueued_at.elapsed().as_secs_f64() * 1_000.0);
}

fn latency_summary(samples: &VecDeque<f64>) -> crate::model::LatencySummaryRecord {
    if samples.is_empty() {
        return Default::default();
    }
    let mut values = samples.iter().copied().collect::<Vec<_>>();
    values.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        let index = ((values.len() as f64 * fraction).ceil() as usize)
            .saturating_sub(1)
            .min(values.len().saturating_sub(1));
        values.get(index).copied().unwrap_or(0.0)
    };
    crate::model::LatencySummaryRecord {
        max_ms: values.last().copied().unwrap_or(0.0),
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        sample_count: values.len() as u32,
    }
}
