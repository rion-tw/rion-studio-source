use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::Utc;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        BrowserAction, BrowserActionRequest, BrowserActionResult, CoreEvent, MacroDefinition,
        MacroLastClick, MacroPressRequest, MacroReleaseRequest, MacroRepeat, MacroRunStatus,
        MacroRuntimeSettings, MacroStartRequest, MacroStepDefinition,
    },
};

const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ACTIVE_INVOCATIONS: usize = 64;
const MAX_PENDING_ACTIONS: usize = 512;

type EventSink = Arc<dyn Fn(Vec<CoreEvent>) + Send + Sync>;

#[derive(Clone)]
pub struct MacroRuntime {
    shared: Arc<Shared>,
}

struct Shared {
    events: EventSink,
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::SyncSender<BrowserActionResult>>>,
    shutting_down: AtomicBool,
}

#[derive(Default)]
struct Inner {
    invocations: HashMap<String, Arc<InvocationControl>>,
    leases: HashMap<String, HeldLease>,
    early_releases: HashMap<String, String>,
    statuses: HashMap<String, MacroRunStatus>,
}

struct HeldLease {
    invocation_id: String,
    press_id: String,
}

struct InvocationControl {
    cancelled: AtomicBool,
    first_iteration_completed: AtomicBool,
    finished: (Mutex<bool>, Condvar),
    id: String,
    macro_ids: Mutex<HashSet<String>>,
    stop_after_first_iteration: AtomicBool,
    wake: (Mutex<()>, Condvar),
}

#[derive(Clone)]
struct ExecutionContext {
    active_role_ids: Arc<HashSet<String>>,
    control: Arc<InvocationControl>,
    macros: Arc<HashMap<String, MacroDefinition>>,
    settings: MacroRuntimeSettings,
}

struct HeldKey {
    code: String,
    modifiers: Vec<String>,
    owner_id: String,
    role_id: String,
}

impl MacroRuntime {
    pub fn new(events: EventSink) -> Self {
        Self {
            shared: Arc::new(Shared {
                events,
                inner: Mutex::new(Inner::default()),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
            }),
        }
    }

    pub fn start(&self, request: MacroStartRequest) -> CoreResult<Vec<MacroRunStatus>> {
        self.start_internal(request).map(|(statuses, _)| statuses)
    }

    pub fn press(&self, request: MacroPressRequest) -> CoreResult<Vec<MacroRunStatus>> {
        validate_press_id(&request.press_id)?;
        let source_role_id = request
            .start
            .role_id
            .as_deref()
            .ok_or_else(|| CoreError::InvalidInput("macro press requires roleId".to_owned()))?;
        let lease_key = lease_key(source_role_id, &request.start.macro_id);
        let release_key =
            early_release_key(source_role_id, &request.start.macro_id, &request.press_id);
        let early_release = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .early_releases
            .remove(&release_key);
        if early_release.as_deref() == Some("immediate") {
            return Ok(Vec::new());
        }
        {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if let Some(existing) = inner.leases.get(&lease_key) {
                if existing.press_id == request.press_id {
                    return Ok(inner
                        .statuses
                        .values()
                        .filter(|status| status.macro_id == request.start.macro_id)
                        .cloned()
                        .collect());
                }
                return Err(CoreError::InvalidInput(
                    "macro shortcut is already held for this role".to_owned(),
                ));
            }
        }
        let macro_definition = request
            .start
            .macros
            .iter()
            .find(|definition| definition.id == request.start.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        if macro_definition
            .activation_mode
            .as_deref()
            .unwrap_or("toggle")
            != "while_held"
        {
            return Err(CoreError::InvalidInput(
                "macro does not use while-held activation".to_owned(),
            ));
        }
        let macro_id = request.start.macro_id.clone();
        let press_id = request.press_id;
        let (statuses, control) = self.start_internal(request.start)?;
        if early_release.as_deref() == Some("complete_first_iteration") {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
        }
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .leases
            .insert(
                lease_key,
                HeldLease {
                    invocation_id: control.id.clone(),
                    press_id,
                },
            );
        let _ = macro_id;
        Ok(statuses)
    }

    pub fn release(&self, request: MacroReleaseRequest) -> CoreResult<()> {
        validate_press_id(&request.press_id)?;
        if !matches!(
            request.mode.as_str(),
            "complete_first_iteration" | "immediate"
        ) {
            return Err(CoreError::InvalidInput(
                "macro release mode is invalid".to_owned(),
            ));
        }
        let key = lease_key(&request.role_id, &request.macro_id);
        let control = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let Some(lease) = inner.leases.get(&key) else {
                inner.early_releases.insert(
                    early_release_key(&request.role_id, &request.macro_id, &request.press_id),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            };
            if lease.press_id != request.press_id {
                inner.early_releases.insert(
                    early_release_key(&request.role_id, &request.macro_id, &request.press_id),
                    request.mode,
                );
                trim_early_releases(&mut inner.early_releases);
                return Ok(());
            }
            let invocation_id = lease.invocation_id.clone();
            inner.leases.remove(&key);
            inner.invocations.get(&invocation_id).cloned()
        };
        let Some(control) = control else {
            return Ok(());
        };
        if request.mode == "immediate" || control.first_iteration_completed.load(Ordering::Acquire)
        {
            cancel_control(&control);
            wait_finished(&control);
        } else {
            control
                .stop_after_first_iteration
                .store(true, Ordering::Release);
        }
        Ok(())
    }

    pub fn stop_macro(&self, macro_id: &str) -> CoreResult<()> {
        let controls = self.controls_matching(|control| {
            control
                .macro_ids
                .lock()
                .is_ok_and(|ids| ids.contains(macro_id))
        })?;
        cancel_and_wait_all(&controls);
        self.remove_statuses(|status| status.macro_id == macro_id)?;
        Ok(())
    }

    pub fn stop_role(&self, role_id: &str) -> CoreResult<()> {
        let invocation_ids = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .iter()
            .filter(|(_, status)| status.role_id == role_id)
            .filter_map(|(key, _)| key.split('|').next().map(str::to_owned))
            .collect::<HashSet<_>>();
        let controls = self.controls_matching(|control| invocation_ids.contains(&control.id))?;
        cancel_and_wait_all(&controls);
        self.remove_statuses(|status| status.role_id == role_id)?;
        Ok(())
    }

    pub fn release_role(&self, role_id: &str) -> CoreResult<()> {
        let releases = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner
                .leases
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{role_id}|")))
                .map(|(key, lease)| (key.clone(), lease.invocation_id.clone()))
                .collect::<Vec<_>>()
        };
        let controls = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            releases
                .into_iter()
                .filter_map(|(key, invocation_id)| {
                    inner.leases.remove(&key);
                    inner.invocations.get(&invocation_id).cloned()
                })
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls);
        Ok(())
    }

    pub fn statuses(&self) -> CoreResult<Vec<MacroRunStatus>> {
        let mut statuses = self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .values()
            .cloned()
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.role_id.cmp(&right.role_id))
                .then_with(|| left.macro_id.cmp(&right.macro_id))
        });
        Ok(statuses)
    }

    pub fn dispatch_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        for result in results {
            validate_result(&result)?;
            if let Some(sender) = self
                .shared
                .pending
                .lock()
                .map_err(|_| CoreError::Internal("macro result lock poisoned".to_owned()))?
                .remove(&result.request_id)
            {
                let _ = sender.send(result);
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if self.shared.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let controls = self
            .shared
            .inner
            .lock()
            .map(|inner| inner.invocations.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        cancel_and_wait_all(&controls);
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.invocations.clear();
            inner.leases.clear();
            inner.statuses.clear();
        }
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.clear();
        }
    }

    fn start_internal(
        &self,
        request: MacroStartRequest,
    ) -> CoreResult<(Vec<MacroRunStatus>, Arc<InvocationControl>)> {
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        validate_start_request(&request)?;
        let macros = request
            .macros
            .into_iter()
            .map(|definition| (definition.id.clone(), definition))
            .collect::<HashMap<_, _>>();
        let root = macros
            .get(&request.macro_id)
            .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
        if !root.enabled {
            return Err(CoreError::InvalidInput(
                "enable the macro before running it".to_owned(),
            ));
        }
        if let Some(role_id) = &request.role_id
            && !root.role_ids.contains(role_id)
        {
            return Err(CoreError::InvalidInput(
                "macro is not assigned to the requested role".to_owned(),
            ));
        }
        let active_role_ids = request.active_role_ids.into_iter().collect::<HashSet<_>>();
        let roles = assigned_active_roles(root, &active_role_ids);
        if roles.is_empty() {
            return Err(CoreError::InvalidInput(
                "launch at least one assigned role before running a macro".to_owned(),
            ));
        }
        let invocation_number = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let invocation_id = format!("macro-invocation-{invocation_number}");
        let control = Arc::new(InvocationControl {
            cancelled: AtomicBool::new(false),
            first_iteration_completed: AtomicBool::new(false),
            finished: (Mutex::new(false), Condvar::new()),
            id: invocation_id.clone(),
            macro_ids: Mutex::new(HashSet::from([request.macro_id.clone()])),
            stop_after_first_iteration: AtomicBool::new(false),
            wake: (Mutex::new(()), Condvar::new()),
        });
        let started_at = Utc::now().to_rfc3339();
        let statuses = roles
            .iter()
            .map(|role_id| MacroRunStatus {
                role_id: role_id.clone(),
                macro_id: request.macro_id.clone(),
                state: "running".to_owned(),
                iteration: Some(0),
                last_click: None,
                started_at: started_at.clone(),
                updated_at: started_at.clone(),
                error: None,
            })
            .collect::<Vec<_>>();
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            if inner.invocations.len() >= MAX_ACTIVE_INVOCATIONS {
                return Err(CoreError::InvalidInput(
                    "too many macro invocations are active".to_owned(),
                ));
            }
            if inner.statuses.values().any(|status| {
                status.macro_id == request.macro_id
                    && roles.iter().any(|role_id| role_id == &status.role_id)
                    && matches!(status.state.as_str(), "running" | "stopping")
            }) {
                return Err(CoreError::InvalidInput(
                    "macro is already running for this role".to_owned(),
                ));
            }
            inner
                .statuses
                .retain(|_, status| status.macro_id != request.macro_id);
            for status in &statuses {
                inner.statuses.insert(
                    status_key(&invocation_id, &status.role_id, &status.macro_id),
                    status.clone(),
                );
            }
            inner
                .invocations
                .insert(invocation_id.clone(), Arc::clone(&control));
        }
        self.emit_statuses();
        let shared = Arc::clone(&self.shared);
        let macro_id = request.macro_id;
        let context = ExecutionContext {
            active_role_ids: Arc::new(active_role_ids),
            control: Arc::clone(&control),
            macros: Arc::new(macros),
            settings: request.settings,
        };
        thread::Builder::new()
            .name(format!("rion-macro-{invocation_number}"))
            .spawn(move || {
                let result =
                    execute_macro(&shared, &context, &macro_id, &roles, &mut Vec::new(), true);
                finish_invocation(&shared, &context.control, result);
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok((statuses, control))
    }

    fn controls_matching(
        &self,
        predicate: impl Fn(&InvocationControl) -> bool,
    ) -> CoreResult<Vec<Arc<InvocationControl>>> {
        Ok(self
            .shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .invocations
            .values()
            .filter(|control| predicate(control))
            .cloned()
            .collect())
    }

    fn remove_statuses(&self, predicate: impl Fn(&MacroRunStatus) -> bool) -> CoreResult<()> {
        self.shared
            .inner
            .lock()
            .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?
            .statuses
            .retain(|_, status| !predicate(status));
        self.emit_statuses();
        Ok(())
    }

    fn emit_statuses(&self) {
        emit_statuses(&self.shared);
    }
}

fn execute_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    ancestry: &mut Vec<String>,
    root: bool,
) -> Result<(), String> {
    check_cancelled(context)?;
    if ancestry.iter().any(|id| id == macro_id) {
        return Err("macro dependency cycle detected while running".to_owned());
    }
    let definition = context
        .macros
        .get(macro_id)
        .ok_or_else(|| format!("called macro was not found: {macro_id}"))?;
    if !definition.enabled {
        return Err(format!("called macro is disabled: {}", definition.name));
    }
    let roles = if root {
        roles.to_vec()
    } else {
        assigned_active_roles(definition, &context.active_role_ids)
    };
    if roles.is_empty() {
        return Err(format!(
            "called macro has no running assigned role: {}",
            definition.name
        ));
    }
    ancestry.push(macro_id.to_owned());
    if let Ok(mut ids) = context.control.macro_ids.lock() {
        ids.insert(macro_id.to_owned());
    }
    if !root {
        add_running_statuses(shared, context, macro_id, &roles);
    }
    let mut held_keys = Vec::new();
    let applies_timing = definition.trigger.is_some();
    let execution = (|| {
        perform_actions(
            shared,
            context,
            roles
                .iter()
                .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
                .collect(),
            false,
        )?;
        if applies_timing {
            wait_cancelable(context, context.settings.startup_delay_ms)?;
        }
        let mut iteration = 0_u32;
        loop {
            check_cancelled(context)?;
            for step in &definition.steps {
                execute_step(
                    shared,
                    context,
                    definition,
                    &roles,
                    step,
                    ancestry,
                    &mut held_keys,
                )?;
            }
            iteration = iteration.saturating_add(1);
            update_iteration(shared, context, macro_id, &roles, iteration);
            if root && iteration == 1 {
                context
                    .control
                    .first_iteration_completed
                    .store(true, Ordering::Release);
            }
            if context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
                || matches!(definition.repeat, MacroRepeat::Once)
            {
                break;
            }
            let MacroRepeat::Loop { interval_ms } = definition.repeat else {
                break;
            };
            wait_cancelable(context, interval_ms)?;
        }
        if matches!(definition.repeat, MacroRepeat::Once)
            && !held_keys.is_empty()
            && !context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
        {
            wait_until_cancelled(context)?;
        }
        Ok(())
    })();
    release_held_keys(shared, context, &mut held_keys);
    ancestry.pop();
    if !root && execution.is_ok() {
        remove_macro_statuses(shared, &context.control.id, macro_id);
    }
    execution
}

fn execute_step(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    definition: &MacroDefinition,
    roles: &[String],
    step: &MacroStepDefinition,
    ancestry: &mut Vec<String>,
    held_keys: &mut Vec<HeldKey>,
) -> Result<(), String> {
    check_cancelled(context)?;
    match step {
        MacroStepDefinition::Key {
            id,
            code,
            modifiers,
            action,
        } => {
            let holds = roles
                .iter()
                .map(|role_id| {
                    let owner_id = format!(
                        "{}:{}:{}:{}",
                        context.control.id, role_id, definition.id, id
                    );
                    (
                        role_id.as_str(),
                        BrowserAction::Key {
                            phase: "hold".to_owned(),
                            key: code.clone(),
                            code: Some(code.clone()),
                            modifiers: modifiers.clone(),
                            owner_id,
                        },
                    )
                })
                .collect::<Vec<_>>();
            perform_actions(shared, context, holds, false)?;
            for role_id in roles {
                let owner_id = format!(
                    "{}:{}:{}:{}",
                    context.control.id, role_id, definition.id, id
                );
                if action.as_deref() == Some("hold_until_stop") {
                    held_keys.push(HeldKey {
                        code: code.clone(),
                        modifiers: modifiers.clone(),
                        owner_id,
                        role_id: role_id.clone(),
                    });
                } else {
                    let _ = owner_id;
                }
            }
            if action.as_deref() != Some("hold_until_stop") {
                wait_cancelable(context, context.settings.key_hold_ms)?;
                perform_actions(
                    shared,
                    context,
                    roles
                        .iter()
                        .map(|role_id| {
                            (
                                role_id.as_str(),
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.clone(),
                                    owner_id: format!(
                                        "{}:{}:{}:{}",
                                        context.control.id, role_id, definition.id, id
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                )?;
            }
            wait_cancelable(context, context.settings.post_input_delay_ms)
        }
        MacroStepDefinition::Click {
            id,
            unit,
            anchor,
            x_percent,
            y_percent,
            x_px,
            y_px,
        } => {
            let uses_pixels = unit.as_deref() == Some("px");
            let (x, y) = if uses_pixels {
                (
                    x_px.ok_or_else(|| "pixel click requires xPx".to_owned())?,
                    y_px.ok_or_else(|| "pixel click requires yPx".to_owned())?,
                )
            } else {
                (
                    x_percent.ok_or_else(|| "percent click requires xPercent".to_owned())?,
                    y_percent.ok_or_else(|| "percent click requires yPercent".to_owned())?,
                )
            };
            perform_actions(
                shared,
                context,
                roles
                    .iter()
                    .map(|role_id| {
                        (
                            role_id.as_str(),
                            BrowserAction::Click {
                                anchor: anchor.clone(),
                                unit: if uses_pixels { "px" } else { "percent" }.to_owned(),
                                x,
                                y,
                                button: "left".to_owned(),
                            },
                        )
                    })
                    .collect(),
                false,
            )?;
            for role_id in roles {
                mark_click(shared, context, &definition.id, role_id, id);
            }
            wait_cancelable(context, context.settings.post_input_delay_ms)
        }
        MacroStepDefinition::Delay { ms, .. } => wait_cancelable(context, *ms),
        MacroStepDefinition::Macro {
            macro_id,
            call_mode,
            ..
        } if call_mode.as_deref() == Some("trigger") => {
            spawn_triggered_macro(shared, context, macro_id.clone(), ancestry.clone());
            Ok(())
        }
        MacroStepDefinition::Macro { macro_id, .. } => {
            execute_macro(shared, context, macro_id, &[], ancestry, false)
        }
    }
}

fn spawn_triggered_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: String,
    mut ancestry: Vec<String>,
) {
    let shared = Arc::clone(shared);
    let context = context.clone();
    let _ = thread::Builder::new()
        .name("rion-macro-trigger".to_owned())
        .spawn(move || {
            let _ = execute_macro(&shared, &context, &macro_id, &[], &mut ancestry, false);
        });
}

fn perform_action(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    role_id: &str,
    action: BrowserAction,
    allow_cancelled: bool,
) -> Result<(), String> {
    perform_actions(shared, context, vec![(role_id, action)], allow_cancelled)
}

fn perform_actions(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    actions: Vec<(&str, BrowserAction)>,
    allow_cancelled: bool,
) -> Result<(), String> {
    if !allow_cancelled {
        check_cancelled(context)?;
    }
    if actions.is_empty() {
        return Ok(());
    }
    let mut pending_actions = Vec::with_capacity(actions.len());
    let requests = {
        let mut pending = shared
            .pending
            .lock()
            .map_err(|_| "macro action result lock poisoned".to_owned())?;
        if pending.len().saturating_add(actions.len()) > MAX_PENDING_ACTIONS {
            return Err("macro browser action queue is full".to_owned());
        }
        actions
            .into_iter()
            .map(|(role_id, action)| {
                let request_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
                let request_id = format!("browser-action-{request_number}");
                let (sender, receiver) = mpsc::sync_channel(1);
                pending.insert(request_id.clone(), sender);
                pending_actions.push((request_id.clone(), receiver));
                BrowserActionRequest {
                    request_id,
                    role_id: role_id.to_owned(),
                    origin: "macro".to_owned(),
                    scheduled_at_ms: epoch_millis(),
                    deadline_ms: epoch_millis().saturating_add(ACTION_TIMEOUT.as_millis() as u64),
                    action,
                }
            })
            .collect::<Vec<_>>()
    };
    (shared.events)(vec![CoreEvent::BrowserActions { actions: requests }]);
    let started = std::time::Instant::now();
    let mut outcome = Ok(());
    for (_, receiver) in &pending_actions {
        loop {
            if !allow_cancelled && context.control.cancelled.load(Ordering::Acquire) {
                outcome = Err("macro run cancelled".to_owned());
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(result) if result.ok => break,
                Ok(result) => {
                    outcome = Err(result
                        .error_message
                        .unwrap_or_else(|| "browser action failed".to_owned()));
                    break;
                }
                Err(RecvTimeoutError::Timeout) if started.elapsed() < ACTION_TIMEOUT => {}
                Err(RecvTimeoutError::Timeout) => {
                    outcome = Err("macro browser action timed out".to_owned());
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    outcome = Err("macro browser action result channel closed".to_owned());
                    break;
                }
            }
        }
        if outcome.is_err() {
            break;
        }
    }
    if let Ok(mut pending) = shared.pending.lock() {
        for (request_id, _) in &pending_actions {
            pending.remove(request_id);
        }
    }
    outcome
}

fn release_held_keys(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    held_keys: &mut Vec<HeldKey>,
) {
    while let Some(held) = held_keys.pop() {
        let _ = perform_action(
            shared,
            context,
            &held.role_id,
            BrowserAction::Key {
                phase: "release".to_owned(),
                key: held.code.clone(),
                code: Some(held.code),
                modifiers: held.modifiers,
                owner_id: held.owner_id,
            },
            true,
        );
    }
}

fn wait_cancelable(context: &ExecutionContext, duration_ms: u32) -> Result<(), String> {
    check_cancelled(context)?;
    if duration_ms == 0 {
        thread::yield_now();
        return check_cancelled(context);
    }
    let guard = context
        .control
        .wake
        .0
        .lock()
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    let _ = context
        .control
        .wake
        .1
        .wait_timeout(guard, Duration::from_millis(u64::from(duration_ms)))
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    check_cancelled(context)
}

fn wait_until_cancelled(context: &ExecutionContext) -> Result<(), String> {
    while !context.control.cancelled.load(Ordering::Acquire) {
        let guard = context
            .control
            .wake
            .0
            .lock()
            .map_err(|_| "macro wait lock poisoned".to_owned())?;
        drop(
            context
                .control
                .wake
                .1
                .wait_timeout(guard, Duration::from_secs(1))
                .map_err(|_| "macro wait lock poisoned".to_owned())?,
        );
    }
    Err("macro run cancelled".to_owned())
}

fn check_cancelled(context: &ExecutionContext) -> Result<(), String> {
    if context.control.cancelled.load(Ordering::Acquire) {
        Err("macro run cancelled".to_owned())
    } else {
        Ok(())
    }
}

fn finish_invocation(
    shared: &Arc<Shared>,
    control: &Arc<InvocationControl>,
    result: Result<(), String>,
) {
    if let Ok(mut inner) = shared.inner.lock() {
        let cancelled = control.cancelled.load(Ordering::Acquire);
        let prefix = format!("{}|", control.id);
        if let Err(ref error) = result
            && !cancelled
        {
            let now = Utc::now().to_rfc3339();
            for (key, status) in &mut inner.statuses {
                if key.starts_with(&prefix) {
                    status.state = "failed".to_owned();
                    status.updated_at = now.clone();
                    status.error = Some(error.clone());
                }
            }
        } else if cancelled || result.is_ok() {
            inner.statuses.retain(|key, _| !key.starts_with(&prefix));
        }
        inner.invocations.remove(&control.id);
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    emit_statuses(shared);
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn add_running_statuses(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            inner.statuses.insert(
                status_key(&context.control.id, role_id, macro_id),
                MacroRunStatus {
                    role_id: role_id.clone(),
                    macro_id: macro_id.to_owned(),
                    state: "running".to_owned(),
                    iteration: Some(0),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now.clone(),
                    error: None,
                },
            );
        }
    }
    emit_statuses(shared);
}

fn update_iteration(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    iteration: u32,
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            if let Some(status) =
                inner
                    .statuses
                    .get_mut(&status_key(&context.control.id, role_id, macro_id))
            {
                status.iteration = Some(iteration);
                status.updated_at = now.clone();
            }
        }
    }
    emit_statuses(shared);
}

fn mark_click(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    role_id: &str,
    step_id: &str,
) {
    if let Ok(mut inner) = shared.inner.lock()
        && let Some(status) =
            inner
                .statuses
                .get_mut(&status_key(&context.control.id, role_id, macro_id))
    {
        status.last_click = Some(MacroLastClick {
            sequence: status
                .last_click
                .as_ref()
                .map_or(1, |click| click.sequence.saturating_add(1)),
            step_id: step_id.to_owned(),
        });
        status.updated_at = Utc::now().to_rfc3339();
    }
    emit_statuses(shared);
}

fn remove_macro_statuses(shared: &Arc<Shared>, invocation_id: &str, macro_id: &str) {
    if let Ok(mut inner) = shared.inner.lock() {
        let prefix = format!("{invocation_id}|");
        inner
            .statuses
            .retain(|key, status| !(key.starts_with(&prefix) && status.macro_id == macro_id));
    }
    emit_statuses(shared);
}

fn emit_statuses(shared: &Arc<Shared>) {
    let mut statuses = shared
        .inner
        .lock()
        .map(|inner| inner.statuses.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    statuses.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.role_id.cmp(&right.role_id))
    });
    (shared.events)(vec![CoreEvent::MacroStatuses { statuses }]);
}

fn cancel_control(control: &InvocationControl) {
    control.cancelled.store(true, Ordering::Release);
    control.wake.1.notify_all();
}

fn cancel_and_wait_all(controls: &[Arc<InvocationControl>]) {
    for control in controls {
        cancel_control(control);
    }
    for control in controls {
        wait_finished(control);
    }
}

fn wait_finished(control: &InvocationControl) {
    let Ok(finished) = control.finished.0.lock() else {
        return;
    };
    let _ = control
        .finished
        .1
        .wait_timeout_while(finished, Duration::from_secs(12), |finished| !*finished);
}

fn assigned_active_roles(
    definition: &MacroDefinition,
    active_role_ids: &HashSet<String>,
) -> Vec<String> {
    definition
        .role_ids
        .iter()
        .filter(|role_id| active_role_ids.contains(*role_id))
        .cloned()
        .collect()
}

fn validate_start_request(request: &MacroStartRequest) -> CoreResult<()> {
    if request.macro_id.trim().is_empty() || request.macros.is_empty() {
        return Err(CoreError::InvalidInput(
            "macro start request is invalid".to_owned(),
        ));
    }
    if request.macros.len() > 2_000 || request.active_role_ids.len() > 128 {
        return Err(CoreError::InvalidInput(
            "macro start request exceeds runtime limits".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for definition in &request.macros {
        if definition.id.trim().is_empty()
            || definition.name.trim().is_empty()
            || !ids.insert(definition.id.clone())
            || definition.steps.len() > 100
            || definition.role_ids.iter().any(|id| id.trim().is_empty())
        {
            return Err(CoreError::InvalidInput(
                "macro definition is invalid".to_owned(),
            ));
        }
    }
    validate_macro_dependencies(&request.macros)
}

fn validate_macro_dependencies(macros: &[MacroDefinition]) -> CoreResult<()> {
    let by_id = macros
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<HashMap<_, _>>();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a MacroDefinition>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> CoreResult<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(CoreError::InvalidInput(
                "macro dependency cycle detected".to_owned(),
            ));
        }
        let definition = by_id
            .get(id)
            .ok_or_else(|| CoreError::InvalidInput("macro dependency is missing".to_owned()))?;
        for dependency in definition.steps.iter().filter_map(|step| match step {
            MacroStepDefinition::Macro { macro_id, .. } => Some(macro_id.as_str()),
            _ => None,
        }) {
            if !by_id.contains_key(dependency) {
                return Err(CoreError::InvalidInput(
                    "macro dependency is missing".to_owned(),
                ));
            }
            visit(dependency, by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in by_id.keys().copied() {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_press_id(press_id: &str) -> CoreResult<()> {
    if press_id.trim().is_empty() || press_id.len() > 160 {
        Err(CoreError::InvalidInput(
            "macro shortcut press id is invalid".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn validate_result(result: &BrowserActionResult) -> CoreResult<()> {
    if result.request_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "browser action result requires requestId".to_owned(),
        ));
    }
    if result.ok && (result.error_code.is_some() || result.error_message.is_some()) {
        return Err(CoreError::InvalidInput(
            "successful browser action result cannot contain an error".to_owned(),
        ));
    }
    if !result.ok
        && (result.error_code.as_deref().is_none_or(str::is_empty)
            || result.error_message.as_deref().is_none_or(str::is_empty))
    {
        return Err(CoreError::InvalidInput(
            "failed browser action result requires an error code and message".to_owned(),
        ));
    }
    Ok(())
}

fn status_key(invocation_id: &str, role_id: &str, macro_id: &str) -> String {
    format!("{invocation_id}|{role_id}|{macro_id}")
}

fn lease_key(role_id: &str, macro_id: &str) -> String {
    format!("{role_id}|{macro_id}")
}

fn early_release_key(role_id: &str, macro_id: &str, press_id: &str) -> String {
    format!("{role_id}|{macro_id}|{press_id}")
}

fn trim_early_releases(releases: &mut HashMap<String, String>) {
    while releases.len() > 256 {
        let Some(key) = releases.keys().next().cloned() else {
            break;
        };
        releases.remove(&key);
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::model::{MacroRepeat, MacroStepDefinition};

    fn request(steps: Vec<MacroStepDefinition>) -> MacroStartRequest {
        MacroStartRequest {
            macros: vec![MacroDefinition {
                id: "m1".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Macro".to_owned(),
                role_ids: vec!["r1".to_owned()],
                trigger: None,
                repeat: MacroRepeat::Once,
                steps,
            }],
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 1,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "m1".to_owned(),
            role_id: None,
            active_role_ids: vec!["r1".to_owned()],
        }
    }

    #[test]
    fn emits_ordered_actions_and_consumes_results() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime
            .start(request(vec![MacroStepDefinition::Key {
                id: "s1".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: vec![],
                action: Some("tap".to_owned()),
            }]))
            .unwrap();
        let mut phases = Vec::new();
        while phases.len() < 3 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                        runtime
                            .dispatch_results(vec![BrowserActionResult {
                                request_id: action.request_id,
                                ok: true,
                                value_json: None,
                                error_code: None,
                                error_message: None,
                            }])
                            .unwrap();
                    }
                }
            }
        }
        assert_eq!(phases, ["focus", "hold", "release"]);
    }

    #[test]
    fn rejects_dependency_cycles_before_starting() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        let mut request = request(vec![MacroStepDefinition::Macro {
            id: "s1".to_owned(),
            macro_id: "m1".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        request.macros[0].steps = request.macros[0].steps.clone();
        assert!(runtime.start(request).is_err());
    }

    #[test]
    fn batches_cross_role_actions_and_preserves_each_role_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "s1".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: vec![],
            action: Some("tap".to_owned()),
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        runtime.start(request).unwrap();

        let mut action_batches = Vec::new();
        while action_batches.len() < 3 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    action_batches.push(
                        actions
                            .iter()
                            .map(|action| {
                                (
                                    action.role_id.clone(),
                                    match &action.action {
                                        BrowserAction::Focus => "focus".to_owned(),
                                        BrowserAction::Key { phase, .. } => phase.clone(),
                                        _ => "other".to_owned(),
                                    },
                                )
                            })
                            .collect::<Vec<_>>(),
                    );
                    runtime
                        .dispatch_results(
                            actions
                                .into_iter()
                                .map(|action| BrowserActionResult {
                                    request_id: action.request_id,
                                    ok: true,
                                    value_json: None,
                                    error_code: None,
                                    error_message: None,
                                })
                                .collect(),
                        )
                        .unwrap();
                }
            }
        }
        assert_eq!(
            action_batches.iter().map(Vec::len).collect::<Vec<_>>(),
            [2, 2, 2]
        );
        for role_id in ["r1", "r2"] {
            assert_eq!(
                action_batches
                    .iter()
                    .flat_map(|batch| batch.iter())
                    .filter(|(role, _)| role == role_id)
                    .map(|(_, phase)| phase.as_str())
                    .collect::<Vec<_>>(),
                ["focus", "hold", "release"]
            );
        }
    }

    #[test]
    fn cancellation_releases_owned_held_keys_before_finishing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime
            .start(request(vec![MacroStepDefinition::Key {
                id: "held".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: vec![],
                action: Some("hold_until_stop".to_owned()),
            }]))
            .unwrap();

        let mut phases = Vec::new();
        while phases.len() < 2 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        while phases.last().map(String::as_str) != Some("release") {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        if let BrowserAction::Key { phase, .. } = &action.action {
                            phases.push(phase.clone());
                        }
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        stop.join().unwrap();
        assert_eq!(phases, ["focus", "hold", "release"]);
        assert!(runtime.statuses().unwrap().is_empty());
    }

    fn success_results(actions: Vec<BrowserActionRequest>) -> Vec<BrowserActionResult> {
        actions
            .into_iter()
            .map(|action| BrowserActionResult {
                request_id: action.request_id,
                ok: true,
                value_json: None,
                error_code: None,
                error_message: None,
            })
            .collect()
    }
}
